import { GearIcon } from '@primer/octicons-react';
import { useUnseen } from 'farcaster-client-hooks';
import {
  Archive,
  BellIcon,
  CodeIcon,
  Grid3X3Icon,
  HomeIcon,
  Megaphone,
  Mic,
  Send,
  UserPlusIcon,
} from 'lucide-react';
import React from 'react';

import { AvatarImage } from '~/components/avatar/AvatarImage';
import { NavLink } from '~/components/links/NavLink';
import { NavLinkBadge } from '~/components/links/NavLinkBadge';
import { NavLinkIcon } from '~/components/links/NavLinkIcon';
import { NavLinkLabel } from '~/components/links/NavLinkLabel';
import { ChannelNavLinks } from '~/components/sidebar/ChannelNavLinks';
import { useUserAppContext } from '~/contexts/UserAppContextProvider';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useCurrentUserProfileCastsLinkProps } from '~/hooks/navigation/useCurrentUserProfileCastsLinkProps';
import { LeftSideBar } from '~/layouts/LeftSideBar';
import { LeftSideBarLogo } from '~/layouts/LeftSideBarLogo';

const AuthedLeftSideBar: React.FC = React.memo(() => {
  const { notificationsCount, inboxCount, channelFeedsUnseenStatus } =
    useUnseen();
  const { developerModeEnabled } = useUserAppContext();
  const currentUser = useCurrentUser();

  const currentUserProfileCastsLinkProps = useCurrentUserProfileCastsLinkProps({
    title: 'Profile',
  });
  const updatesUnseenCount = channelFeedsUnseenStatus?.['fc-updates']
    ?.hasNewItems
    ? 1
    : 0;

  return (
    <LeftSideBar className="justify-between pb-4">
      <div className="flex grow flex-col space-y-1 xl:w-full">
        <div className="flex flex-row items-center justify-center xl:justify-between">
          <div className="block">
            <LeftSideBarLogo title="Recommended feed" />
          </div>
        </div>
        <NavLink to="homeFeed" params={{}} searchParams={{}} title="Home">
          <NavLinkIcon>
            <div className="-translate-y-px">
              <HomeIcon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Home</NavLinkLabel>
        </NavLink>
        <NavLink
          to="notifications"
          params={{}}
          searchParams={{}}
          title="Notifications"
        >
          <NavLinkIcon>
            <div className="relative translate-y-[-1.25px]">
              <BellIcon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Notifications</NavLinkLabel>
          <NavLinkBadge count={notificationsCount} subtle={false} />
        </NavLink>
        <NavLink
          to="spacesDiscovery"
          params={{}}
          searchParams={{}}
          title="Spaces"
        >
          <NavLinkIcon>
            <div className="relative translate-y-[-1.25px]">
              <Mic size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Spaces</NavLinkLabel>
        </NavLink>
        <NavLink to="discover" params={{}} searchParams={{}} title="Apps">
          <NavLinkIcon>
            <div className="relative translate-y-[-1.25px]">
              <Grid3X3Icon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Apps</NavLinkLabel>
          {/* <NavLinkBadge count={notificationsCount} subtle={false} /> */}
        </NavLink>
        <NavLink
          to="directCastsInbox"
          params={{}}
          searchParams={{}}
          title="Inbox"
        >
          <NavLinkIcon>
            <div className="translate-y-[-0.5px]">
              <Send size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Direct Casts</NavLinkLabel>
          <NavLinkBadge className="ml-4" count={inboxCount} subtle={false} />
        </NavLink>
        <NavLink
          to={'referrals'}
          params={{}}
          searchParams={{}}
          title="Referrals"
        >
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <UserPlusIcon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Referrals</NavLinkLabel>
        </NavLink>
        <NavLink to={'saved'} params={{}} searchParams={{}} title="Saved">
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <Archive size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Saved</NavLinkLabel>
        </NavLink>
        <NavLink to={'agent'} params={{}} searchParams={{}} title="Agent">
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
                <circle cx="7.5" cy="14.5" r="1.5" />
                <circle cx="16.5" cy="14.5" r="1.5" />
              </svg>
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Agent</NavLinkLabel>
        </NavLink>
        <NavLink to="settings" params={{}} searchParams={{}} title="Settings">
          <NavLinkIcon>
            <GearIcon size={20} />
          </NavLinkIcon>
          <NavLinkLabel>Settings</NavLinkLabel>
        </NavLink>
        {developerModeEnabled && (
          <NavLink
            to={'developers'}
            params={{}}
            searchParams={{}}
            title="Developers"
          >
            <NavLinkIcon>
              <div className="relative translate-y-[-0.95px]">
                <CodeIcon size={20} />
              </div>
            </NavLinkIcon>
            <NavLinkLabel>Developers</NavLinkLabel>
          </NavLink>
        )}
        <NavLink
          to="channel"
          params={{ channelKey: 'fc-updates' }}
          searchParams={{}}
          title="Updates"
        >
          <NavLinkIcon>
            <div className="translate-y-[-1.25px]">
              <Megaphone size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Updates</NavLinkLabel>
          <NavLinkBadge count={updatesUnseenCount} subtle={false} />
        </NavLink>
        <NavLink {...currentUserProfileCastsLinkProps}>
          <NavLinkIcon>
            <div className="translate-y-[-1.25px]">
              <AvatarImage
                imgUrl={currentUser.pfp?.url}
                imgAlt={currentUser.displayName || currentUser.username || ''}
                size="xs"
                className="hover:bg-transparent"
              />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Profile</NavLinkLabel>
        </NavLink>
        <div className="hidden xl:contents">
          <ChannelNavLinks />
        </div>
      </div>
    </LeftSideBar>
  );
});

AuthedLeftSideBar.displayName = 'AuthedLeftSideBar';

export { AuthedLeftSideBar };
