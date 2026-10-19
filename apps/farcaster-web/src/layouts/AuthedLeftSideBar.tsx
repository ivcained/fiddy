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
  Server,
  UserPlusIcon,
  Wallet,
} from 'lucide-react';
import React from 'react';

import { AgentNavEntry } from '~/components/agent/AgentNavItem';
import { AvatarImage } from '~/components/avatar/AvatarImage';
import { NavLink } from '~/components/links/NavLink';
import { NavLinkBadge } from '~/components/links/NavLinkBadge';
import { NavLinkIcon } from '~/components/links/NavLinkIcon';
import { NavLinkLabel } from '~/components/links/NavLinkLabel';
import { ChannelNavLinks } from '~/components/sidebar/ChannelNavLinks';
import { NodeStatusPill } from '~/components/snapchain/NodeStatusPill';
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
    <LeftSideBar asideClassName="fiddy-nav" className="justify-between pb-4">
      <div className="flex grow flex-col space-y-1 xl:w-full">
        <div className="flex flex-row items-center justify-center xl:justify-between">
          <div className="block">
            <LeftSideBarLogo title="Recommended feed" />
          </div>
        </div>
        {/* Whose node answered is persistent chrome, not a settings detail:
            the collapsed (icon-only) sidebar keeps the dot, the wide one adds
            the words. */}
        <div className="my-2 flex flex-row items-center justify-center xl:justify-start">
          <NodeStatusPill
            short
            labelClassName="hidden xl:inline"
            className="xl:px-2.5"
          />
        </div>
        {/* The four surfaces Fiddy is actually about, first — then everything
            else the fork exposes, so nothing becomes unreachable. */}
        <NavLink to="homeFeed" params={{}} searchParams={{}} title="Feed">
          <NavLinkIcon>
            <div className="-translate-y-px">
              <HomeIcon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Feed</NavLinkLabel>
        </NavLink>
        <AgentNavEntry />
        {/* The wallet is a real surface in this build, so it is a real entry —
            no "soon" tag where something actually works. */}
        <NavLink to="wallet" params={{}} searchParams={{}} title="Wallet">
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <Wallet size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Wallet</NavLinkLabel>
        </NavLink>
        <NavLink to="settings" params={{}} searchParams={{}} title="Settings">
          <NavLinkIcon>
            <GearIcon size={20} />
          </NavLinkIcon>
          <NavLinkLabel>Settings</NavLinkLabel>
        </NavLink>
        <div className="fiddy-nav-caption">More</div>
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
        {/* Your own node is a first-class surface, not a buried settings page:
            the status pill and this entry land on the same place. */}
        <NavLink
          to="settingsNode"
          params={{}}
          searchParams={{}}
          title="Your node"
        >
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <Server size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Your node</NavLinkLabel>
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
