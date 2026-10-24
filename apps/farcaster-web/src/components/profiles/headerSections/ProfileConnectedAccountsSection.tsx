import { AnalyticsEvent } from 'farcaster-analytics';
import { ApiUser } from 'farcaster-client-data';
import { useConnectedAccounts } from 'farcaster-client-hooks';
import React from 'react';

import { LinkedAccountRow } from '~/components/accounts/LinkedAccountRow';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';

type ProfileConnectedAccountsSectionProps = {
  user: ApiUser;
};

/**
 * The accounts linked to a Farcaster account, on the profile header.
 *
 * WHERE THE ROWS COME FROM, AND WHY THEY ARE READ-ONLY
 *
 * A linked X (or GitHub, Discord, LinkedIn) account is account state rather than
 * a protocol message, so a read node keeps none of it: the read is answered by
 * the index that mirrors it (`~/snapchain/providers/neynarMap`, the route
 * classified in `~/snapchain/nodeApi/hostedRoutes`).
 *
 * MEASURED on the live release before this change (2026-10-24): the read was
 * refused, and the refusal — “the accounts linked to your Farcaster account are
 * Warpcast account state” — took the WHOLE profile page down, because this
 * section throws inside the page's error boundary. Every row here used to be a
 * dead control too: linking an account is the holding service's own sign-in and
 * unlinking happens where the link is held, so pressing either did nothing at
 * all. A control that cannot work is worse than no control, so the row says what
 * IS linked and points at the account itself.
 *
 * Nothing linked is nothing shown: an empty chip reading “Connect” would be both
 * a claim this client cannot stand behind and an action it cannot take.
 */
const ProfileConnectedAccountsSection: React.FC<
  ProfileConnectedAccountsSectionProps
> = ({ user }) => {
  const { fid: currentUserFid } = useCurrentUser();

  return (
    <React.Suspense fallback={<div className="h-[28px]" />}>
      {currentUserFid === user.fid ? (
        <ViewerConnectedAccounts />
      ) : (
        <ConnectedAccounts user={user} />
      )}
    </React.Suspense>
  );
};

ProfileConnectedAccountsSection.displayName = 'ProfileConnectedAccountsSection';

/** The viewer's own row(s): what the index mirrors for the signed-in account. */
const ViewerConnectedAccounts: React.FC = () => {
  const { trackEvent } = useAnalytics();
  const { data } = useConnectedAccounts();

  const connectedAccounts = React.useMemo(
    () => data!.pages.flatMap((o) => o.result.accounts),
    [data],
  );

  if (connectedAccounts.length === 0) {
    return null;
  }

  return (
    <>
      {connectedAccounts.map((account) => (
        <LinkedAccountRow
          key={account.connectedAccountId}
          account={account}
          onPress={() => {
            // The fork's own event, and only for the platform it is about.
            if (account.platform === 'x') {
              trackEvent(AnalyticsEvent.PressUserProfileXAccount, {});
            }
          }}
        />
      ))}
    </>
  );
};

ViewerConnectedAccounts.displayName = 'ViewerConnectedAccounts';

/**
 * Someone else's row(s): the links the profile read itself carried.
 *
 * This is the fork's own field (`ApiUser.connectedAccounts`), which the index
 * fills for the accounts it mirrors (`apiUserFromNeynar`), so what a reader sees
 * on another account is what the index says about THAT account rather than a row
 * derived from the viewer's own.
 */
const ConnectedAccounts: React.FC<ProfileConnectedAccountsSectionProps> = ({
  user,
}) => {
  const { trackEvent } = useAnalytics();

  const connectedAccounts = React.useMemo(() => {
    return user.connectedAccounts || [];
  }, [user.connectedAccounts]);

  if (connectedAccounts.length === 0) {
    return null;
  }

  return (
    <>
      {connectedAccounts.map((account) => (
        <LinkedAccountRow
          key={account.connectedAccountId}
          account={account}
          onPress={() => {
            if (account.platform === 'x') {
              trackEvent(AnalyticsEvent.PressUserProfileXAccount, {});
            }
          }}
        />
      ))}
    </>
  );
};

ConnectedAccounts.displayName = 'ConnectedAccounts';

export { ProfileConnectedAccountsSection };
