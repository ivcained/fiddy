import type { Context } from '@farcaster/miniapp-core';

/**
 * The one place this client talks to a Farcaster client's own SDK.
 *
 * WHY THIS IS ITS OWN MODULE
 * Two callers need it and they must not disagree about what a host is: the
 * sign-in path (`~/lib/miniAppSession`) and the identity read that decides
 * whether to offer "Continue as @you" (`~/lib/miniAppHost`). Before this file
 * the loader lived inside the sign-in module, so an identity read would have
 * had to import the whole sign-in path — or copy the guard, which is how two
 * answers to "is this a host?" start drifting apart.
 *
 * THE SDK IS STILL LAZY. It is imported inside a function, never at module
 * load, because an ordinary web visitor pays for a bundle they cannot use.
 * `@farcaster/miniapp-sdk` must stay a dynamic import here; the build is checked
 * for it on every release (`scripts/check-miniapp-sdk-is-lazy.mjs`, run from
 * `scripts/release-client.sh`), because a single eager import of it reads like
 * every other line in a diff.
 */

/** How long we let a host answer "are you there?" before giving up. */
export const MINI_APP_HOST_TIMEOUT_MS = 1_000;

/** The `farcaster://fid/<n>` resource a SIWF message carries. */
export const SIWF_FID_RESOURCE = /^farcaster:\/\/fid\/(\d+)$/;

/** The slice of `@farcaster/miniapp-sdk` this client drives. */
export type MiniAppHostSdk = {
  isInMiniApp: (timeoutMs?: number) => Promise<boolean>;
  context: Promise<Context.MiniAppContext>;
  actions: {
    ready: () => Promise<void>;
    signIn: (options: {
      nonce: string;
    }) => Promise<{ message: string; signature: `0x${string}` }>;
    openUrl?: (url: string) => Promise<void>;
  };
  back?: {
    enableWebNavigation: () => Promise<void>;
  };
};

/**
 * The SDK, loaded on demand.
 *
 * A missing or broken SDK is `undefined`, not a crash — the client's own
 * sign-in must keep working whatever the host does.
 */
export const loadMiniAppHostSdk = async (): Promise<
  MiniAppHostSdk | undefined
> => {
  try {
    const sdk = (await import('@farcaster/miniapp-sdk')).default;

    if (!sdk?.isInMiniApp || !sdk.actions) {
      return undefined;
    }

    return sdk as unknown as MiniAppHostSdk;
  } catch (error) {
    return undefined;
  }
};

/**
 * Are we inside a Farcaster client?
 *
 * The SDK answers this itself: no RN webview and `window === window.parent`
 * short-circuits to false, and otherwise it waits for the host to hand over its
 * context within the timeout. A plain page embedded in a random iframe gets
 * `false`, which is what keeps this from firing on a marketing page.
 */
export const isInsideMiniAppHost = async ({
  sdk,
  timeoutMs = MINI_APP_HOST_TIMEOUT_MS,
}: {
  sdk: MiniAppHostSdk;
  timeoutMs?: number;
}): Promise<boolean> => {
  try {
    const inside = await sdk.isInMiniApp(timeoutMs);
    if (inside) {
      // Host-only code stays out of the ordinary browser's bundle. A refused
      // back-button setup is recorded by the helper, never fatal to the app.
      const { enableMiniAppHostNavigation } =
        await import('~/lib/miniAppHostNavigation');
      await enableMiniAppHostNavigation({ sdk });
    }
    return inside;
  } catch (error) {
    return false;
  }
};

/**
 * Tell the host we have something to show.
 *
 * A person who is ALREADY signed in still needs this: a Mini App that never
 * calls `ready()` keeps the host's loading splash up over a working client.
 * Returns whether the host took it — callers record the answer instead of
 * assuming it.
 */
export const announceMiniAppReady = async ({
  sdk,
}: {
  sdk: MiniAppHostSdk;
}): Promise<boolean> => {
  try {
    await sdk.actions.ready();
    return true;
  } catch (error) {
    return false;
  }
};
