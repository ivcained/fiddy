/**
 * The pill's words, tested as plain JavaScript against the real TypeScript
 * module (same approach as `newPosts.test.mjs`: `node --test` on the app's own
 * compiler output, no test runner, no new dependency).
 *
 * What is under test here is the review's finding: the one-shot VoiceOver
 * announcement used to speak `fid 12` for every author whose profile had not
 * landed yet, which is every new author. The rule now is "name who you can, and
 * drop the clause otherwise" — never a number in place of a name.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  allHandlesKnown,
  knownHandles,
  newPostsAccessibilityLabel,
  newPostsLabel,
} = require('./.build/pillLabel.js');

/** A profile map with a `get`, which is all the module asks of it. */
const profilesOf = (entries) => new Map(entries.map(([fid, username]) => [fid, { username }]));

describe('newPostsLabel', () => {
  it('says the number, singular and plural', () => {
    assert.equal(newPostsLabel(3), '3 new posts');
    assert.equal(newPostsLabel(1), '1 new post');
  });

  it('says no number when no count can be stood behind', () => {
    assert.equal(newPostsLabel(null), 'New posts');
  });

  it('says no number when the held count is zero (own or filtered casts only)', () => {
    assert.equal(newPostsLabel(0), 'New posts');
  });

  it('never uses "unread" or an away-from-the-app phrasing', () => {
    for (const count of [null, 0, 1, 9]) {
      const label = newPostsLabel(count);
      assert.doesNotMatch(label, /unread|away|since you|missed/i);
    }
  });
});

describe('knownHandles', () => {
  it('names only the authors whose profile has landed', () => {
    const profiles = profilesOf([[2, 'alice']]);
    assert.deepEqual(knownHandles([2, 3], profiles), ['@alice']);
  });

  it('names nobody when nothing has landed, rather than falling back to FIDs', () => {
    const handles = knownHandles([12, 13, 14], profilesOf([]));
    assert.deepEqual(handles, []);
    assert.ok(!handles.join(' ').includes('fid'));
  });

  it('keeps the order the authors appear in, and names a repeated author once', () => {
    const profiles = profilesOf([
      [2, 'alice'],
      [5, 'bob'],
    ]);
    assert.deepEqual(knownHandles([5, 2, 5], profiles), ['@bob', '@alice']);
  });

  it('drops an author whose profile exists but has no username', () => {
    const profiles = profilesOf([[2, null]]);
    assert.deepEqual(knownHandles([2], profiles), []);
  });
});

describe('allHandlesKnown', () => {
  it('is false until every author can be named', () => {
    const profiles = profilesOf([[2, 'alice']]);
    assert.equal(allHandlesKnown([2], profiles), true);
    assert.equal(allHandlesKnown([2, 3], profiles), false);
  });

  it('is true for an empty list: there is nobody to wait for', () => {
    assert.equal(allHandlesKnown([], profilesOf([])), true);
  });
});

describe('newPostsAccessibilityLabel', () => {
  it('reads the card’s sentence when every author is known', () => {
    assert.equal(
      newPostsAccessibilityLabel({
        count: 3,
        handles: ['@a', '@b', '@c'],
        replace: false,
      }),
      '3 new posts from @a, @b and @c. Show them.',
    );
  });

  it('drops the "from" clause when no author can be named', () => {
    assert.equal(
      newPostsAccessibilityLabel({ count: 3, handles: [], replace: false }),
      '3 new posts. Show them.',
    );
  });

  it('names a single author', () => {
    assert.equal(
      newPostsAccessibilityLabel({ count: 1, handles: ['@a'], replace: false }),
      '1 new post from @a. Show them.',
    );
  });

  it('names at most three, counts the rest', () => {
    assert.equal(
      newPostsAccessibilityLabel({
        count: 6,
        handles: ['@a', '@b', '@c', '@d', '@e'],
        replace: false,
      }),
      '6 new posts from @a, @b, @c and 2 more. Show them.',
    );
  });

  it('says "New posts" without a number when the count is refused', () => {
    assert.equal(
      newPostsAccessibilityLabel({ count: null, handles: ['@a'], replace: false }),
      'New posts from @a. Show them.',
    );
  });

  it('tells the gap case what the tap really does', () => {
    assert.equal(
      newPostsAccessibilityLabel({ count: null, handles: [], replace: true }),
      'New posts. Reload the feed.',
    );
  });

  it('never speaks a FID', () => {
    for (const handles of [[], ['@a'], ['@a', '@b'], ['@a', '@b', '@c', '@d']]) {
      const label = newPostsAccessibilityLabel({ count: 2, handles, replace: false });
      assert.doesNotMatch(label, /\bfid\b/i);
    }
  });
});