/**
 * The timer behind "N new posts": one poll per interval, never two at once,
 * quiet while the page is not being looked at.
 *
 * A React effect could not be tested without a renderer, and this app has none
 * on purpose (no test runner, no jest config). So the schedule lives here as a
 * plain closure over an injected clock, and the hook in `useNewPosts` is a thin
 * adapter that wires AppState and the Feed tab's mount to `resume`/`pause`.
 * Behaviour that matters — paused in the background, one read per interval, no
 * overlap, backoff after a failure — is then tested with a fake clock instead of
 * with a simulator.
 */

export interface PollerClock {
  now: () => number;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** A poll can ask whether it is still wanted; a blurred feed stops reading. */
export interface PollToken {
  cancelled: boolean;
}

export interface HeadPollerOptions {
  /** Read the head and hand the news over. Throwing schedules a backoff. */
  poll: (token: PollToken) => Promise<void>;
  /** Time between polls while the feed is on screen. */
  intervalMs?: number;
  /** First retry after a failed poll; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  clock?: Partial<PollerClock>;
  /** Called with the error of a failed poll, after the backoff is armed. */
  onError?: (error: unknown) => void;
}

export interface HeadPoller {
  /** Arm the timer. The first poll happens one interval from now. */
  start: () => void;
  /** Stop for good: clears the timer and cancels the read in flight. */
  stop: () => void;
  /** Look away: no timer, and the read in flight is cancelled. */
  pause: () => void;
  /** Look back: poll at once if a whole interval has gone by, else re-arm. */
  resume: () => void;
  isRunning: () => boolean;
  isPaused: () => boolean;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_MAX_RETRY_MS = 10 * 60_000;

const systemClock: PollerClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const createHeadPoller = ({
  poll,
  intervalMs = DEFAULT_INTERVAL_MS,
  retryMs = DEFAULT_RETRY_MS,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
  clock: injected,
  onError,
}: HeadPollerOptions): HeadPoller => {
  const clock: PollerClock = { ...systemClock, ...injected };
  let timer: unknown;
  let running = false;
  let paused = false;
  let asking = false;
  let failures = 0;
  let lastPollAt = 0;
  let token: PollToken = { cancelled: true };

  const clear = () => {
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (ms: number) => {
    clear();
    timer = clock.setTimeout(tick, ms);
  };

  const tick = () => {
    timer = undefined;
    if (!running || paused) {
      return;
    }
    // Never two reads at once: the next slot is the in-flight read's own
    // `finally`, which arms the following one.
    if (asking) {
      return;
    }
    asking = true;
    lastPollAt = clock.now();
    const mine: PollToken = { cancelled: false };
    token = mine;
    void (async () => {
      try {
        await poll(mine);
        failures = 0;
      } catch (error) {
        // A cancelled read is not a failure: it was us looking away.
        if (!mine.cancelled) {
          failures += 1;
          onError?.(error);
        }
      } finally {
        asking = false;
        if (!running || paused) {
          return;
        }
        const wait =
          failures === 0
            ? intervalMs
            : Math.min(retryMs * 2 ** (failures - 1), maxRetryMs);
        schedule(wait);
      }
    })();
  };

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;
      paused = false;
      lastPollAt = clock.now();
      schedule(intervalMs);
    },
    stop: () => {
      running = false;
      paused = false;
      asking = false;
      token.cancelled = true;
      clear();
    },
    pause: () => {
      if (!running || paused) {
        return;
      }
      paused = true;
      // The read in flight finishes or notices the token; either way nothing
      // comes of it and no timer is armed.
      token.cancelled = true;
      clear();
    },
    resume: () => {
      if (!running || !paused) {
        return;
      }
      paused = false;
      schedule(Math.max(0, lastPollAt + intervalMs - clock.now()));
    },
    isRunning: () => running,
    isPaused: () => paused,
  };
};
