// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { type ApiCastFeedItem } from 'farcaster-client-data';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePublicWindow } from '~/hooks/data/usePublicWindow';
import { capturePublicFeedBoot } from '~/lib/publicFeedBoot';

const mocks = vi.hoisted(() => ({ feed: vi.fn() }));
vi.mock('farcaster-client-hooks', () => ({
  useNonSuspenseFeedItems: mocks.feed,
}));
vi.mock('~/utils/castUtils', () => ({
  buildCastsWithContext: (items: unknown) => items,
}));

const HASH_A = `0x${'a'.repeat(40)}`;
const HASH_B = `0x${'b'.repeat(40)}`;
const HASH_C = `0x${'c'.repeat(40)}`;
const item = (hash: string): ApiCastFeedItem =>
  ({
    id: `cast-${hash}`,
    cast: { hash, text: hash, timestamp: 1 },
  }) as unknown as ApiCastFeedItem;
const A = item(HASH_A);
const B = item(HASH_B);
const C = item(HASH_C);

const answer = (feedItems: ApiCastFeedItem[], dataUpdatedAt: number) => ({
  feedItems,
  dataUpdatedAt,
  isLoading: false,
  isError: false,
  error: undefined,
  isFetching: false,
  refetch: vi.fn(),
  onEndReached: vi.fn(),
  isFetchingNextPage: false,
  hasNextPage: false,
});

const hashes = (items: ReadonlyArray<{ cast: { hash: string } }>) =>
  items.map((entry) => entry.cast.hash);

describe('the server-seeded public window', () => {
  beforeEach(() => {
    mocks.feed.mockReset();
    document.body.innerHTML = `<div id="root"><script type="application/json" id="fiddy-public-feed-boot">${JSON.stringify(
      { at: 1000, result: { latestMainCastTimestamp: 1, items: [A, B] } },
    )}</script></div>`;
    capturePublicFeedBoot();
  });

  it('does not reorder the initial casts on a later render after the first refresh', () => {
    mocks.feed.mockReturnValue(answer([A, B], 1000));
    const { result, rerender } = renderHook(() => usePublicWindow('feed'));
    expect(hashes(result.current.castsWithContext)).toEqual([HASH_A, HASH_B]);

    mocks.feed.mockReturnValue(answer([B, C, A], 2000));
    rerender();
    expect(hashes(result.current.castsWithContext)).toEqual([
      HASH_A,
      HASH_B,
      HASH_C,
    ]);

    // A count/context render after that refresh must not restore the network's
    // different order and visibly move the cards that were already on screen.
    mocks.feed.mockReturnValue(answer([C, B, A], 2001));
    rerender();
    expect(hashes(result.current.castsWithContext)).toEqual([
      HASH_A,
      HASH_B,
      HASH_C,
    ]);
  });
});
