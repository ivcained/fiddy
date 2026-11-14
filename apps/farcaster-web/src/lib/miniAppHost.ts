import { useEffect, useState } from 'react';

import {
  isInsideMiniAppHost,
  loadMiniAppHostSdk,
  MINI_APP_HOST_TIMEOUT_MS,
  type MiniAppHostSdk,
} from '~/lib/miniAppHostSdk';

/**
 * Who the Farcaster client we are running inside says is using Fiddy.
 *
 * WHY THIS EXISTS
 * Fiddy's mini app happy path (`~/lib/miniAppSession`) signs in from the host's
 * own context. When the HOST REFUSES — the person declines, the approval sheet
 * is dismissed, the tab already tried once — the person is left on the
 * signed-out wall, which asks them for a QR code they cannot scan with the
 * phone that is already showing it. That is the wrong middle state: the host
 * has just told us their name, so Fiddy can show that account's Following feed
 * read from public data, sign nothing and create nothing.
 *
 * WHAT THE HOST'S WORD IS WORTH
 * Nothing that could act as them. It is unverified: a host is a third party and
 * `fid` arrives over a postMessage bridge. So it may only drive PUBLIC READS —
 * a Following feed, a name on a card — and never a session, a write, a scope or
 * a key. `fidOfContext` is deliberately strict for that reason.
 *
 * BORROWED FROM QUILCAST (MIT), reimplemented for this stack: the middle state
 * ("Continue as @you, read-only") is backmeupplz/quilcast #660, whose `src/host.ts`
 * has the same four ideas — a strict fid, an offer that never re-offers a
 * signed-in account, one in-flight lookup that forgets a failure, and a hook.
 * Their sign-in is a recovery phrase, so `offered` also decides WHICH door is
 * first there; here the first move is always the host sign-in
 * (`MiniAppAutoSignIn`), and this module is what the refusal path lands on.
 */

/** What a host's context tells us, and everything it is allowed to tell us. */
export interface MiniAppHostAccount {
  fid: number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
}

/** The account a Mini App context names, or null when it names none. */
export const fidOfContext = (context: unknown): number | null => {
  const fid = (context as { user?: { fid?: unknown } } | null | undefined)?.user
    ?.fid;

  // Only a positive safe integer counts: 0, -1, 1.5, '3', NaN and 2**53 are a
  // host that is confused or a value that cannot be a FID, never "fid 0".
  return typeof fid === 'number' && Number.isSafeInteger(fid) && fid > 0
    ? fid
    : null;
};

/** A trimmed non-empty string, or undefined — never `''` dressed up as a name. */
const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

/**
 * The account a context names, with whatever else it chose to tell us.
 *
 * Every field but the fid is optional on purpose: a host may name an account
 * and say nothing else, and a card without an avatar is still honest.
 */
export const hostFromContext = (
  context: unknown,
): MiniAppHostAccount | null => {
  const fid = fidOfContext(context);

  if (fid === null) {
    return null;
  }

  const user = (
    context as {
      user?: { username?: unknown; displayName?: unknown; pfpUrl?: unknown };
    }
  ).user;

  return {
    fid,
    ...(textOf(user?.username) ? { username: textOf(user?.username) } : {}),
    ...(textOf(user?.displayName)
      ? { displayName: textOf(user?.displayName) }
      : {}),
    ...(textOf(user?.pfpUrl) ? { pfpUrl: textOf(user?.pfpUrl) } : {}),
  };
};

/**
 * What to call them on a card: `@<username>`, else their display name, else
 * their number — the handle first because that is how Farcaster reads, and the
 * number is a last resort rather than an invented name.
 */
export const hostAt = (host: MiniAppHostAccount): string =>
  host.username ? `@${host.username}` : (host.displayName ?? `fid ${host.fid}`);

/**
 * Where "Continue as @you" goes: that account's Following feed, read-only.
 *
 * The path is spelled here rather than imported from `~/constants/routes`
 * because that table pulls the whole lazy page graph, and this module is
 * imported by a page (`PublicBrowsePage`) that the graph itself contains — a
 * cycle for the sake of one string. `scripts/verify-continue-as.mjs` walks the
 * real navigation from both places that offer it, which is what keeps this
 * honest; `routes.publicFeed` is the address.
 */
export const continueAsHref = (fid: number): string => `/feed?as=${fid}`;

/** A tab-session fact: an account we have already been told about. */
const HOST_KEY = 'fiddy.miniapp.host';

/**
 * A tab-session fact: the one-shot guard on the automatic host sign-in.
 *
 * Lives here rather than in the component so the upgrade path can clear it
 * deliberately (`retryHostSignIn`) without importing the lazy component.
 */
const AUTO_SIGN_IN_ATTEMPT_KEY = 'fiddy.miniapp.auto-sign-in';

const isHostAccount = (value: unknown): value is MiniAppHostAccount =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as { fid?: unknown }).fid === 'number' &&
  Number.isSafeInteger((value as { fid: number }).fid) &&
  (value as { fid: number }).fid > 0;

/** Every mounted `useHost` in this tab, so the front door follows a late answer. */
const listeners = new Set<(host: MiniAppHostAccount | null) => void>();

let remembered: MiniAppHostAccount | null = null;
let read = false;

const notify = () => {
  for (const listener of listeners) {
    listener(remembered);
  }
};

/** The account this tab was told about, if it was. Synchronous, never a read. */
export const readRememberedHost = (): MiniAppHostAccount | null => {
  if (read) {
    return remembered;
  }

  read = true;

  try {
    const raw = window.sessionStorage?.getItem(HOST_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    remembered = isHostAccount(parsed) ? parsed : null;
  } catch (error) {
    // Private-mode storage, or a value something else wrote: no claim, no
    // crash — the identity read below asks the host again.
    remembered = null;
  }

  return remembered;
};

/**
 * Keep whom the host named, for the rest of this tab.
 *
 * A reload is not a new person: the sign-in path reboots the app after a host
 * sign-in, and the refusal path may reload too, so the one thing that should
 * not happen is asking the host again and getting a slower answer.
 */
export const rememberHost = (host: MiniAppHostAccount | null | undefined) => {
  if (!host) {
    return;
  }

  remembered = host;
  read = true;

  try {
    window.sessionStorage?.setItem(HOST_KEY, JSON.stringify(host));
  } catch (error) {
    // A tab with no storage still has the value in memory for this page.
  }

  notify();
};

/** Forget the host's account: after a sign-out, or when a different one answers. */
export const forgetHost = () => {
  remembered = null;
  read = true;

  try {
    window.sessionStorage?.removeItem(HOST_KEY);
  } catch (error) {
    // Nothing to clean up.
  }

  notify();
};

/** Follow the host identity as it is learned or forgotten. */
const subscribeHost = (
  listener: (host: MiniAppHostAccount | null) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Never re-offer an account that is already signed in here.
 *
 * `done` is what "signed in" means in this client's account book: an account
 * still mid-setup is not one, and offering to continue as the person while
 * their own setup is unfinished would send them past the screen that finishes
 * it. An account book holding a DIFFERENT signed-in account does not suppress
 * the offer — that is exactly the case the offer exists for (this browser is
 * someone else; the host says who is looking).
 */
export const offered = (
  host: MiniAppHostAccount | null,
  signedIn: readonly { fid?: number; done?: boolean }[],
): MiniAppHostAccount | null =>
  host &&
  !signedIn.some((account) => account.done === true && account.fid === host.fid)
    ? host
    : null;

let inFlight: Promise<MiniAppHostAccount | null> | undefined;

/**
 * Ask the host who this is, once at a time.
 *
 * A failed or unanswered lookup is DROPPED from the cache, so the next page
 * asks again — a host slow to answer at first paint is not a host that has
 * nothing to say. A found account is kept (see `rememberHost`), which is what
 * makes a second page free.
 */
export const hostIdentity = (): Promise<MiniAppHostAccount | null> => {
  const known = readRememberedHost();

  if (known) {
    return Promise.resolve(known);
  }

  if (inFlight) {
    return inFlight;
  }

  const pending: Promise<MiniAppHostAccount | null> = (async () => {
    const sdk = await loadMiniAppHostSdk();

    if (!sdk || !(await isInsideMiniAppHost({ sdk }))) {
      return null;
    }

    return hostFromContext(await contextWithinDeadline(sdk));
  })()
    .catch(() => null)
    .then((host) => {
      if (!host && inFlight === pending) {
        inFlight = undefined;
      }

      if (host) {
        rememberHost(host);
      }

      return host;
    });

  inFlight = pending;

  return pending;
};

/**
 * The host's context, bounded by the SAME second everything else waits.
 *
 * A host that answered `isInMiniApp` can still leave `context` hanging (a
 * half-connected iframe), and an identity read is not worth an indefinite wait.
 * Quilcast races 1.5 s because its SDK has no `isInMiniApp` at all; this client
 * already owns that call, so it reuses the one timeout instead of adding a
 * second clock.
 */
const contextWithinDeadline = async (sdk: MiniAppHostSdk): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      sdk.context,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The Mini App host did not answer')),
          MINI_APP_HOST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/**
 * `hostIdentity()` for a component: null until (and unless) a host names someone.
 *
 * It starts from what this tab already knows and then follows the read, so a
 * front door that painted before the host answered still gains the card when
 * the answer lands — no reload, and no second question to the host.
 */
export const useHost = (): MiniAppHostAccount | null => {
  const [host, setHost] = useState<MiniAppHostAccount | null>(() =>
    readRememberedHost(),
  );

  useEffect(() => {
    let live = true;

    const unsubscribe = subscribeHost((next) => {
      if (live) {
        setHost(next);
      }
    });

    void hostIdentity().then((next) => {
      if (live && next) {
        setHost(next);
      }
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return host;
};

/** Has the automatic host sign-in already been tried in this tab? */
export const hostSignInAttempted = (): boolean => {
  try {
    return window.sessionStorage?.getItem(AUTO_SIGN_IN_ATTEMPT_KEY) === 'true';
  } catch (error) {
    return false;
  }
};

/** Record the attempt BEFORE asking the host, which is what breaks the loop. */
export const beginHostSignInAttempt = () => {
  try {
    window.sessionStorage?.setItem(AUTO_SIGN_IN_ATTEMPT_KEY, 'true');
  } catch (error) {
    // Private-mode storage: the guard is a nicety, not a requirement.
  }
};

/**
 * Ask the host to sign this person in again — deliberately, because they said so.
 *
 * The automatic attempt is one per tab on purpose (an unguarded retry loop
 * inside somebody's Farcaster app would be a disaster), so a person who wants
 * to post after reading has one honest move: clear the mark and let the same,
 * proven sign-in run once more. No second sign-in implementation, and the
 * refusal copy never has to pretend a door exists that does not.
 */
export const retryHostSignIn = () => {
  try {
    window.sessionStorage?.removeItem(AUTO_SIGN_IN_ATTEMPT_KEY);
  } catch (error) {
    // Without storage the reload still runs the attempt once.
  }

  window.location.reload();
};
