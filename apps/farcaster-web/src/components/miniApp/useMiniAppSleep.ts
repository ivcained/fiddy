/**
 * Runs the dock rules from `./miniAppSleep` against the live page: one interval,
 * one `visibilitychange` listener, and the clock that starts when the app is
 * collapsed into the dock.
 *
 * The decision itself lives in `./miniAppSleep` (no imports, no browser) so it
 * can be tested without one; this file is only the plumbing, and it holds no
 * opinion of its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { miniAppNapReason } from './miniAppSleep';

/**
 * How often the docked app is re-checked. The threshold is minutes, so a poll
 * this coarse is exact enough, and it costs nothing while the window is open.
 */
const NAP_POLL_MS = 30_000;

/**
 * A phone or tablet. A coarse primary pointer is the honest signal available
 * without a user agent sniff: it is the device class whose OS ends a background
 * page that holds too much, which is the case rule 3 exists for.
 */
const isPhone = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

export interface MiniAppSleep {
  /** The frame must not be mounted. */
  asleep: boolean;
}

/**
 * `busy` is the caller's answer to "would unmounting lose something?" — a
 * pending wallet request, a signature being approved, an ask card, a composer
 * the app opened. It gates every path here, including the hidden-page one.
 */
export function useMiniAppSleep({
  minimized,
  busy,
}: {
  minimized: boolean;
  busy: boolean;
}): MiniAppSleep {
  const [asleep, setAsleep] = useState(false);
  /** When the app went into the dock, or null while it is on screen. */
  const dockedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (minimized) {
      dockedAtRef.current = Date.now();
      return;
    }
    // Back on screen: awake, and the idle clock restarts if it is docked again.
    dockedAtRef.current = null;
    setAsleep(false);
  }, [minimized]);

  const check = useCallback(() => {
    const dockedAt = dockedAtRef.current;
    if (dockedAt === null) {
      return;
    }
    const reason = miniAppNapReason({
      minimized: true,
      busy,
      hidden: typeof document !== 'undefined' && document.hidden,
      idleMs: Date.now() - dockedAt,
      onPhone: isPhone(),
    });
    if (reason !== undefined) {
      setAsleep(true);
    }
  }, [busy]);

  useEffect(() => {
    if (!minimized || busy || asleep) {
      return;
    }
    const timer = setInterval(check, NAP_POLL_MS);
    // A phone backgrounded while the app sat in the dock: the one case where
    // waiting for the next poll can be too late.
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [minimized, busy, asleep, check]);

  return { asleep };
}
