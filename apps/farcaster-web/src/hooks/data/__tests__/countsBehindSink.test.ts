/**
 * A late count lands on the cast the feed is ALREADY rendering.
 *
 * The counts of a feed page are read behind its paint (see
 * `~/snapchain/nodeApi/reads` `readCastCounts` and
 * `scripts/measure-first-cast.mjs`), so by the time they arrive the page is on
 * screen and must not be reloaded. Every cast a feed renders goes through
 * `useGloballyCachedCast`, which re-renders when its entry in the global cast
 * cache changes — so the merge below is what makes a count appear under the
 * paint, with no remount and no second query.
 *
 * Two rules this pins, both of which a "merge everything into everything"
 * version would break:
 *
 *   - a hash nobody has cached is NOT created by a count: the global cast cache
 *     holds whole casts, and a count-only entry would be half a cast for the
 *     next surface that reads it (its text, author and embeds missing);
 *   - a cast cached as a recast is a separate entry (`buildGloballyCachedCastKey`
 *     includes the flag), so both are filled when both exist.
 */

import { QueryClient } from '@tanstack/react-query';
import { ApiCast } from 'farcaster-client-data';
import { buildGloballyCachedCastKey } from 'farcaster-client-hooks';
import { describe, expect, it } from 'vitest';

import { mergeCastCountsIntoGloballyCachedCasts } from '~/hooks/data/useCountsBehindSink';

const castFixture = (hash: string, overrides: Partial<ApiCast> = {}): ApiCast =>
  ({
    hash,
    threadHash: hash,
    author: { fid: 3, displayName: 'dwr', followerCount: 0, followingCount: 0 },
    text: 'a cast with no counts yet',
    timestamp: 1_700_000_000_000,
    replies: { count: 0 },
    watches: { count: 0 },
    ...overrides,
  }) as ApiCast;

const countsFor = (hash: string) => ({
  hash,
  reactions: { count: 7 },
  recasts: { count: 2 },
});

/** The key a feed's casts are really cached under.
 *
 * NOT `{ hash }`: the flag is part of the key and `compactQueryKey` drops only
 * `undefined`, so a cast held as itself is `[.., hash, false]` — every writer
 * and every reader passes `!!recast` (`useBatchMergeIntoGloballyCachedCasts`,
 * `useGloballyCachedCast`). This test file used to seed `{ hash }` instead,
 * which is the key `mergeCastCountsIntoGloballyCachedCasts` wrote to at the
 * time — so the merge and its test agreed with each other and neither agreed
 * with the app. On a live release the counts were read, delivered to the sink
 * and dropped onto a key no cast was held under, and the feed showed no numbers
 * at all (measured 2026-10-23, cold sign-in, 390px). Seed what the app holds. */
const castKey = (hash: string, recast = false) =>
  buildGloballyCachedCastKey({ hash, recast });

describe('a page’s counts merge into the casts already cached', () => {
  it('fills the counts of a cast that is on screen', () => {
    const queryClient = new QueryClient();
    const hash = '0xabc';
    const key = castKey(hash);
    queryClient.setQueryData(key, castFixture(hash));

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor(hash)],
    });

    expect(updated).toBe(1);
    const cast = queryClient.getQueryData<ApiCast>(key)!;
    expect(cast.reactions).toEqual({ count: 7 });
    expect(cast.recasts).toEqual({ count: 2 });
    // The rest of the cast is untouched: this is a count arriving, not a page.
    expect(cast.text).toBe('a cast with no counts yet');
    expect(cast.author.fid).toBe(3);
  });

  it('lands on the key the feed stores its casts under, and not the flagless one', () => {
    const queryClient = new QueryClient();
    const hash = '0xflag';
    queryClient.setQueryData(castKey(hash), castFixture(hash));

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor(hash)],
    });

    expect(updated).toBe(1);
    expect(queryClient.getQueryData<ApiCast>(castKey(hash))!.reactions).toEqual(
      { count: 7 },
    );
    // The flagless key is NOT where a cast lives; a count written there is a
    // count dropped, which is what this test exists to catch.
    expect(
      queryClient.getQueryData(buildGloballyCachedCastKey({ hash })),
    ).toBeUndefined();
  });

  it('creates nothing for a hash nobody has cached', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(castKey('0xoncache'), castFixture('0xoncache'));
    const before = queryClient.getQueryCache().getAll().length;

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor('0xnobody')],
    });

    expect(updated).toBe(0);
    expect(queryClient.getQueryCache().getAll().length).toBe(before);
    expect(
      queryClient.getQueryData(
        buildGloballyCachedCastKey({ hash: '0xnobody' }),
      ),
    ).toBeUndefined();
  });

  it('fills both a cast and its recast entry when both are cached', () => {
    const queryClient = new QueryClient();
    const hash = '0xboth';
    const plain = castKey(hash);
    const asRecast = castKey(hash, true);
    queryClient.setQueryData(plain, castFixture(hash));
    queryClient.setQueryData(asRecast, castFixture(hash, { recast: true }));

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor(hash)],
    });

    expect(updated).toBe(1);
    expect(queryClient.getQueryData<ApiCast>(plain)!.reactions).toEqual({
      count: 7,
    });
    expect(queryClient.getQueryData<ApiCast>(asRecast)!.reactions).toEqual({
      count: 7,
    });
  });

  it('reports how many casts it filled, one per cast', () => {
    const queryClient = new QueryClient();
    for (const hash of ['0xone', '0xtwo', '0xthree']) {
      queryClient.setQueryData(castKey(hash), castFixture(hash));
    }

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: ['0xone', '0xtwo', '0xthree', '0xmissing'].map(countsFor),
    });

    expect(updated).toBe(3);
  });
});
