import { useQueryClient } from '@tanstack/react-query';
import React, { memo, useCallback } from 'react';

import { LinkedAccountRow } from '~/components/accounts/LinkedAccountRow';
import { useLinkedAccounts } from '~/hooks/data/useLinkedAccounts';

/**
 * Which accounts are linked to this Farcaster account, read from a real source.
 *
 * WHY THIS CARD EXISTS AT ALL. Report (2026-10-24): the setup page came back
 * with “The accounts linked to your Farcaster account are Warpcast account
 * state” — a refusal that was TRUE of the old source and useless to the reader.
 * The read is really answerable: an X / GitHub / Discord / LinkedIn link is
 * account state, the index this client already reaches mirrors it (MEASURED
 * 2026-10-24: `user/bulk?fids=3` answers `verified_accounts`), and a read node
 * keeps none of it because a link is not a protocol message. So the card reads
 * it and shows it, and changing a link stays where the link is held.
 *
 * WHAT IT REFUSES. It never invents a row and never says “nothing is linked”
 * when the read did not come back: an empty list from the index is a fact, a
 * refusal is a fact, and each is said in its own words in place. A retry is
 * offered only for the one failure a retry can change (the index was asked and
 * did not answer).
 */
const LinkedAccountsCard: React.FC = memo(() => {
  const read = useLinkedAccounts();
  const queryClient = useQueryClient();

  const onRetry = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['fiddy', 'linked-accounts'],
    });
  }, [queryClient]);

  const body = () => {
    switch (read.status) {
      case 'loading':
        return <div className="text-xs text-muted">Checking the index…</div>;
      case 'ready':
        return read.accounts.length === 0 ? (
          <div className="text-xs text-muted">
            No account is linked to this one as far as the index can tell.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {read.accounts.map((account) => (
              <LinkedAccountRow
                key={account.connectedAccountId}
                account={account}
              />
            ))}
          </div>
        );
      case 'refused':
        return (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-muted">{read.message}</div>
            {read.retryable ? (
              <button
                type="button"
                className="fiddy-quiet-btn fiddy-quiet-btn-outline w-max"
                onClick={onRetry}
              >
                Try again
              </button>
            ) : null}
          </div>
        );
      case 'failed':
      default:
        return (
          <div className="text-xs text-muted">
            This read did not come back. Nothing was invented to fill it in.
          </div>
        );
    }
  };

  return (
    <div
      className="solid-glass-pane rounded-lg border p-4 border-default"
      data-fiddy="linked-accounts"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-primary">
          Accounts linked to you
        </span>
        <span className="text-xs text-muted">read from Neynar’s index</span>
      </div>
      <p className="mb-3 text-xs text-muted">
        The X, GitHub, Discord and LinkedIn accounts linked to your Farcaster
        account. Fiddy reads them from the index that mirrors them; adding or
        removing a link is done on the service that holds it, so nothing here
        offers to do it.
      </p>
      {body()}
    </div>
  );
});

LinkedAccountsCard.displayName = 'LinkedAccountsCard';

export { LinkedAccountsCard };
