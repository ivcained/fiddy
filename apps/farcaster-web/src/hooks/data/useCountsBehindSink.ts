import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { ApiCast } from 'farcaster-client-data';
import { buildGloballyCachedCastKey } from 'farcaster-client-hooks';
import { useCallback } from 'react';

import type { CastCounts, CastCountsSink } from '~/snapchain/nodeApi/reads';

/**
 * A feed page's counts, landing in the casts the feed is already rendering.
 *
 * WHY THE GLOBAL CAST CACHE AND NOT THE FEED's OWN PAGE DATA
 *
 * The counts arrive seconds after the page did, into a page that is already on
 * screen and must not be remounted (`useFeedItems` resolves once for the whole
 * page; re-writing it would be a second, visible load). Every cast a feed
 * renders goes through `useGloballyCachedCast`, which re-renders when the entry
 * for that hash changes — so a count written onto the cached cast appears on
 * screen under the paint, with no remount and no second query.
 *
 * Only counts that were really read arrive here (`reads.ts` `readCastCounts`
 * leaves out a count whose read failed), and only casts that are really in the
 * cache are written: this never CREATES an entry. A count written onto a hash
 * nobody is rendering would be half a cast in the global cache, and the next
 * surface to read it would find a cast with counts and no text.
 *
 * A cast can be cached under two keys — itself, and as a recast — and both are
 * filled when both exist. The flag is part of the key, and `compactQueryKey`
 * drops only `undefined`, so "itself" is `false` and not `undefined`: every
 * writer and every reader of this cache passes `!!recast` (a feed stores its
 * page's casts with `recast: false`). Writing the `undefined` key instead reads
 * the same in review and matches nothing at all — the counts were read, merged
 * onto a key no cast was held under, and dropped, leaving a feed that painted
 * early and never showed a number.
 */
export const mergeCastCountsIntoGloballyCachedCasts = ({
  queryClient,
  counts,
}: {
  queryClient: QueryClient;
  counts: CastCounts[];
}): number => {
  let updated = 0;

  for (const { hash, reactions, recasts } of counts) {
    let wroteThisCast = false;

    for (const recast of [false, true]) {
      const key = buildGloballyCachedCastKey({ hash, recast });
      const cached = queryClient.getQueryData<ApiCast>(key);
      if (!cached) {
        continue;
      }
      queryClient.setQueryData<ApiCast>(key, {
        ...cached,
        reactions,
        recasts,
      });
      wroteThisCast = true;
    }

    if (wroteThisCast) {
      updated += 1;
    }
  }

  return updated;
};

/**
 * The sink the node-backed seam hands a feed page's counts to
 * (`~/snapchain/nodeApi/nodeBackedFetch` `onCountsRead`, wired in
 * `~/contexts/WebFarcasterApiClientProvider`).
 *
 * Returning this from a component is what turns the counts-behind-the-paint
 * read on at all: without a sink registered the seam answers a page WITH its
 * counts exactly as it used to, because there would be nowhere for a late
 * count to land. So the app that renders counts is the app that asks for them
 * this way — see the card: a cold first cast used to wait ~5.5 s for the
 * slowest per-cast count read on the page.
 */
export const useCountsBehindSink = (): CastCountsSink => {
  const queryClient = useQueryClient();

  return useCallback(
    (counts: CastCounts[]) => {
      mergeCastCountsIntoGloballyCachedCasts({ queryClient, counts });
    },
    [queryClient],
  );
};
