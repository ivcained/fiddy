import { useQuery } from '@tanstack/react-query';
import { type ApiConnectedAccount } from 'farcaster-client-data';
import { useFarcasterApiClient } from 'farcaster-client-hooks';

import {
  asSentence,
  nodeCannotAnswer,
} from '~/snapchain/nodeApi/nodeCannotAnswer';

/**
 * The accounts linked to the signed-in Farcaster account, read without suspense.
 *
 * WHY NOT `useConnectedAccounts`. That hook is the fork's own (a suspense
 * infinite query), and a surface that renders OUTSIDE a suspense boundary — the
 * setup page's cards — cannot call it: a read that refuses would throw past its
 * own card and take the whole page down, which is exactly the failure this read
 * was fixed for on the profile. Here the answer is a state, so a card can say
 * what happened in place and the rest of the page stands.
 *
 * The key is this hook's own (`['fiddy','linked-accounts']`) rather than the
 * fork's, deliberately: that key is an infinite query's cache entry
 * (`{pages, pageParams}`) and two shapes must never share one key.
 *
 * A refusal is not a failure here: the seam's own sentence is the honest answer
 * (see `nodeCannotAnswer`), and 502 (the index was asked and did not answer) is
 * the only retryable one.
 */
export type LinkedAccountsRead =
  | { status: 'loading' }
  | { status: 'ready'; accounts: ApiConnectedAccount[] }
  | { status: 'refused'; message: string; retryable: boolean }
  | { status: 'failed' };

export const useLinkedAccounts = (): LinkedAccountsRead => {
  const { apiClient } = useFarcasterApiClient();

  const query = useQuery({
    queryKey: ['fiddy', 'linked-accounts'],
    queryFn: async () =>
      (await apiClient.getConnectedAccounts({ limit: 25 })).data,
    // A refusal is a fact about the read rather than a flake, so it is not
    // retried: the sentence the seam wrote is what the reader needs to see.
    retry: false,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return { status: 'loading' };
  }

  if (query.data) {
    return { status: 'ready', accounts: query.data.result.accounts };
  }

  const refusal = nodeCannotAnswer(query.error);
  if (refusal) {
    return {
      status: 'refused',
      message: asSentence(refusal.message),
      retryable: refusal.retryable,
    };
  }

  return { status: 'failed' };
};
