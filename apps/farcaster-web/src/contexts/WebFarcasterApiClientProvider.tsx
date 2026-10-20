import {
  FarcasterApiClient,
  FarcasterApiClientMetaOptions,
  OnError,
  OnFetchStart,
} from 'farcaster-client-data';
import {
  FarcasterApiClientProvider,
  useCachedOnboardingState,
} from 'farcaster-client-hooks';
import React, {
  FC,
  memo,
  ReactNode,
  useCallback,
  useMemo,
  useRef,
} from 'react';

import { baseApiUrl, localApiEnabled, wsUrl } from '~/constants/api';
import { isDev } from '~/constants/env';
import { useRecentFetch } from '~/contexts/RecentFetchProvider';
import { resolveEffectiveNodeBaseUrl } from '~/snapchain/nodeChoice';
import {
  createNodeBackedFetch,
  isNodeBackedClientEnabled,
} from '~/snapchain/nodeApi';
import { useNodeChoice } from '~/snapchain/useNodeChoice';
import { Analytics } from '~/utils/analyticsUtils';
import { getPersistedDeviceId } from '~/utils/deviceIdUtils';

import { authOnError401Ref } from './authOnError401Ref';

const apiDebugEnabled = false;

type WebFarcasterApiClientProviderProps = {
  children: ReactNode;
};

const apiClient = new FarcasterApiClient();

const WebFarcasterApiClientProvider: FC<WebFarcasterApiClientProviderProps> =
  memo(({ children }) => {
    const { trackFetch } = useRecentFetch();

    // deviceId → FC-DEVICE-ID header. The backend's one-token-per-device
    // dedup keys on it; without it every web mint takes the noDeviceId path
    // and accumulates in auth-tokens:{fid} (see deviceIdUtils).
    const meta = useMemo(
      (): FarcasterApiClientMetaOptions => ({
        deviceId: getPersistedDeviceId(),
      }),
      [],
    );

    // Who the node-backed reads are about. The cached onboarding state is the
    // same source the shell renders the signed-in account from, and it never
    // fetches — which matters, because this has to answer synchronously inside
    // the client's requests, including the ones that run while the network is
    // what is broken.
    const signedInFid = useCachedOnboardingState().result.state.user?.fid;
    const signedInFidRef = useRef<number | undefined>(signedInFid);
    signedInFidRef.current = signedInFid;

    // The server this reader chose (a public one, or their own) is restored
    // here, once, and every node-backed surface below reads it from the same
    // store — the reads adapter, the writes client and the status pill can
    // never disagree about where answers came from.
    const nodeChoice = useNodeChoice(signedInFid);

    /**
     * The node-backed read adapter.
     *
     * It replaces the hosted API as the client's data source: same `fetch`
     * signature, same request paths, answers read from the configured
     * Snapchain node instead of from `farcaster.xyz`. See
     * `~/snapchain/nodeApi` for what is node-backed, what is local, and what
     * the node genuinely cannot answer.
     *
     * Not installed when the fork's mock API is on (`farcasterApi.local`):
     * that switch exists to serve the shell from a mock, and quietly rerouting
     * it to the node would make the mock lie about what it is showing.
     */
    const nodeBackedFetch = useMemo(() => {
      if (localApiEnabled || !isNodeBackedClientEnabled()) {
        return undefined;
      }
      return createNodeBackedFetch({
        nodeBaseUrl: resolveEffectiveNodeBaseUrl(),
        getSignedInFid: () => signedInFidRef.current,
        fetchImpl: fetch,
      }).fetch;
      // The address is the only input that can change under a running tab, and
      // it has to rebuild the adapter: the alternative is a feed read from a
      // server the reader has already replaced.
    }, [nodeChoice]);

    const onFetchStart: OnFetchStart = useCallback(() => {
      trackFetch();
    }, [trackFetch]);

    // Single apiClient.onError owner. Delegate 401s to AuthProvider's
    // revalidation handler (registered via authOnError401Ref) so we probe
    // /v2/me before signing out, instead of tearing the session down on any
    // transient 401. Recovery/re-entry/stale-token guards live in that handler.
    const onError: OnError = useCallback(({ requestInfo, responseStatus }) => {
      if (responseStatus !== 401) {
        return;
      }
      // Don't loop on the deleteAuthToken call that sign-out makes.
      if (requestInfo.endpointName === 'deleteAuthToken') {
        return;
      }
      void authOnError401Ref.current?.({
        source: 'global_handler',
        endpointName: requestInfo.endpointName,
        responseStatus,
      });
    }, []);

    return (
      <FarcasterApiClientProvider
        apiClient={apiClient}
        address={undefined}
        baseUrl={baseApiUrl}
        wsUrl={wsUrl}
        debug={isDev && apiDebugEnabled}
        meta={meta}
        onError={onError}
        onFetchStart={onFetchStart}
        fetch={nodeBackedFetch ?? fetch}
        getDeviceId={Analytics.getDeviceId}
        getSessionId={Analytics.getSessionId}
      >
        {children}
      </FarcasterApiClientProvider>
    );
  });

WebFarcasterApiClientProvider.displayName = 'WebFarcasterApiClientProvider';

export { WebFarcasterApiClientProvider };
