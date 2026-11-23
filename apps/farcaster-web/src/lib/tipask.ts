/**
 * Hold Like to tip: a tiny state machine that gates whether a long-press on the
 * Like button may tip the cast's author. Borrowed from quilcast (MIT).
 *
 * The first full hold in this browser explains itself first (TipSheet) and
 * sends nothing unless the person taps Tip; after that, holds tip at once.
 * The sheet and Settings share one switch for the whole thing: off, holding
 * Like works like a tap.
 *
 * Borrowed from quilcast (MIT)
 *   https://github.com/backmeupplz/quilcast
 *   src/tipask.ts / commit 700d8b78d8c7
 */

const TOLD = 'fiddy:tip-told';
const OFF = 'fiddy:hold-tip-off';

const get = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

const put = (k: string, on: boolean) => {
  try {
    if (on) {
      localStorage.setItem(k, '1');
    } else {
      localStorage.removeItem(k);
    }
  } catch {
    // A browser that refuses to store is not a reason to break the tap.
  }
};

/** Whether holding Like tips; on unless someone switched it off. */
export const holdTip = (): boolean => get(OFF) !== '1';
export const setHoldTip = (on: boolean): void => {
  put(OFF, !on);
};

/** Whether this browser was told how hold-to-tip works and went on to tip. */
export const tipTold = (): boolean => get(TOLD) === '1';

/**
 * Shows the explanation (`from`: the wallet that pays, `to`: the author's
 * name) and settles with whether to tip. TipSheet sets it once it is on the
 * page. Until then nothing can be explained, so nothing is sent.
 */
export const tipSheet: {
  ask: (o: { from: string; to: string }) => Promise<boolean>;
} = { ask: () => Promise.resolve(false) };

/**
 * Whether a full hold may tip: never while switched off, at once once told,
 * else after the explanation. The sheet's own switch may have been turned off
 * before Tip.
 */
export async function tipOk(o: { from: string; to: string }): Promise<boolean> {
  if (!holdTip()) {
    return false;
  }
  if (tipTold()) {
    return true;
  }
  // The sheet's switch may have been turned off before Tip.
  const ok = (await tipSheet.ask(o)) && holdTip();
  if (ok) {
    put(TOLD, true);
  }
  return ok;
}
