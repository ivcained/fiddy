/**
 * A mini app left in the dock goes to sleep.
 *
 * WHY
 *
 * A mini app is somebody else's page running in this window. When the reader
 * collapses it into the dock, it stays mounted: its timers, sockets, video
 * decoders and heap keep running behind a zero-height panel, on a phone, in a
 * browser the operating system may kill for exactly that. Nothing in the reader's
 * view says it is still there, and nothing ever stops it.
 *
 * So a collapsed app is UNLOADED — the frame dropped, `ready`, the primary
 * button and the back state reset — and a launch config kept so the dock still
 * shows the app. Opening it again reloads it from its splash, exactly like a
 * fresh open: quilcast makes the same trade, and an iframe resumed from a stale
 * belief that it is still connected is worse than a reload.
 *
 * THE THREE RULES, AND WHY THEY ARE THESE
 *
 * 1. **Never while something is in flight.** A pending wallet request, a
 *    signature the reader is being asked to approve, an ask card, a composer
 *    the app opened — unmounting the frame under any of those takes the
 *    approval sheet away and leaves a promise that never settles. This is the
 *    load-bearing rule; the timeout is worthless without it.
 * 2. **Five minutes docked.** Long enough that the reader who flipped to the
 *    feed and back keeps their place, short enough that the app is not still
 *    holding a socket an hour later.
 * 3. **Immediately when the page is hidden, on a phone.** That is the case the
 *    OS punishes, and the one where the reader cannot see that we kept it.
 *
 * WHAT IT DOES NOT DECIDE
 *
 * It does not observe anything. `~/components/miniApp/useMiniAppSleep` does the
 * interval and the `visibilitychange` listener and asks this file. That split is
 * why this file has no imports and can be driven with no browser.
 *
 * Adapted from backmeupplz/quilcast (MIT) 0.67.0 `e4d1c71c1952` (`src/sleep.ts`,
 * `IDLE = 5 min`, `busy()` gating, `nap()` on `visibilitychange`). Its
 * `awake(phone)` cap and its LRU ordering are NOT ported: this dock has one
 * slot, so there is nothing to evict and no order to keep.
 */

/** How long an app may sit in the dock before it is unloaded. */
export const MINI_APP_IDLE_MS = 5 * 60_000;

/** Why an app was put to sleep, for a test to name and a reader to be told. */
export type MiniAppNapReason = 'hidden' | 'idle';

export interface MiniAppWakefulness {
  /** The window is collapsed in the dock, so the app is not on screen. */
  minimized: boolean;
  /** Something in flight would be lost with the frame (`busy`, rule 1). */
  busy: boolean;
  /** `document.hidden`. */
  hidden: boolean;
  /** How long it has been in the dock, in ms. */
  idleMs: number;
  /** A phone or tablet: the device that kills a greedy background page. */
  onPhone: boolean;
}

/**
 * Whether this app should be unloaded right now, and why — `undefined` means it
 * stays awake.
 *
 * A visible app never sleeps, whatever its idle time: the reader is looking at
 * it, and `idleMs` is only ever the time spent in the dock.
 */
export const miniAppNapReason = ({
  minimized,
  busy,
  hidden,
  idleMs,
  onPhone,
}: MiniAppWakefulness): MiniAppNapReason | undefined => {
  if (busy || !minimized) {
    return undefined;
  }
  if (hidden && onPhone) {
    return 'hidden';
  }
  return idleMs >= MINI_APP_IDLE_MS ? 'idle' : undefined;
};

/** The same question as a yes/no, for a caller that has no use for the reason. */
export const shouldNapMiniApp = (state: MiniAppWakefulness): boolean =>
  miniAppNapReason(state) !== undefined;
