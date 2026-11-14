import type {
  ApiGetOnboardingState200Response,
  AuthToken,
} from 'farcaster-client-data';
import { parseSiweMessage } from 'viem/siwe';

import {
  hostFromContext,
  type MiniAppHostAccount,
  rememberHost,
} from '~/lib/miniAppHost';
import {
  announceMiniAppReady,
  isInsideMiniAppHost,
  type MiniAppHostSdk,
  SIWF_FID_RESOURCE,
} from '~/lib/miniAppHostSdk';
import {
  buildLocalAuthToken,
  buildLocalOnboardingState,
  verifySiwfCompletion,
} from '~/lib/siwfSession';

/**
 * Signing in when fiddy.fun is running INSIDE a Farcaster client.
 *
 * WHY THIS EXISTS
 * fiddy.fun is a registered Mini App: `https://fiddy.fun/.well-known/farcaster.json`
 * answers 200 with an `accountAssociation` and a `miniapp` block whose
 * `homeUrl` is `https://fiddy.fun` — MEASURED 2026-10-21. So a person can open
 * Fiddy *inside* the Farcaster app, and there the host already knows exactly who
 * they are (its own `sdk.context.user` carries the fid, handle, display name and
 * avatar). Showing them a QR code to scan with the phone that is already running
 * the app is the same dead end `~/lib/siwfSession` was written to kill, one
 * surface over: the code cannot be scanned by the device displaying it.
 *
 * WHAT THIS DOES
 *   1. asks the host whether we are in a Mini App at all (`sdk.isInMiniApp()`);
 *   2. calls `sdk.actions.ready()` — a Mini App that never calls it leaves the
 *      host's own splash on screen forever, so this is not optional;
 *   3. asks the host to SIGN IN: `sdk.actions.signIn({ nonce })`, which the host
 *      answers with a SIWE message signed by the person's own wallet. The
 *      nonce is ours, generated here, so a signature harvested from another
 *      session cannot be replayed into this one;
 *   4. verifies that signature locally with exactly the checks the QR flow
 *      uses (`verifySiwfCompletion`: parses, domain, nonce, address recovery);
 *   5. and only then builds the same LOCAL session the QR flow builds — real
 *      fid, handle, name and avatar, no privileged token.
 *
 * HONEST LIMITS — read before "improving" this.
 *   - The fid is taken from the SIGNED message when the host names one
 *     (`farcaster://fid/<n>` in the message's resources, which is where
 *     `createSiwfMessage` in `farcaster-client-data` puts it, and which this
 *     client's own host implementation fills in for the apps it embeds). When
 *     the message names a fid that disagrees with the host context, the
 *     sign-in is refused. When it names none, the host context is used and
 *     `fidBoundToSignature` comes back false so callers can say so.
 *   - Neither path proves the signing address actually CONTROLS the fid: that
 *     binding lives on Optimism (KeyRegistry / ID registry) and checking it
 *     needs an RPC endpoint this client does not carry. This is the same gap
 *     the QR flow documents, and the session is local-only, so it grants no
 *     privileged access either way.
 *   - Nothing here is a substitute for a real server-side token exchange. See
 *     `~/lib/siwfSession`'s "HONEST LIMIT" section.
 *
 * Everything is dependency-injected (`sdk`, `now`) so the module stays
 * React-free and can be driven by a test with a fake host, and nothing in it
 * touches storage or the auth context — the caller does that.
 */

/** How long we wait for the host's own sign-in approval. */
const MINI_APP_SIGN_IN_TIMEOUT_MS = 120_000;

/** Raised when a host accepted a call and never answered it. */
class MiniAppTimeoutError extends Error {
  constructor() {
    super('The Mini App host did not answer');
    this.name = 'MiniAppTimeoutError';
  }
}

type MiniAppSignInOutcome =
  | { status: 'not-a-host' }
  /** The host answered, but would not or could not prove who this is. */
  | {
      status: 'refused';
      /** What went wrong, in a sentence a screen can print. */
      reason: string;
      /**
       * Whom the host named, when it named anyone before refusing.
       *
       * The host's word is UNVERIFIED, so this is not a session: it is only
       * enough to offer that account's public Following feed read-only
       * (`~/lib/miniAppHost`). Null when the host never said.
       */
      host: MiniAppHostAccount | null;
    }
  /** Our side broke — the SDK threw something the host did not name. */
  | { status: 'failed'; reason: string }
  | {
      status: 'signed-in';
      fid: number;
      username?: string;
      displayName?: string;
      pfpUrl?: string;
      authToken: AuthToken;
      onboardingState: ApiGetOnboardingState200Response;
      /** False when the signed message named no fid and we trusted the host. */
      fidBoundToSignature: boolean;
      /** True when the host accepted `sdk.actions.ready()`. */
      readyAnnounced: boolean;
    };

/** A nonce only this page knows: 32 random bytes, hex. */
const createMiniAppNonce = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * The fid a SIWF message names, if it names one.
 *
 * The host signs a message it builds from its own context, and the fid travels
 * in the message's `resources` (`farcaster://fid/<n>`) — so this is a fid the
 * person's signature covers, not a number we were told.
 */
const fidFromSignedMessage = (message: string): number | undefined => {
  try {
    const parsed = parseSiweMessage(message);

    for (const resource of parsed.resources ?? []) {
      const match = SIWF_FID_RESOURCE.exec(resource);

      if (match) {
        return Number(match[1]);
      }
    }
  } catch (error) {
    return undefined;
  }

  return undefined;
};

/**
 * The whole host sign-in, in one call.
 *
 * Refusals are outcomes, not exceptions: "the person said no", "the host would
 * not name an account" and "the signature did not hold up" all come back as
 * `refused` with a reason a screen can print, because every one of them ends
 * with the ordinary web sign-in still available.
 */
const signInInsideMiniApp = async ({
  sdk,
  domain,
  now = Date.now(),
  timeoutMs = MINI_APP_SIGN_IN_TIMEOUT_MS,
}: {
  sdk: MiniAppHostSdk;
  domain: string;
  now?: number;
  timeoutMs?: number;
}): Promise<MiniAppSignInOutcome> => {
  if (!(await isInsideMiniAppHost({ sdk }))) {
    return { status: 'not-a-host' };
  }

  // The host hides its splash on this, and a Mini App that never calls it looks
  // broken from the inside. A refusal here is recorded, not fatal: the sign-in
  // below is the thing that has to hold up.
  const readyAnnounced = await announceMiniAppReady({ sdk });

  let context: unknown;

  try {
    context = await sdk.context;
  } catch (error) {
    return {
      status: 'refused',
      reason: 'the host did not say who you are',
      host: null,
    };
  }

  // Whom the host named, kept from the promise already awaited above rather
  // than asked for again: a refusal is the one outcome that has to leave the
  // person something to do, and "read as @you" only takes a name. Unverified,
  // so it buys public reads and nothing else (`~/lib/miniAppHost`).
  const host = hostFromContext(context);

  if (host) {
    rememberHost(host);
  }

  const contextFid = host?.fid;

  if (!host || !contextFid) {
    return {
      status: 'refused',
      reason: 'the host did not say who you are',
      host: null,
    };
  }

  const nonce = createMiniAppNonce();

  let proof: { message: string; signature: `0x${string}` };

  // The host's own approval UI is where the person is, and it can be left
  // open forever — so this call is bounded. A host that never answers is a
  // refusal here, not an overlay that stays up for the rest of the session.
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    proof = await Promise.race([
      sdk.actions.signIn({ nonce }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MiniAppTimeoutError()), timeoutMs);
      }),
    ]);
  } catch (error) {
    // The SDK throws `SignIn.RejectedByUser` when the person declines; anything
    // else is the host failing us. Both leave the session untouched.
    if (error instanceof MiniAppTimeoutError) {
      return {
        status: 'refused',
        reason: 'the host did not answer the sign-in request in time',
        host,
      };
    }

    return {
      status: 'refused',
      reason:
        'that sign-in was not approved in Farcaster, so nothing was signed in',
      host,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  if (!proof?.message || !proof?.signature) {
    return {
      status: 'refused',
      reason: 'the host approved nothing it could prove',
      host,
    };
  }

  // The same three checks the QR flow runs: it parses, it names THIS host and
  // the nonce we just generated, and the signature recovers to the address the
  // message claims. A message signed for another domain or another nonce is
  // refused rather than accepted as "close enough".
  const verification = await verifySiwfCompletion({
    message: proof.message,
    signature: proof.signature,
    nonce,
    domain,
  });

  if (!verification.verified) {
    return {
      status: 'refused',
      reason: verification.reason ?? 'the signature did not hold up',
      host,
    };
  }

  const signedFid = fidFromSignedMessage(proof.message);

  if (signedFid !== undefined && signedFid !== contextFid) {
    return {
      status: 'refused',
      reason: `the signature names fid ${signedFid} but the host says fid ${contextFid}`,
      host,
    };
  }

  const fid = signedFid ?? contextFid;
  const onboardingState = buildLocalOnboardingState({
    fid,
    username: host.username,
    displayName: host.displayName,
    pfpUrl: host.pfpUrl,
  });

  return {
    status: 'signed-in',
    fid,
    username: host.username,
    displayName: host.displayName,
    pfpUrl: host.pfpUrl,
    authToken: buildLocalAuthToken({ fid, now }),
    onboardingState,
    fidBoundToSignature: signedFid !== undefined,
    readyAnnounced,
  };
};

/**
 * The SDK seam moved to `~/lib/miniAppHostSdk` so the identity read can use it
 * without importing the sign-in path. Re-exported here because this module is
 * where every existing caller looks for it.
 */
export {
  announceMiniAppReady,
  isInsideMiniAppHost,
  loadMiniAppHostSdk,
  MINI_APP_HOST_TIMEOUT_MS,
} from '~/lib/miniAppHostSdk';

export {
  createMiniAppNonce,
  fidFromSignedMessage,
  MINI_APP_SIGN_IN_TIMEOUT_MS,
  signInInsideMiniApp,
};

export type { MiniAppHostSdk, MiniAppSignInOutcome };
