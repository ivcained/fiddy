/**
 * The gate that decides whether the Feed tab reads its node at all.
 *
 * Same approach as the other mobile tests: `node --test` against the app's own
 * TypeScript output, no runner, no React. What the schedule does once a poller
 * exists is `headPoller.test.mjs`; this file is only about whether one exists.
 *
 * The card asked for exactly this matrix: backgrounded app, another tab, a node
 * known to be down, and a feed that is not ready yet must each mean no reads.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { shouldPoll } = require('./.build/pollGate.js');

/** The one state that should poll, before each case bends one input. */
const base = {
  appState: 'active',
  sessionStatus: 'ok',
  feedStatus: 'ready',
  tabFocused: true,
};

describe('shouldPoll', () => {
  it('polls when the tab is showing, the app is active, the node is up and the list is ready', () => {
    assert.equal(shouldPoll(base), true);
  });

  it('polls while the health probe is still checking (the feed read itself is the test)', () => {
    assert.equal(shouldPoll({ ...base, sessionStatus: 'checking' }), true);
  });

  it('never polls while the app is backgrounded', () => {
    for (const sessionStatus of ['ok', 'checking', 'down']) {
      assert.equal(shouldPoll({ ...base, appState: 'background', sessionStatus }), false);
    }
  });

  it('never polls while the app is inactive (system sheet, notification shade)', () => {
    assert.equal(shouldPoll({ ...base, appState: 'inactive' }), false);
  });

  it('never polls before the first AppState notification lands', () => {
    assert.equal(shouldPoll({ ...base, appState: 'unknown' }), false);
  });

  it('never polls while the node is known to be down', () => {
    assert.equal(shouldPoll({ ...base, sessionStatus: 'down' }), false);
  });

  it('never polls while another tab is showing', () => {
    assert.equal(shouldPoll({ ...base, tabFocused: false }), false);
  });

  it('never polls before there is a list to diff against', () => {
    for (const feedStatus of ['idle', 'loading', 'error']) {
      assert.equal(shouldPoll({ ...base, feedStatus }), false);
    }
  });

  it('is false when every input is wrong, and true only for the one good row', () => {
    const inputs = {
      appState: ['active', 'background', 'inactive', 'unknown'],
      sessionStatus: ['ok', 'checking', 'down'],
      feedStatus: ['idle', 'loading', 'ready', 'error'],
      tabFocused: [true, false],
    };
    let trueCount = 0;
    for (const appState of inputs.appState) {
      for (const sessionStatus of inputs.sessionStatus) {
        for (const feedStatus of inputs.feedStatus) {
          for (const tabFocused of inputs.tabFocused) {
            const result = shouldPoll({ appState, sessionStatus, feedStatus, tabFocused });
            const expected =
              appState === 'active' &&
              sessionStatus !== 'down' &&
              feedStatus === 'ready' &&
              tabFocused;
            assert.equal(result, expected, `${appState}/${sessionStatus}/${feedStatus}/${tabFocused}`);
            if (result) {
              trueCount += 1;
            }
          }
        }
      }
    }
    // Two rows: health 'ok' and 'checking', every other input in its good state.
    assert.equal(trueCount, 2);
  });
});