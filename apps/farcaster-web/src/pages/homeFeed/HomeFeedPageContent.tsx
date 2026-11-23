import { AnalyticsEvent } from 'farcaster-analytics';
import {
  useChannelFeedUnseenStatus,
  useFeedItems,
  useRefreshFeedItemsFirstPage,
  useSetFeedItemsAsSeenIfPrefetched,
  useTrackEvent,
} from 'farcaster-client-hooks';
import { FC, memo, useCallback, useMemo } from 'react';

import { Cast } from '~/components/casts/Cast';
import { DefaultEmptyListView } from '~/components/lists/DefaultEmptyListView';
import { FlatList } from '~/components/lists/FlatList';
import { NewPostsPill } from '~/components/pill/NewPostsPill';
import { HomeFeaturePromotion } from '~/components/promotions/HomeFeaturePromotion';
import { useCameFromPopped } from '~/contexts/PopStateProvider';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { useSetOnCurrentNavLinkClicked } from '~/hooks/data/useSetOnCurrentNavLinkClicked';
import { useScrollToTopOfRoot } from '~/hooks/useScrollToTopOfRoot';
import { buildCastsWithContext } from '~/utils/castUtils';
import { castWithContextKeyExtractor } from '~/utils/keyExtractorUtils';

// Reserved for admin-only feed experiments; do not remove when empty.
const adminGatedFeedCastIncludeReasonTypes = new Set<string>();

const HomeFeedPageContent: FC = memo(() => {
  const wasPopped = useCameFromPopped();

  const onNullFeedItemsResponse = useCallback(() => {
    // FIXME: Fill this out if we notice issues on web clients similar to Web
  }, []);

  const { feedItems, onEndReached, isFetchingNextPage, refetch } = useFeedItems(
    {
      feedKey: 'home',
      feedType: 'default',
      updateState: true,
      purgeToFirstPageOnMount: !wasPopped,
      onNullFeedItemsResponse: onNullFeedItemsResponse,
    },
  );

  const castsWithContext = useMemo(
    () =>
      buildCastsWithContext(feedItems, {
        showChannelTag: (cast) => !cast.parentHash,
      }),
    [feedItems],
  );

  useSetFeedItemsAsSeenIfPrefetched({ feedKey: 'home', feedType: 'default' });

  const isSignedIn = useIsSignedIn();

  const scrollToTopOfRoot = useScrollToTopOfRoot();

  const refreshFirstPage = useRefreshFeedItemsFirstPage(
    'home',
    'default',
    refetch,
  );
  useSetOnCurrentNavLinkClicked(refreshFirstPage);

  const { trackEvent } = useTrackEvent();

  const hasNewItems = useChannelFeedUnseenStatus('home', true);

  const scrollToTopAndReloadFeed = useCallback(async () => {
    scrollToTopOfRoot(true);

    trackEvent(AnalyticsEvent.ClickNewCastsToast, {});

    refreshFirstPage();
  }, [refreshFirstPage, scrollToTopOfRoot, trackEvent]);

  const renderHomeFeedItem = useCallback(
    ({ item }: { item: (typeof castsWithContext)[number] }) => {
      return (
        <Cast
          castWithContext={item}
          isAdminGatedFeedCast={
            typeof item.context.includeReason?.type !== 'undefined' &&
            adminGatedFeedCastIncludeReasonTypes.has(
              item.context.includeReason.type,
            )
          }
        />
      );
    },
    [],
  );

  return (
    <>
      {isSignedIn && (
        <NewPostsPill
          hasNewItems={hasNewItems}
          onClick={scrollToTopAndReloadFeed}
        />
      )}
      {isSignedIn && <HomeFeaturePromotion />}
      <FlatList
        data={castsWithContext}
        emptyView={<DefaultEmptyListView message="Your feed is empty" />}
        renderItem={renderHomeFeedItem}
        keyExtractor={castWithContextKeyExtractor}
        onEndReached={onEndReached}
        isFetchingNextPage={isFetchingNextPage}
      />
    </>
  );
});

HomeFeedPageContent.displayName = 'HomeFeedPageContent';

export { HomeFeedPageContent };
