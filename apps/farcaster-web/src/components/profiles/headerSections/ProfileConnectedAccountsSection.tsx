import { AnalyticsEvent } from 'farcaster-analytics';
import { ApiUser } from 'farcaster-client-data';
import { useConnectedAccounts, useGetXAuthLink } from 'farcaster-client-hooks';
import React from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { ExternalLink } from '~/components/links/ExternalLink';
import { ProfileManageConnectedAccountsModal } from '~/components/profiles/ProfileManageConnectedAccountsModal';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useExternalNavigate } from '~/hooks/navigation/useExternalNavigate';
import { nodeCannotAnswer } from '~/snapchain/nodeApi/nodeCannotAnswer';

type ProfileConnectedAccountsSectionProps = {
  user: ApiUser;
};

/**
 * A section that can only refuse, kept from taking the page down with it.
 *
 * The own-profile branch reads the viewer's linked accounts with a suspense
 * query (`useConnectedAccounts` → GET /v2/connected-accounts), and this
 * client's provider seam classifies that endpoint as hosted — linked accounts
 * are Warpcast account state, not protocol messages — so the query ALWAYS
 * answers 501, whatever key the build carries. A suspense query's thrown
 * error is NOT held by the section's own `<Suspense>` (a suspense boundary
 * only catches suspended promises): it unwinds to the page column's
 * `ShellSectionErrorBoundary` ("This page"), which replaces the WHOLE profile
 * — header, tabs, casts — with the refusal panel. MEASURED on t_c64a428d: a
 * signed-in user's own profile rendered only that panel and the header never
 * painted.
 *
 * The refusal is not retryable and this client cannot serve the section at
 * all, so on a refusal it degrades to nothing — the same shape the section
 * renders on any profile that holds no linked account. Any error that is NOT
 * the adapter's refusal is rethrown, so the page boundary still handles
 * unexpected failures loudly.
 */
const RefusalContained: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <ErrorBoundary
    fallbackRender={({ error }) => {
      if (nodeCannotAnswer(error) === undefined) {
        throw error;
      }
      return null;
    }}
  >
    {children}
  </ErrorBoundary>
);

const ProfileConnectedAccountsSection: React.FC<
  ProfileConnectedAccountsSectionProps
> = ({ user }) => {
  const { fid: currentUserFid } = useCurrentUser();

  return (
    <RefusalContained>
      <React.Suspense fallback={<div className="h-[28px]" />}>
        {currentUserFid === user.fid ? (
          <ConnectedAccountsSelf user={user} />
        ) : (
          <ConnectedAccounts user={user} />
        )}
      </React.Suspense>
    </RefusalContained>
  );
};

ProfileConnectedAccountsSection.displayName = 'ProfileConnectedAccountsSection';

const ConnectedAccountsSelf: React.FC<ProfileConnectedAccountsSectionProps> = ({
  user: _,
}) => {
  const { trackEvent } = useAnalytics();

  const [
    manageConnectedAccountsModalVisible,
    setManageConnectedAccountsModalVisible,
  ] = React.useState(false);

  const { data } = useConnectedAccounts();

  const getXAuthLink = useGetXAuthLink();

  const connectedAccounts = React.useMemo(() => {
    return data!.pages.flatMap((o) => o.result.accounts);
  }, [data]);

  const connectedXAccount = React.useMemo(() => {
    return connectedAccounts.find(({ platform }) => platform === 'x');
  }, [connectedAccounts]);

  const externalNavigate = useExternalNavigate();

  const onConnectClick = React.useCallback(
    async (e: React.SyntheticEvent) => {
      e.preventDefault();

      trackEvent(AnalyticsEvent.SendUserToXToAuth, {
        via: 'user profile',
      });

      const { result } = await getXAuthLink();

      externalNavigate({ to: result.url, openInNewTab: true });
    },
    [getXAuthLink, externalNavigate, trackEvent],
  );

  const onAlreadyConnectedClick = React.useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();

      if (typeof connectedXAccount === 'undefined') {
        return;
      }

      setManageConnectedAccountsModalVisible(true);
    },
    [connectedXAccount],
  );

  const content = React.useMemo(() => {
    if (typeof connectedXAccount === 'undefined') {
      return (
        <div
          className="flex w-max flex-row items-center space-x-1 rounded-full border px-[6px] py-[3px] text-sm text-muted bg-elevated border-default hover:cursor-pointer"
          onClick={onConnectClick}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="text-muted"
          >
            <path
              d="M10.6489 1.33008H12.5761L8.34476 6.14791L13.2883 12.6834H9.40887L6.37154 8.71184L2.89432 12.6834H0.967186L5.44987 7.53042L0.71582 1.33008H4.69158L7.43565 4.95812L10.6489 1.33008ZM9.97444 11.5523H11.0427L4.1302 2.41933H2.9823L9.97444 11.5523Z"
              className="fill-current"
            />
          </svg>
          <div>Connect</div>
        </div>
      );
    }

    return (
      <div
        className="flex w-max flex-row items-center space-x-1 rounded-full px-[6px] py-[3px] text-sm text-muted bg-elevated hover:cursor-pointer"
        onClick={onAlreadyConnectedClick}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="text-muted"
        >
          <path
            d="M10.6489 1.33008H12.5761L8.34476 6.14791L13.2883 12.6834H9.40887L6.37154 8.71184L2.89432 12.6834H0.967186L5.44987 7.53042L0.71582 1.33008H4.69158L7.43565 4.95812L10.6489 1.33008ZM9.97444 11.5523H11.0427L4.1302 2.41933H2.9823L9.97444 11.5523Z"
            className="fill-current"
          />
        </svg>
        <div>{connectedXAccount.username}</div>
      </div>
    );
  }, [connectedXAccount, onAlreadyConnectedClick, onConnectClick]);

  return (
    <>
      {content}
      {manageConnectedAccountsModalVisible && (
        <ProfileManageConnectedAccountsModal
          onClose={() => {
            setManageConnectedAccountsModalVisible(false);
          }}
        />
      )}
    </>
  );
};

ConnectedAccountsSelf.displayName = 'ConnectedAccountsSelf';

const ConnectedAccounts: React.FC<ProfileConnectedAccountsSectionProps> = ({
  user,
}) => {
  const { trackEvent } = useAnalytics();

  const connectedAccounts = React.useMemo(() => {
    return user.connectedAccounts || [];
  }, [user.connectedAccounts]);

  const connectedXAccount = React.useMemo(() => {
    return connectedAccounts.find(({ platform }) => platform === 'x');
  }, [connectedAccounts]);

  const onAlreadyConnectedClick = React.useCallback(() => {
    if (typeof connectedXAccount === 'undefined') {
      return;
    }

    trackEvent(AnalyticsEvent.PressUserProfileXAccount, {});
  }, [connectedXAccount, trackEvent]);

  const content = React.useMemo(() => {
    if (typeof connectedXAccount === 'undefined') {
      return null;
    }

    return (
      <ExternalLink
        className="flex w-max select-none flex-row items-center space-x-1 py-[3px] text-sm text-muted hover:cursor-pointer"
        onClick={onAlreadyConnectedClick}
        href={`https://x.com/${connectedXAccount.username}`}
        title={`https://x.com/${connectedXAccount.username}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="text-muted"
        >
          <path
            d="M10.6489 1.33008H12.5761L8.34476 6.14791L13.2883 12.6834H9.40887L6.37154 8.71184L2.89432 12.6834H0.967186L5.44987 7.53042L0.71582 1.33008H4.69158L7.43565 4.95812L10.6489 1.33008ZM9.97444 11.5523H11.0427L4.1302 2.41933H2.9823L9.97444 11.5523Z"
            className="fill-current"
          />
        </svg>
        <div>{connectedXAccount.username}</div>
      </ExternalLink>
    );
  }, [connectedXAccount, onAlreadyConnectedClick]);

  return content;
};

ConnectedAccounts.displayName = 'ConnectedAccounts';

export { ProfileConnectedAccountsSection };
