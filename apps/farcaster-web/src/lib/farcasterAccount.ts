/**
 * What a Farcaster sign-in leaves in this device's account book.
 *
 * WHY THIS IS ITS OWN SHAPE. A `LocalAccount` this client made carries a
 * recovery phrase: this device wrote the words down, and this device holds the
 * key that owns the account. A Google or X sign-up carries `walletCustody:
 * 'privy'` instead, because the sign-up provider holds the words. A completed
 * Sign-In-With-Farcaster handshake is neither: the account is one the person
 * ALREADY had, its key is in their own Farcaster app, and this device holds
 * nothing — no phrase, no address, no key. So the row is session-shaped: what
 * the handshake proved (the number, the handle, the name) and nothing that could
 * be mistaken for key material (see `~/snapchain/accounts/localAccounts`).
 *
 * WHY A SIGN-IN WRITES ONE AT ALL. MEASURED 2026-10-22 in a real Chrome at 390
 * and 1440, from `/welcome/account`: the handshake completed, `~/lib/siwfSession`
 * kept the proof, `signIn()` stored the session and the app left for the client —
 * and the Farcaster account was in nobody's account book. The switcher still
 * listed the account this device had made, still called it current, and nothing
 * on screen named the account that was actually signed in. The two facts a
 * person could see disagreed with each other. This module is the row that makes
 * them agree, and `~/components/login/LoginWithMobile` is what writes it.
 *
 * WHY IT MAY BE THE CURRENT ACCOUNT. Because after that handshake it is the
 * account the client is signing in as, and the book's selected row has to be the
 * thing the client actually is. What it may NOT do is claim this device can post
 * for it: a posting key is granted separately (`~/snapchain/accounts/managedConnect`),
 * and the switcher's own row says so until one is. Selecting this row is not a
 * promise to publish anything; it is the honest label for the session that is
 * already open.
 *
 * WHAT IT IS NOT. It is not a second account, and it is not a way in that skips
 * anything: the same `signInAsLocalAccount` path the switcher already uses works
 * for it (a local, device-only session — see `~/snapchain/accounts/session`).
 */

import {
  FARCASTER_SESSION_WALLET_CUSTODY,
  type LocalAccount,
} from '~/snapchain/accounts/localAccounts';

/**
 * How a Farcaster sign-in's row is keyed: by the number it proved.
 *
 * Not by an address, because there is no address here to key it by — and not by
 * the handle, which the person can change. One number is one account, which is
 * the same rule as one custody address is one account.
 */
export const FARCASTER_ACCOUNT_ID_PREFIX = 'farcaster:';

export const farcasterAccountIdFor = (fid: number): string =>
  `${FARCASTER_ACCOUNT_ID_PREFIX}${fid}`;

/** True when this id is a Farcaster sign-in's row rather than an address. */
export const isFarcasterAccountId = (id: string): boolean =>
  id.startsWith(FARCASTER_ACCOUNT_ID_PREFIX);

/**
 * A Farcaster sign-in, in the book's own shape.
 *
 * `fid` is required because a row with no number would name nothing and could
 * not be signed in as; every other field is what the handshake actually said.
 */
export interface FarcasterSessionRecord extends LocalAccount {
  walletCustody: 'farcaster-app';
  fid: number;
}

/**
 * The record this device keeps for a completed Farcaster sign-in.
 *
 * Returns undefined when the handshake carried no usable number — a record that
 * cannot name an account is not written, rather than written empty.
 *
 * `signedInAt` is deliberately NOT set: that field means "a signing key for this
 * device was last installed for this account", and a sign-in installs nothing
 * here. `custodyAddress` is deliberately not set either (see the interface in
 * `~/snapchain/accounts/localAccounts`).
 */
export const buildFarcasterSessionRecord = ({
  fid,
  username,
  displayName,
  now = Date.now(),
}: {
  fid: number;
  username?: string;
  displayName?: string;
  now?: number;
}): FarcasterSessionRecord | undefined => {
  if (!Number.isSafeInteger(fid) || fid <= 0) {
    return undefined;
  }

  const handle = username?.trim() || undefined;
  const name = displayName?.trim() || handle;

  return {
    id: farcasterAccountIdFor(fid),
    fid,
    createdAt: now,
    walletCustody: FARCASTER_SESSION_WALLET_CUSTODY,
    ...(handle ? { username: handle } : {}),
    ...(name ? { displayName: name } : {}),
  };
};

/** True when this row is a Farcaster sign-in rather than an account held here. */
export const isFarcasterSession = (
  account: LocalAccount | undefined,
): account is FarcasterSessionRecord =>
  account !== undefined &&
  account.walletCustody === FARCASTER_SESSION_WALLET_CUSTODY;

/**
 * What the switcher says about such a row, in the app's own voice.
 *
 * Two things are true at once and both belong on the row: where the sign-in came
 * from (the person's own Farcaster app, not this device), and whether this device
 * can actually post for that account. The second half is the same sentence the
 * rest of the switcher uses, so a person reads one rule rather than two.
 */
export const farcasterSessionNote = ({
  canPost,
}: {
  canPost: boolean;
}): string =>
  canPost
    ? 'signed in with your own Farcaster app, and this device can post'
    : 'signed in with your own Farcaster app, no posting key on this device yet';

/**
 * The sentence before such a row is forgotten.
 *
 * "Forget on this device" removes the row and nothing else — no words of theirs
 * exist here to warn about — so the confirm step says what it actually costs
 * instead of borrowing the warning that belongs to an account made here.
 */
export const FORGET_FARCASTER_SESSION_PROMPT =
  'Really forget it? Your Farcaster account stays yours - this only removes it from this device';
