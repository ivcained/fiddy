/**
 * Phone chrome: the Fiddy four, on a bottom tab bar.
 *
 * The design's mobile variant moves the agent out of the nav and into a tab,
 * and keeps the node pill up in the top bar (MobileHeader already carries it).
 * Everything the fork exposed elsewhere stays reachable through MobileHeader's
 * menu — this bar is the four surfaces the client is actually about.
 */

import { GearIcon } from '@primer/octicons-react';
import { Bot, HomeIcon, Wallet } from 'lucide-react';
import { FC, memo, ReactNode } from 'react';
// eslint-disable-next-line no-restricted-imports
import { Link as RouterLink, useLocation } from 'react-router-dom';

import { routes } from '~/constants/routes';
import { hydratePath } from '~/utils/navUtils';

type Tab = {
  href: string;
  icon: ReactNode;
  label: string;
};

const FiddyMobileTabBar: FC = memo(() => {
  const location = useLocation();

  const tabs: Tab[] = [
    {
      href: hydratePath({
        path: routes.homeFeed.path,
        params: {},
        searchParams: undefined,
      }),
      icon: <HomeIcon size={22} />,
      label: 'Feed',
    },
    {
      href: hydratePath({
        path: routes.agent.path,
        params: {},
        searchParams: undefined,
      }),
      icon: <Bot size={22} />,
      label: 'Agent',
    },
    {
      href: hydratePath({
        path: routes.wallet.path,
        params: {},
        searchParams: undefined,
      }),
      icon: <Wallet size={22} />,
      label: 'Wallet',
    },
    {
      href: hydratePath({
        path: routes.settings.path,
        params: {},
        searchParams: undefined,
      }),
      icon: <GearIcon size={20} />,
      label: 'Settings',
    },
  ];

  return (
    <nav
      className="fiddy-tabs fixed inset-x-0 bottom-0 z-50 sm:hidden"
      data-fiddy="mobile-tabs"
      aria-label="Primary"
    >
      {tabs.map((tab) => {
        const isCurrent =
          location.pathname === tab.href.split('?')[0] ||
          location.pathname.startsWith(tab.href.split('?')[0] + '/');
        return (
          <RouterLink
            key={tab.label}
            to={tab.href}
            title={tab.label}
            className="fiddy-tab"
            aria-current={isCurrent ? 'page' : undefined}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </RouterLink>
        );
      })}
    </nav>
  );
});

FiddyMobileTabBar.displayName = 'FiddyMobileTabBar';

export { FiddyMobileTabBar };
