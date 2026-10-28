/**
 * The browse window, as React values.
 *
 * One hook for both public surfaces, because they are the same read shaped two
 * ways: `/feed` shows the window (and can rank it), `/explore` shows what the
 * window is made of (its topics) with the ranked view as the default.
 *
 * The read itself is the client's own: `useNonSuspenseFeedItems` posts to
 * `/v2/feed-items` exactly as the signed-in feeds do, with the public feed key,
 * and the node adapter answers it from `readPublicFeed` through whichever
 * server the provider chain has live. Nothing here fetches anything by hand.
 *
 * `useNonSuspenseFeedItems` rather than the suspense variant on purpose: this
 * surface has real empty, error and retry states (a visitor with no account on
 * a public node is exactly the case where a read can fail), and a suspended
 * query would hand that to an error boundary instead.
 */

import { useNonSuspenseFeedItems } from 'farcaster-client-hooks';
import { useCallback, useMemo, useState } from 'react';

import {
  consumePublicFeedBoot,
  mergeRefreshedPublicFeed,
} from '~/lib/publicFeedBoot';
import {
  feedTypeForWindow,
  PUBLIC_FEED_KEY,
  type PublicFeedKind,
  type PublicWindowTopic,
  topicsFromCasts,
} from '~/snapchain/nodeApi/publicFeedWindow';
import { type ApiCastWithContext } from '~/types';
import { buildCastsWithContext } from '~/utils/castUtils';

/** Which of the two public surfaces is being rendered. */
export type PublicBrowseVariant = 'feed' | 'explore';

export interface PublicWindow {
  kind: PublicFeedKind;
  topic: string | null;
  selectKind: (kind: PublicFeedKind) => void;
  selectTopic: (topic: string | null) => void;
  /** The feed type the read is asking with (`recent`, `trending`, `topic:x`). */
  feedType: string;
  /** What the window is made of, most-used first. Kept while a topic is shown. */
  topics: PublicWindowTopic[];
  castsWithContext: ApiCastWithContext[];
  /** First read in flight and nothing to show yet. */
  isLoading: boolean;
  /** A read failed and there is nothing to show. */
  isError: boolean;
  errorMessage: string | null;
  /** Any read in flight (a refresh, a tab change, the next page). */
  isFetching: boolean;
  isEmpty: boolean;
  onEndReached: () => void;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  retry: () => void;
}

const noop = () => {
  // A null page from the read layer is reported here; the window's own states
  // already say everything a visitor needs, so there is nothing to add.
};

export const usePublicWindow = (variant: PublicBrowseVariant): PublicWindow => {
  // `/feed` opens on what is newest; `/explore` opens on what is getting
  // attention, which is the whole difference between the two surfaces.
  const [kind, setKind] = useState<PublicFeedKind>(
    variant === 'explore' ? 'trending' : 'recent',
  );
  const [topic, setTopic] = useState<string | null>(null);

  // The server-drawn recent page, if this document carried one. Consumed once:
  // it is a first paint, not a second definition of the feed, and it seeds
  // exactly the same query the page would otherwise ask for.
  const [boot] = useState(() =>
    variant === 'feed' ? consumePublicFeedBoot() : undefined,
  );
  const feedType = feedTypeForWindow({ kind, topic });

  // Only the opening recent window matches what the server drew; a topic or
  // the ranked view is the reader's own question and starts from its own read.
  const seed = boot && kind === 'recent' && topic === null ? boot : undefined;
  const initialData = useMemo(
    () =>
      seed
        ? {
            pageParams: [undefined],
            pages: [{ result: seed.result }],
          }
        : undefined,
    [seed],
  );

  const {
    feedItems,
    dataUpdatedAt,
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
    onEndReached,
    isFetchingNextPage,
    hasNextPage,
  } = useNonSuspenseFeedItems({
    feedKey: PUBLIC_FEED_KEY,
    feedType,
    // Nothing about a browse window is the viewer's own state: no seen
    // bookkeeping, no updateState write.
    updateState: false,
    onNullFeedItemsResponse: noop,
    ...(initialData
      ? {
          initialData,
          initialDataUpdatedAt: seed?.at,
          // The server's own cache refreshes on a one-minute beat; the browser
          // may keep the seed for that long before focus refreshes it.
          initialStaleTime: 60_000,
        }
      : {}),
  });

  // Every refresh of the seeded recent window keeps the initial casts on top,
  // taking each cast's fresh values when it has them. Keeping this merge in
  // place on later renders matters too: a count or context update must not
  // restore the network's order and visibly move cards after the first paint.
  const orderedFeedItems = useMemo(() => {
    if (
      boot &&
      kind === 'recent' &&
      topic === null &&
      dataUpdatedAt > boot.at
    ) {
      return mergeRefreshedPublicFeed({
        bootItems: boot.result.items,
        freshItems: feedItems,
      });
    }
    return feedItems;
  }, [boot, feedItems, dataUpdatedAt, kind, topic]);

  const castsWithContext = useMemo(
    () =>
      buildCastsWithContext(orderedFeedItems, {
        showChannelTag: (cast) => !cast.parentHash,
      }),
    [orderedFeedItems],
  );

  /**
   * The topics the surface offers: what the window is really made of.
   *
   * A channel key per cast, most-used first. Nothing is invented here and no
   * directory is asked for: a node keeps no channel list, and the hosted
   * directory cannot be read from a page. A narrowed window naturally offers
   * only its own channel, so the surface pairs these chips with a way back to
   * the whole window (`PublicBrowsePage`, the topic row).
   */
  const topics = useMemo(
    () => topicsFromCasts(orderedFeedItems.map((item) => item.cast)),
    [orderedFeedItems],
  );

  const selectKind = useCallback((next: PublicFeedKind) => {
    setKind(next);
  }, []);
  const selectTopic = useCallback((next: string | null) => {
    setTopic(next);
  }, []);

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    kind,
    topic,
    selectKind,
    selectTopic,
    feedType,
    topics,
    castsWithContext,
    isLoading,
    isError,
    errorMessage: isError
      ? error instanceof Error && error.message.length > 0
        ? error.message
        : 'The window could not be read.'
      : null,
    isFetching,
    isEmpty: !isLoading && !isError && castsWithContext.length === 0,
    onEndReached,
    isFetchingNextPage,
    hasNextPage: hasNextPage ?? false,
    retry,
  };
};
