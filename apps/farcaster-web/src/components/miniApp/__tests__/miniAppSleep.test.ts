/**
 * The dock rules: when a collapsed mini app is unloaded, and when it must not be.
 *
 * Ported intent from backmeupplz/quilcast (MIT) 0.67.0 `e4d1c71c1952`, whose
 * `sleep.ts` unloads a docked app after five idle minutes and never while
 * `busy()`.
 */
import { describe, expect, it } from 'vitest';

import {
  MINI_APP_IDLE_MS,
  miniAppNapReason,
  type MiniAppWakefulness,
  shouldNapMiniApp,
} from '~/components/miniApp/miniAppSleep';

const awake = (over: Partial<MiniAppWakefulness> = {}): MiniAppWakefulness => ({
  minimized: true,
  busy: false,
  hidden: false,
  idleMs: 0,
  onPhone: true,
  ...over,
});

describe('an app docked for a while', () => {
  it('sleeps once it has been in the dock for five minutes', () => {
    expect(miniAppNapReason(awake({ idleMs: MINI_APP_IDLE_MS }))).toBe('idle');
    expect(miniAppNapReason(awake({ idleMs: MINI_APP_IDLE_MS - 1 }))).toBe(
      undefined,
    );
    expect(miniAppNapReason(awake({ idleMs: 60 * 60_000 }))).toBe('idle');
  });

  it('stays awake while it is on screen, however long it has been open', () => {
    // `idleMs` only ever counts time in the dock, and a visible app is the one
    // the reader is looking at.
    expect(
      miniAppNapReason(awake({ minimized: false, idleMs: 60 * 60_000 })),
    ).toBe(undefined);
  });
});

describe('the page going away', () => {
  it('sleeps a docked app at once on a phone', () => {
    expect(miniAppNapReason(awake({ hidden: true }))).toBe('hidden');
  });

  it('leaves a desktop alone: a hidden tab is not being killed for memory', () => {
    expect(miniAppNapReason(awake({ hidden: true, onPhone: false }))).toBe(
      undefined,
    );
  });
});

describe('never while something is in flight', () => {
  it('refuses every path, including the hidden one', () => {
    // A pending wallet request, a signature being approved, an ask card, a
    // composer the app opened: unmounting under any of those takes the
    // approval sheet away and leaves a promise that never settles.
    for (const reason of [
      { idleMs: MINI_APP_IDLE_MS * 10 },
      { hidden: true },
      { hidden: true, idleMs: MINI_APP_IDLE_MS * 10 },
    ]) {
      expect(shouldNapMiniApp(awake({ ...reason, busy: true }))).toBe(false);
    }
  });

  it('sleeps as soon as the work settles', () => {
    expect(shouldNapMiniApp(awake({ hidden: true, busy: true }))).toBe(false);
    expect(shouldNapMiniApp(awake({ hidden: true, busy: false }))).toBe(true);
  });
});

describe('the yes/no form agrees with the reason', () => {
  it('is true exactly when there is a reason', () => {
    for (const state of [
      awake(),
      awake({ hidden: true }),
      awake({ idleMs: MINI_APP_IDLE_MS }),
      awake({ busy: true, hidden: true }),
      awake({ minimized: false, hidden: true }),
    ]) {
      expect(shouldNapMiniApp(state)).toBe(
        miniAppNapReason(state) !== undefined,
      );
    }
  });
});
