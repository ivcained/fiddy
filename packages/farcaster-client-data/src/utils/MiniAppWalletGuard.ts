// What a mini app may ask of the person's wallet and Farcaster account.
//
// Fiddy hosts third-party mini apps inside the same wallet RPC bridge the
// person uses for their own account. A malicious or compromised mini app
// could otherwise ask the wallet for a Farcaster account signature — a sign-in
// that hands over the account, a custody/onboarding typed-data that mints a
// NEW account, or a transaction that touches Farcaster's own contracts. Those
// requests must never reach the wallet.
//
// Logic ported from backmeupplz/quilcast (MIT) src/guard.ts (commit
// 5efc1efd5c5f, "0.107.1 mini app guard and host security fixes") and adapted
// to Fiddy's provider chain and voice. The contract addresses and site
// blocklist below are taken verbatim from that project. Keep this module
// framework-free and dependency-light so it adds no weight to the mobile
// bundle.

/** Farcaster's contracts on Optimism: key adds, registrations, transfers, recovery. */
const FARCASTER_CONTRACTS = new Set([
  '0x00000000fc6c5f01fc30151999387bb99a9f489b', // IdRegistry
  '0x00000000fc25870c6ed6b6c7e41fb078b7656f69', // IdGateway
  '0x00000000fc1237824fb747abde0ff18990e59b7e', // KeyRegistry
  '0x00000000fc56947c7e7183f8ca4b62398caadf0b', // KeyGateway
  '0x00000000fcce7f938e7ae6d3c335bd6a1a7c593d', // StorageRegistry
  '0x00000000fc04c910a0b5fea33b03e0447ad0b0aa', // Bundler
  '0x00000000fc700472606ed4fa22623acf62c60553', // SignedKeyRequestValidator
  '0x00000000fcb080a4d6c39a9354da9eb9bc104cd7', // RecoveryProxy
]);

/** Signing in to these with the person's wallet could hand over their Farcaster account. */
const FARCASTER_SITES = /(^|\.)(farcaster\.xyz|warpcast\.com)$/i;

/** A JSON-RPC error with the code a wallet app (EIP-1193) expects. */
export const rpcError = (code: number, message: string) =>
  Object.assign(new Error(message), { code });

/** Decode a hex-encoded signing message to text; pass through anything else. */
const text = (m: unknown) => {
  const s = String(m ?? '');
  if (!/^0x([0-9a-f]{2})*$/i.test(s)) {
    return s;
  }
  let out = '';
  for (let i = 2; i < s.length; i += 2) {
    out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16));
  }
  return out;
};

/**
 * For a message about to be signed (Ethereum or Solana). Throws for Farcaster
 * logins, which only Fiddy's own sign-in prompts may sign. Returns the site a
 * Sign-In message is for when that isn't the mini app's own host, so the
 * person can be asked: one app could otherwise sign you in somewhere else as
 * you.
 */
export function signInCheck(host: string, m: string): string | undefined {
  if (
    /farcaster:\/\/fid\/|Direct cast authorization|"method"\s*:\s*"generateToken"/i.test(
      m,
    )
  ) {
    throw rpcError(
      4100,
      "Mini apps can't ask for Farcaster account signatures. Your account stays with Fiddy.",
    );
  }
  const site = m.match(
    /^(?:https?:\/\/)?(\S+) wants you to sign in with your (?:Ethereum|Solana) account:/,
  )?.[1];
  if (!site || site === host) {
    return;
  }
  if (FARCASTER_SITES.test(site.replace(/:\d+$/, ''))) {
    throw rpcError(
      4100,
      `Mini apps can't sign you in to ${site}. Your account stays with Fiddy.`,
    );
  }
  return site;
}

/**
 * Throws (code 4100) if a wallet request from the app at `host` must not reach
 * the wallet of `me`. Returns a site to confirm with the person (see
 * signInCheck).
 */
export function checkWallet(
  host: string,
  me: string,
  method: string,
  params: unknown[],
): string | undefined {
  const no = (why: string): never => {
    throw rpcError(4100, why);
  };
  const mine = (a: unknown) =>
    String(a).toLowerCase() === me ||
    no("That address isn't the one connected to this mini app.");
  const to = (x: unknown) =>
    FARCASTER_CONTRACTS.has(String(x).toLowerCase()) &&
    no("Mini apps can't send transactions to Farcaster's account contracts.");
  if (method === 'personal_sign') {
    mine(params[1]);
    return signInCheck(host, text(params[0]));
  } else if (method === 'eth_signTypedData_v4') {
    mine(params[0]);
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed =
        typeof params[1] === 'string'
          ? JSON.parse(params[1])
          : (params[1] as Record<string, unknown>);
    } catch {}
    if (!parsed || typeof parsed !== 'object') {
      no("The wallet can't read that request.");
    }
    const t = parsed as Record<string, unknown>;
    const domain = (t.domain as Record<string, unknown> | undefined) ?? {};
    if (
      /farcaster|hypersnap/i.test(String(domain.name)) ||
      FARCASTER_CONTRACTS.has(String(domain.verifyingContract).toLowerCase())
    ) {
      no(
        "Mini apps can't ask for Farcaster account signatures. Your account stays with Fiddy.",
      );
    }
  } else if (method === 'eth_sendTransaction') {
    const rawTx = params[0];
    if (!rawTx || typeof rawTx !== 'object') {
      no('Missing transaction.');
    }
    const tx = rawTx as Record<string, unknown>;
    if (tx.from !== undefined) {
      mine(tx.from);
    }
    to(tx.to);
  } else if (method === 'wallet_sendCalls') {
    const rawP = params[0];
    if (
      !rawP ||
      typeof rawP !== 'object' ||
      !Array.isArray((rawP as Record<string, unknown>).calls)
    ) {
      no('Missing calls.');
    }
    const p = rawP as Record<string, unknown>;
    if (p.from !== undefined) {
      mine(p.from);
    }
    for (const c of (p.calls as unknown[]) ?? []) {
      to((c as Record<string, unknown>)?.to);
    }
  }
  return undefined;
}
