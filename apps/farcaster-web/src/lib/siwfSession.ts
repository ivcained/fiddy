import {
  ApiGetOnboardingState200Response,
  AuthToken,
} from 'farcaster-client-data';
import { isAddressEqual, recoverMessageAddress } from 'viem';
import { parseSiweMessage } from 'viem/siwe';

/**
 * Sign In With Farcaster (SIWF) — the login that actually completes.
 *
 * WHY THIS EXISTS
 * The fork's original QR was a Warpcast "sync channel" device link: the code
 * displayed `https://farcaster.xyz/login-web?channel-id=<uuid>`, the phone posted
 * an encrypted auth token to `/v2/sync-channel`, and the web client polled it out.
 * Farcaster has since removed that flow. Measured on 2026-10-19:
 *
 *   - `POST https://farcaster.xyz/~api/v2/sync-channel` → 200 {"success":true}
 *   - `GET  https://farcaster.xyz/~api/v2/sync-channel` → 200 {"messages":[]}, forever
 *   - `https://farcaster.xyz/login-web?channel-id=…` now redirects to
 *     `/~/mobile?…&path=login-web` and renders only "Copy link" — no handshake.
 *   - The live front door is "Log in with email / Log in with phone" (Neynar-run).
 *
 * So the channel was healthy and simply never received anything: the phone app no
 * longer knows how to answer that link. The QR was a dead end, which is exactly
 * what the user saw.
 *
 * WHAT THIS DOES INSTEAD
 * Talks to the SIWF relay directly. Four fetch calls and viem's own SIWE parsing —
 * deliberately, rather than adding `@farcaster/auth-client`, which would mean a
 * monorepo-wide lockfile change for the same handful of requests. The wire format
 * below was read off `@farcaster/auth-client@0.7.1`'s own types.
 *
 * HONEST LIMIT — read this before "improving" the session below.
 * SIWF proves *who signed a message*. It does not mint a farcaster.xyz API token.
 * `useAuth().signIn()` wants precisely such a token (an `AuthToken` that `/v2/me`
 * can validate), and minting one is a server-side exchange this client has no
 * backend for. So a completed SIWF handshake produces a LOCAL-ONLY session: the
 * app enters a real signed-in state carrying the user's real FID, handle and
 * avatar, and makes no privileged Farcaster API call with it. `isLocalSessionToken`
 * is the marker that stops AuthProvider from probing `/v2/me` on cold start and
 * booting the user straight back out of the session they just completed.
 *
 * Replacing this with a real session means adding a backend that exchanges a
 * verified SIWE signature for an API token. That is a product decision, not a bug
 * fix, and it is deliberately not made here.
 */

const SIWF_RELAY_URL = 'https://relay.farcaster.xyz';

/** How long the QR stays live before we show an error and offer a retry. */
const SIWF_CHANNEL_TIMEOUT_MS = 120_000;

/** Relay poll cadence. The relay rate-limits, so don't go below a second. */
const SIWF_POLL_INTERVAL_MS = 1_500;

/**
 * Marks an AuthToken as a local SIWF session rather than a farcaster.xyz token.
 * AuthProvider keys its "don't validate this one against the server" branch off
 * this prefix, so it must stay a prefix of the `secret` field.
 */
const LOCAL_SESSION_SECRET_PREFIX = 'siwf-local:';

/** Local sessions are a dev/v1 affordance; they expire rather than pretend. */
const LOCAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type SiwfRelayChannel = {
  channelToken: string;
  url: string;
  nonce: string;
};

type SiwfRelayStatusPending = {
  state: 'pending';
  nonce: string;
  signatureParams: { siweUri: string; domain: string; nonce?: string };
};

type SiwfRelayStatusCompleted = {
  state: 'completed';
  nonce: string;
  message: string;
  signature: `0x${string}`;
  fid: number;
  username?: string;
  displayName?: string;
  bio?: string;
  pfpUrl?: string;
  custody?: `0x${string}`;
  authMethod?: 'custody' | 'authAddress';
  verifications?: string[];
};

type SiwfRelayStatus = SiwfRelayStatusPending | SiwfRelayStatusCompleted;

/** Raised when the QR was never scanned/approved inside the timeout. */
class SiwfTimeoutError extends Error {
  constructor() {
    super('Nobody approved the request in time');
    this.name = 'SiwfTimeoutError';
  }
}

/** Raised when the relay itself is unreachable or answers with an error. */
class SiwfRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiwfRelayError';
  }
}

type SiwfVerified = {
  /** True when the signature provably belongs to the address in the SIWE message. */
  verified: boolean;
  address?: `0x${string}`;
  /** Populated when `verified` is false, for logs and the honest UI copy. */
  reason?: string;
};

type SiwfCompletion = SiwfRelayStatusCompleted & {
  verification: SiwfVerified;
};

const createSiwfChannel = async ({
  siweUri,
  domain,
}: {
  siweUri: string;
  domain: string;
}): Promise<SiwfRelayChannel> => {
  let response: Response;

  try {
    response = await fetch(`${SIWF_RELAY_URL}/v1/channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siweUri, domain }),
    });
  } catch (error) {
    throw new SiwfRelayError(`Farcaster's sign-in service is unreachable`);
  }

  if (!response.ok) {
    throw new SiwfRelayError(
      `Farcaster's sign-in service refused the request (${response.status})`,
    );
  }

  const body = (await response.json()) as SiwfRelayChannel;

  if (!body?.channelToken || !body?.url) {
    throw new SiwfRelayError(
      `Farcaster's sign-in service sent back no request`,
    );
  }

  return body;
};

/**
 * One poll of the relay channel. `Authorization: Bearer <channelToken>` is
 * required — without it the relay answers 401 and the poll would look like a
 * network problem forever.
 */
const getSiwfChannelStatus = async ({
  channelToken,
}: {
  channelToken: string;
}): Promise<SiwfRelayStatus | undefined> => {
  let response: Response;

  try {
    response = await fetch(
      `${SIWF_RELAY_URL}/v1/channel/status?channelToken=${encodeURIComponent(channelToken)}`,
      { headers: { authorization: `Bearer ${channelToken}` } },
    );
  } catch (error) {
    // Offline or blocked: not fatal, the next poll may succeed.
    return undefined;
  }

  // 202 is the documented "still waiting" status.
  if (response.status === 202 || response.ok) {
    return (await response.json()) as SiwfRelayStatus;
  }

  if (response.status === 404 || response.status === 401) {
    throw new SiwfRelayError(
      `Farcaster's sign-in service no longer recognises this request (${response.status})`,
    );
  }

  return undefined;
};

/**
 * Polls until the user approves in the Farcaster app, or the timeout fires.
 * Throws `SiwfTimeoutError` on timeout so the caller can offer a retry rather
 * than leaving a modal that will never resolve.
 */
const watchSiwfChannel = async ({
  channelToken,
  timeoutMs = SIWF_CHANNEL_TIMEOUT_MS,
  pollIntervalMs = SIWF_POLL_INTERVAL_MS,
  isCancelled,
}: {
  channelToken: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isCancelled?: () => boolean;
}): Promise<SiwfRelayStatusCompleted> => {
  const startedAt = Date.now();

  for (;;) {
    if (isCancelled?.()) {
      throw new SiwfTimeoutError();
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new SiwfTimeoutError();
    }

    const status = await getSiwfChannelStatus({ channelToken });

    if (status?.state === 'completed') {
      return status;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
};

/**
 * Verifies a completed handshake locally.
 *
 * Three checks, in order, cheapest and most conclusive first:
 *   1. the SIWE message parses at all;
 *   2. its `nonce` and `domain` are the ones we asked for — this is what stops a
 *      signature harvested from another app or another session being replayed here;
 *   3. the signature recovers to the address the message claims (pure ECDSA, no RPC).
 *
 * What this does NOT prove: that the signing address actually controls the FID the
 * relay reports. That binding lives on Optimism (KeyRegistry / ID registry) and
 * checking it needs an RPC endpoint and a paymaster-grade dependency this client
 * doesn't carry. Since the session is local-only and grants no privileged access,
 * that gap is recorded rather than hidden — `reason` says so, and the UI never
 * claims more than "signed in on this device".
 */
const verifySiwfCompletion = async ({
  message,
  signature,
  nonce,
  domain,
}: {
  message: string;
  signature: `0x${string}`;
  nonce: string;
  domain: string;
}): Promise<SiwfVerified> => {
  let parsed: ReturnType<typeof parseSiweMessage>;

  try {
    parsed = parseSiweMessage(message);
  } catch (error) {
    return { verified: false, reason: 'the sign-in message did not parse' };
  }

  if (parsed.domain !== domain) {
    return {
      verified: false,
      reason: `the message was signed for ${parsed.domain}, not ${domain}`,
    };
  }

  if (parsed.nonce !== nonce) {
    return { verified: false, reason: 'the message carried the wrong nonce' };
  }

  if (!parsed.address) {
    return { verified: false, reason: 'the message carried no address' };
  }

  let recovered: `0x${string}`;

  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch (error) {
    return { verified: false, reason: 'the signature could not be recovered' };
  }

  if (!isAddressEqual(recovered, parsed.address)) {
    return {
      verified: false,
      reason: 'the signature does not match the address it claims',
    };
  }

  return { verified: true, address: recovered };
};

/**
 * True when a token is a local SIWF session rather than an API token. Takes the
 * bare `{ secret }` shape so callers holding only a secret string (AuthProvider
 * has one in a few places) don't have to fabricate an AuthToken to ask.
 */
const isLocalSessionToken = (
  authToken: { secret?: string } | undefined,
): boolean =>
  typeof authToken?.secret === 'string' &&
  authToken.secret.startsWith(LOCAL_SESSION_SECRET_PREFIX);

/**
 * The AuthToken shape the app stores, carrying a marker that says "local".
 * `expiresAt` is a real expiry: a local session should age out like any other.
 */
const buildLocalAuthToken = ({
  fid,
  now = Date.now(),
}: {
  fid: number;
  now?: number;
}): AuthToken => ({
  secret: `${LOCAL_SESSION_SECRET_PREFIX}${fid}:${now.toString(36)}`,
  expiresAt: now + LOCAL_SESSION_TTL_MS,
});

/**
 * Builds the onboarding-state object the app's signed-in gate reads
 * (`useIsSignedIn` → `state.user && state.hasCompletedRegistration`), filled in
 * from what SIWF actually returned.
 *
 * This is a local synthesis, not a server payload — the counts are honestly zero
 * because we did not fetch them, and the /v2/me-derived fields are false because
 * we did not ask the server. Every field the UI reads as "yours" (fid, handle,
 * display name, avatar) is real, straight from the signed handshake.
 */
const buildLocalOnboardingState = ({
  fid,
  username,
  displayName,
  bio,
  pfpUrl,
}: {
  fid: number;
  username?: string;
  displayName?: string;
  bio?: string;
  pfpUrl?: string;
}): ApiGetOnboardingState200Response => ({
  result: {
    state: {
      id: `siwf-local-${fid}`,
      user: {
        fid,
        username,
        displayName: displayName ?? username ?? `fid ${fid}`,
        pfp: pfpUrl ? { url: pfpUrl, verified: false } : undefined,
        profile: { bio: { text: bio ?? '', mentions: [] } },
        followerCount: 0,
        followingCount: 0,
      },
      hasOnboarding: true,
      hasConfirmedEmail: false,
      needsRegistrationPayment: false,
      hasFid: true,
      hasFname: Boolean(username),
      hasDelegatedSigner: false,
      hasSetupProfile: Boolean(username),
      hasCompletedRegistration: true,
      hasStorage: false,
      hasWarpcastWalletAddress: false,
      hasWarpcastSolanaWalletAddress: false,
      geoRestricted: false,
    },
  },
});

/** Where a sign-in leaves its proof for the one thing that needs it after. */
const SIWF_PROOF_KEY = 'fiddy.siwf.proof';

/** Long enough to finish signing in, short enough that a stale proof ages out. */
export const SIWF_PROOF_TTL_MS = 30 * 60 * 1000;

export interface SiwfProof {
  fid: number;
  message: string;
  signature: string;
  at: number;
}

/**
 * The proof a sign-in leaves behind.
 *
 * A completed SIWF handshake produces a SIWE message and a signature from the
 * owner's own Farcaster client. That pair is evidence of who signed in — and it
 * is replayable by anyone who reads it, so it is kept the way it deserves:
 * `sessionStorage` only (gone when the tab closes), a thirty-minute life, and
 * consumed once. The one consumer is `~/lib/fiddyAgentAutopair`, which forwards
 * it to the agent service exactly once and then deletes it.
 *
 * It is kept for a real reason rather than convenience: the service that runs
 * your agent proves ownership by verifying precisely this signature against
 * Farcaster's own contracts, so asking the owner to sign again — or to paste a
 * session token — would be asking them to redo work they have already done.
 * Nothing else in the app reads it, and it grants nothing on its own.
 */
export const saveSiwfProof = (
  {
    fid,
    message,
    signature,
  }: { fid: number; message: string; signature: string },
  now = Date.now(),
): void => {
  if (!Number.isSafeInteger(fid) || fid <= 0 || !message) {
    return;
  }
  if (!/^0x[\da-fA-F]{130}$/.test(signature)) {
    return;
  }
  try {
    window.sessionStorage.setItem(
      SIWF_PROOF_KEY,
      JSON.stringify({ fid, message, signature, at: now }),
    );
  } catch {
    // A browser that refuses storage simply signs in again — never a broken login.
  }
};

/** Read the proof back. Never throws; a half-written or stale entry is `null`. */
export const loadSiwfProof = (now = Date.now()): SiwfProof | null => {
  try {
    const raw = window.sessionStorage.getItem(SIWF_PROOF_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SiwfProof> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const fid = Number(parsed.fid);
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    const signature =
      typeof parsed.signature === 'string' ? parsed.signature : '';
    const at = typeof parsed.at === 'number' ? parsed.at : 0;
    if (!Number.isSafeInteger(fid) || fid <= 0 || !message || !at) {
      return null;
    }
    if (!/^0x[\da-fA-F]{130}$/.test(signature)) {
      return null;
    }
    if (now - at > SIWF_PROOF_TTL_MS || now < at - 60_000) {
      return null;
    }
    return { fid, message, signature, at };
  } catch {
    return null;
  }
};

/** Delete the proof. Called the moment it has been spent. */
export const clearSiwfProof = (): void => {
  try {
    window.sessionStorage.removeItem(SIWF_PROOF_KEY);
  } catch {
    // nothing to clean up
  }
};

export {
  buildLocalAuthToken,
  buildLocalOnboardingState,
  createSiwfChannel,
  getSiwfChannelStatus,
  isLocalSessionToken,
  LOCAL_SESSION_SECRET_PREFIX,
  SIWF_CHANNEL_TIMEOUT_MS,
  SIWF_POLL_INTERVAL_MS,
  SIWF_RELAY_URL,
  SiwfRelayError,
  SiwfTimeoutError,
  verifySiwfCompletion,
  watchSiwfChannel,
};
export type {
  SiwfCompletion,
  SiwfProof,
  SiwfRelayChannel,
  SiwfRelayStatus,
  SiwfRelayStatusCompleted,
  SiwfVerified,
};
