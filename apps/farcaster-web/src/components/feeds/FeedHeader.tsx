import { ApiDefaultFeedPreference } from 'farcaster-client-data';
import { FC, memo, useMemo } from 'react';

import { Link } from '~/components/links/Link';
import { LinkToHomeFeed } from '~/components/links/LinkToHomeFeed';
import { Tab } from '~/components/tabs/Tab';
import { Tabs } from '~/components/tabs/Tabs';
import { routes } from '~/constants/routes';
import { useHomeLastSelectedTab } from '~/contexts/HomeLastSelectedTabProvider';
import { useIsCurrentRoute } from '~/hooks/navigation/useIsCurrentRoute';
import { FeedTab } from '~/types';

export const FOLLOWING_CHANNEL_KEY = 'following';

type FeedHeaderProps = {
  defaultFeedTab: ApiDefaultFeedPreference;
  tab: FeedTab;
};

const FeedHeader: FC<FeedHeaderProps> = memo(({ defaultFeedTab, tab }) => {
  const { setFeedKey } = useHomeLastSelectedTab();
  // The People tab is a page, not a feed key: its route says when it is the
  // one on screen, because the feed itself has no "people" state to read.
  const onPeopleToFollow = useIsCurrentRoute({
    path: routes.peopleToFollow.path,
  });

  const tabs = useMemo(() => {
    if (defaultFeedTab === 'following') {
      return [
        <LinkToHomeFeed
          key="following"
          title={'Following'}
          className="flex size-full items-center justify-center text-inherit"
          onClick={() => {
            setFeedKey({ feedKey: 'following' });
          }}
        >
          <Tab isFocused={tab === 'following'}>Following</Tab>
        </LinkToHomeFeed>,
        <LinkToHomeFeed
          key="home"
          title={'Home'}
          className="flex size-full items-center justify-center text-inherit"
          onClick={() => {
            setFeedKey({ feedKey: 'home' });
          }}
        >
          <Tab isFocused={tab === 'home'}>Home</Tab>
        </LinkToHomeFeed>,
        <Link
          key="people"
          title="People to follow"
          to="peopleToFollow"
          params={{}}
          searchParams={{}}
          className="flex size-full items-center justify-center text-inherit"
        >
          <Tab isFocused={onPeopleToFollow}>People</Tab>
        </Link>,
      ];
    }

    return [
      <LinkToHomeFeed
        key="home"
        title={'Home'}
        className="flex size-full items-center justify-center text-inherit"
        onClick={() => {
          setFeedKey({ feedKey: 'home' });
        }}
      >
        <Tab isFocused={tab === 'home'}>Home</Tab>
      </LinkToHomeFeed>,
      <LinkToHomeFeed
        key="following"
        title={'Following'}
        className="flex size-full items-center justify-center text-inherit"
        onClick={() => {
          setFeedKey({ feedKey: 'following' });
        }}
      >
        <Tab isFocused={tab === 'following'}>Following</Tab>
      </LinkToHomeFeed>,
      <Link
        key="people"
        title="People to follow"
        to="peopleToFollow"
        params={{}}
        searchParams={{}}
        className="flex size-full items-center justify-center text-inherit"
      >
        <Tab isFocused={onPeopleToFollow}>People</Tab>
      </Link>,
    ];
  }, [defaultFeedTab, setFeedKey, tab, onPeopleToFollow]);

  return <Tabs>{tabs.map((Tab) => Tab)}</Tabs>;
});

FeedHeader.displayName = 'FeedHeader';

export { FeedHeader };
