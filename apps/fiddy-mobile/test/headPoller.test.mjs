/**
 * The poll schedule: one read per interval, never two at once, silent while the
 * app is in the background, capped backoff when the node is not answering.
 *
 * A fake clock drives it, so these are the real timings (60 s, 60 s doubling to
 * 10 min) compressed into microseconds and no simulator is involved.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { createHeadPoller } = require('./.build/headPoller.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A clock that only moves when the test says so. */
const fakeClock = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    advance: async (ms) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.size,
  };
};

const counting = (clock, polls) => {
  const poller = createHeadPoller({
    clock,
    poll: async () => {
      polls.push(clock.now());
    },
  });
  return poller;
};

describe('the poll schedule', () => {
  it('reads once per interval, not at all before the first one', async () => {
    const clock = fakeClock();
    const polls = [];
    const poller = counting(clock, polls);
    poller.start();

    await clock.advance(0);
    assert.equal(polls.length, 0);

    await clock.advance(60_000);
    assert.equal(polls.length, 1);

    await clock.advance(60_000);
    assert.equal(polls.length, 2);
    assert.deepEqual(polls, [60_000, 120_000]);
    poller.stop();
  });

  it('never starts a second read while one is in flight', async () => {
    const clock = fakeClock();
    let release;
    let calls = 0;
    const poller = createHeadPoller({
      clock,
      poll: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    poller.start();

    await clock.advance(60_000);
    assert.equal(calls, 1);

    // Two more whole intervals go by with the first read still open: the poll
    // does not stack up behind it.
    await clock.advance(120_000);
    assert.equal(calls, 1);

    release();
    await flush();
    await clock.advance(60_000);
    assert.equal(calls, 2);
    release();
    await flush();
    poller.stop();
  });

  it('stays quiet while paused and catches up on resume', async () => {
    const clock = fakeClock();
    const polls = [];
    const poller = counting(clock, polls);
    poller.start();

    await clock.advance(60_000);
    assert.equal(polls.length, 1);

    // Backgrounded for five minutes: not one read.
    poller.pause();
    await clock.advance(300_000);
    assert.equal(polls.length, 1);

    // A minute had long gone by, so coming back asks at once.
    poller.resume();
    await clock.advance(0);
    assert.equal(polls.length, 2);

    // Short blips do not re-arm the whole interval.
    await clock.advance(10_000);
    poller.pause();
    poller.resume();
    await clock.advance(0);
    assert.equal(polls.length, 2);
    await clock.advance(50_000);
    assert.equal(polls.length, 3);
    poller.stop();
  });

  it('cancels the read in flight when the feed looks away', async () => {
    const clock = fakeClock();
    let token;
    const poller = createHeadPoller({
      clock,
      poll: async (mine) => {
        token = mine;
      },
    });
    poller.start();

    await clock.advance(60_000);
    assert.equal(token.cancelled, false);
    poller.pause();
    assert.equal(token.cancelled, true);
    poller.stop();
  });

  it('backs off after a failure and doubles it, up to ten minutes', async () => {
    const clock = fakeClock();
    const attempts = [];
    const errors = [];
    let fail = true;
    const poller = createHeadPoller({
      clock,
      poll: async () => {
        attempts.push(clock.now());
        if (fail) {
          throw new Error('node did not answer');
        }
      },
      onError: (error) => errors.push(error.message),
    });
    poller.start();

    await clock.advance(60_000); // first attempt, fails → retry in 1 min
    assert.equal(attempts.length, 1);
    await clock.advance(60_000); // fails → retry in 2 min
    await clock.advance(120_000); // fails → retry in 4 min
    await clock.advance(240_000); // fails → retry in 8 min
    await clock.advance(480_000); // fails → retry in 10 min (capped)
    await clock.advance(600_000); // succeeds → back to the 60 s interval

    assert.deepEqual(
      attempts,
      [60_000, 120_000, 240_000, 480_000, 960_000, 1_560_000],
    );
    assert.equal(errors.length, 6);

    fail = false;
    await clock.advance(600_000);
    assert.equal(attempts.length, 7);
    assert.equal(errors.length, 6);
    poller.stop();
  });

  it('does not count a cancelled read as a failure', async () => {
    const clock = fakeClock();
    const errors = [];
    let reject;
    let calls = 0;
    const poller = createHeadPoller({
      clock,
      poll: () => {
        calls += 1;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
      onError: (error) => errors.push(error),
    });
    poller.start();

    await clock.advance(60_000);
    // Looking away cancels the read; when it lands, it is not an error and no
    // retry is armed.
    poller.pause();
    reject(new Error('aborted'));
    await flush();
    assert.equal(errors.length, 0);

    // Zero time passed since that read, so coming back waits out the rest of
    // the interval rather than hammering the node.
    poller.resume();
    await clock.advance(0);
    assert.equal(calls, 1);
    await clock.advance(60_000);
    assert.equal(calls, 2);
    poller.stop();
  });

  it('leaves no timer behind when stopped', async () => {
    const clock = fakeClock();
    const polls = [];
    const poller = counting(clock, polls);
    poller.start();
    await clock.advance(60_000);
    poller.stop();
    assert.equal(clock.pending(), 0);
    await clock.advance(600_000);
    assert.equal(polls.length, 1);
    assert.equal(poller.isRunning(), false);
  });
});
