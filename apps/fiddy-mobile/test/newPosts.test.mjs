/**
 * The diff behind "N new posts", tested as plain JavaScript against the real
 * TypeScript module.
 *
 * Why .mjs against a compiled file: this app has no test runner and the card
 * forbids new dependencies, so the tests run on `node --test` (Node 20, the
 * runtime the repo pins in .npmrc). Node 20 cannot strip types, so the script
 * compiles the two pure modules `src/feed/newPosts.ts` and
 * `src/feed/headPoller.ts` with the app's own TypeScript into `test/.build`
 * (gitignored) and requires them from there. No bundler, no jest config, no
 * React mock: the code under test is the code that ships, compiler output only.
 *
 * The cases are the card's: top-anchored order, a time-ordered feed, a recast of
 * an old cast, a gap on an empty list, a gap when more is new than a page, own
 * casts excluded from the count, filtered casts excluded from the count.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  entryKey,
  mergeNew,
  newOnTop,
  newPostsFor,
  pillNews,
} = require('./.build/newPosts.js');

/** The fields a feed entry needs: cast hash, whose entry it is, when. */
const cast = (hash, fid, timestampMs) => ({ hash, fid, timestampMs });

const texts = (entries) => entries.map((entry) => entry.hash);

describe('newOnTop, top-anchored feed (Following)', () => {
  it('takes what is above the list’s own top entry', () => {
    const have = [cast('a', 1, 500), cast('b', 2, 400), cast('c', 3, 300)];
    const page = [
      cast('n2', 4, 700),
      cast('n1', 5, 600),
      cast('a', 1, 500),
      cast('b', 2, 400),
    ];

    const found = newOnTop(have, page);

    assert.deepEqual(texts(found.items), ['n2', 'n1']);
    assert.equal(found.gap, false);
  });

  it('anchors on any of the top five, so one deleted cast does not lose the rest', () => {
    // `a` was deleted between reads; `b` is still there and still anchors.
    const have = [cast('a', 1, 500), cast('b', 2, 400), cast('c', 3, 300)];
    const page = [cast('n1', 4, 600), cast('b', 2, 400), cast('c', 3, 300)];

    const found = newOnTop(have, page);

    assert.deepEqual(texts(found.items), ['n1']);
    assert.equal(found.gap, false);
  });

  it('does not take an old cast again just because it is on the page', () => {
    const have = [cast('a', 1, 500), cast('b', 2, 400)];
    const page = [cast('a', 1, 500), cast('b', 2, 400)];

    const found = newOnTop(have, page);

    assert.deepEqual(found.items, []);
    assert.equal(found.gap, false);
  });

  it('is not fooled by a fresh recast of a cast already on screen', () => {
    // The recast is a new entry (`hash:fid` is new) sitting above the original,
    // which is still on the page: the anchor is the original, and both the
    // recast and the genuinely new cast under it are taken.
    const have = [cast('old', 1, 500), cast('b', 2, 400), cast('c', 3, 300)];
    const page = [
      cast('recast-of-old', 9, 800),
      cast('n1', 5, 700),
      cast('old', 1, 500),
      cast('b', 2, 400),
    ];

    const found = newOnTop(have, page);

    assert.deepEqual(texts(found.items), ['recast-of-old', 'n1']);
    assert.equal(found.gap, false);
  });

  it('reports a gap when none of the top entries is on the page', () => {
    const have = [cast('a', 1, 500), cast('b', 2, 400)];
    // Everything above is new, more than a page holds: `a` and `b` fell off.
    const page = [cast('n3', 4, 800), cast('n2', 5, 700), cast('n1', 6, 600)];

    const found = newOnTop(have, page);

    assert.deepEqual(texts(found.items), ['n3', 'n2', 'n1']);
    assert.equal(found.gap, true);
  });

  it('reports a gap on an empty list (nothing to anchor to)', () => {
    const found = newOnTop([], [cast('n1', 4, 600), cast('n2', 5, 500)]);

    assert.deepEqual(texts(found.items), ['n1', 'n2']);
    assert.equal(found.gap, true);
  });
});

describe('newOnTop, time-ordered feed (ranked, no anchor)', () => {
  it('keeps only casts newer than the newest on screen', () => {
    const have = [cast('a', 1, 500), cast('b', 2, 400)];
    // A ranked page can surface an old cast at the top; it is not news.
    const page = [
      cast('resurfaced', 7, 100),
      cast('n1', 4, 700),
      cast('a', 1, 500),
    ];

    const found = newOnTop(have, page, { byTime: true });

    assert.deepEqual(texts(found.items), ['n1']);
    assert.equal(found.gap, false);
  });

  it('never reports a gap, even with nothing in common', () => {
    const found = newOnTop([cast('a', 1, 500)], [cast('n1', 4, 700)], {
      byTime: true,
    });

    assert.deepEqual(texts(found.items), ['n1']);
    assert.equal(found.gap, false);
  });
});

describe('what the pill counts', () => {
  const have = [cast('a', 1, 500)];
  const page = [
    cast('n1', 4, 900),
    cast('mine', 99, 850),
    cast('n2', 5, 800),
    { hash: 'hidden', fid: 6, timestampMs: 750, silenced: true },
    cast('a', 1, 500),
  ];
  const keep = (entry) => !entry.silenced;

  it('leaves out the viewer’s own casts and anything the feed filters', () => {
    const found = newPostsFor({
      have,
      page,
      viewerFid: 99,
      keep,
    });

    assert.ok(found);
    assert.deepEqual(texts(found.news), ['n1', 'n2']);
    assert.equal(found.count, 2);
    // The viewer's own cast is still inserted, it is just not counted.
    assert.deepEqual(texts(found.items), ['n1', 'mine', 'n2', 'hidden']);
  });

  it('shows the faces of up to three distinct authors', () => {
    const found = newPostsFor({
      have,
      page: [
        cast('n1', 4, 900),
        cast('n2', 4, 850),
        cast('n3', 5, 800),
        cast('n4', 6, 700),
        cast('n5', 7, 600),
        cast('a', 1, 500),
      ],
      viewerFid: 99,
    });

    assert.ok(found);
    assert.deepEqual(found.authors, [4, 5, 6]);
  });

  it('says nothing countable when the page could not be anchored', () => {
    // A gap: the count is only what could be verified, so there is no number.
    const found = newPostsFor({
      have: [cast('a', 1, 500)],
      page: [cast('n1', 4, 900), cast('n2', 5, 800)],
      viewerFid: 99,
    });

    assert.ok(found);
    assert.equal(found.count, null);
    assert.equal(found.replace, true);
  });

  it('says nothing countable when some authors could not be read', () => {
    const found = newPostsFor({
      have: [cast('a', 1, 500)],
      page: [cast('n1', 4, 900), cast('a', 1, 500)],
      viewerFid: 99,
      unread: 1,
    });

    assert.ok(found);
    assert.equal(found.count, null);
    assert.equal(found.replace, false);
  });

  it('finds nothing when the page has nothing above the list', () => {
    assert.equal(
      newPostsFor({ have, page: [cast('a', 1, 500)], viewerFid: 99 }),
      null,
    );
  });
});

describe('the entry key and the merge', () => {
  it('tells the same cast apart from a recast of it', () => {
    assert.equal(entryKey(cast('x', 1, 1)), 'x:1');
    assert.notEqual(entryKey(cast('x', 1, 1)), entryKey(cast('x', 2, 1)));
  });

  it('puts new entries on top, newest first, without duplicating', () => {
    const have = [cast('b', 2, 400), cast('c', 3, 300)];
    const merged = mergeNew(have, [
      cast('n', 4, 700),
      cast('b', 2, 400),
      cast('older', 5, 100),
    ]);

    assert.deepEqual(texts(merged), ['n', 'b', 'c', 'older']);
  });

  it('returns the list untouched when there is nothing to add', () => {
    const have = [cast('b', 2, 400)];
    assert.equal(mergeNew(have, [cast('b', 2, 400)]), have);
  });

  it('keeps only what the feed would show', () => {
    const items = [
      cast('n1', 4, 900),
      { hash: 'hidden', fid: 6, timestampMs: 800, silenced: true },
    ];
    assert.deepEqual(texts(pillNews(items, { keep: (e) => !e.silenced })), [
      'n1',
    ]);
  });
});

describe('newOnTop, a future-dated cast on top (live-data case)', () => {
  // A read node really serves these: the graph used for the card's verification
  // had one dated 2061 sitting at the top of the feed ("oh so we're time
  // traveling now?"). It is above everything forever, so if it were allowed to
  // anchor the diff, nothing would ever count as new.
  const NOW = 1_800_000_000_000;
  const future = cast('time-travel', 347, NOW + 35 * 365 * 24 * 3600 * 1000);

  it('does not anchor on the future cast, so what is new is still found', () => {
    const have = [future, cast('b', 2, NOW - 1_000), cast('c', 3, NOW - 5_000)];
    const page = [future, cast('n', 4, NOW - 500), cast('b', 2, NOW - 1_000)];
    const { items, gap } = newOnTop(have, page, { now: NOW });

    assert.equal(gap, false);
    assert.deepEqual(texts(items), ['n']);
  });

  it('reports nothing new when the only page entry above the anchor is the future cast itself', () => {
    const have = [future, cast('b', 2, NOW - 1_000)];
    const page = [future, cast('b', 2, NOW - 1_000)];
    const { items, gap } = newOnTop(have, page, { now: NOW });

    assert.equal(gap, false);
    assert.deepEqual(texts(items), []);
  });

  it('treats a future cast as an ordinary entry when reading it as a new post', () => {
    // A future cast that the list does not show yet is still new content: it is
    // not withheld, only kept out of the anchor set.
    const have = [cast('b', 2, NOW - 1_000)];
    const page = [future, cast('b', 2, NOW - 1_000)];
    const { items } = newOnTop(have, page, { now: NOW });
    assert.deepEqual(texts(items), ['time-travel']);
  });

  it('falls back to a gap when every top entry is future-dated', () => {
    const have = [future, cast('other-future', 9, NOW + 10 * 365 * 24 * 3600 * 1000)];
    const page = [cast('n', 4, NOW - 500)];
    const { gap } = newOnTop(have, page, { now: NOW });
    assert.equal(gap, true);
  });

  it('still anchors on an entry that is only a few seconds ahead of the clock', () => {
    const slight = cast('ahead-by-a-second', 2, NOW + 1_000);
    const have = [slight, cast('b', 3, NOW - 1_000)];
    const page = [cast('n', 4, NOW - 100), slight, cast('b', 3, NOW - 1_000)];
    const { items, gap } = newOnTop(have, page, { now: NOW });
    assert.equal(gap, false);
    assert.deepEqual(texts(items), ['n']);
  });
});
