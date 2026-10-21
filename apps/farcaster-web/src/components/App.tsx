import { HelmetProvider } from '@dr.pogodin/react-helmet';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  persistQueryClient,
  PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';
import { BlockedDomainsProvider, PubSubProvider } from 'farcaster-client-hooks';
import React, { FC, ReactNode, Suspense, useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';

import { ShellSkeleton } from '~/components/fiddy/ShellSkeleton';
import { Router } from '~/components/routing/Router';
import { AnalyticsProvider } from '~/contexts/AnalyticsProvider';
import { AuthProvider, useAuth } from '~/contexts/AuthProvider';
import { DirectCastToTakeActionProvider } from '~/contexts/DirectCastToTakeActionProvider';
import { GlobalKeyPressProvider } from '~/contexts/GlobalKeyPressProvider';
import { HasUnmountedProvider } from '~/contexts/HasUnmountedProvider';
import { LinkDetailsPopoverManagerProvider } from '~/contexts/LinkDetailsPopoverManagerProvider';
import { LinkifyProvider } from '~/contexts/LinkifyProvider';
import { MiniAppProvider } from '~/contexts/MiniAppProvider';
import { MinimizableWindowProvider } from '~/contexts/MinimizableWindowProvider';
import { PersistQueryClientInstanceProvider } from '~/contexts/PersistQueryClientInstanceProvider';
import { PopStateProvider } from '~/contexts/PopStateProvider';
import { RecentFetchProvider } from '~/contexts/RecentFetchProvider';
import { ScrollProvider } from '~/contexts/ScrollProvider';
import { SolanaWalletProvider } from '~/contexts/SolanaWalletProvider';
import { StandaloneModeProvider } from '~/contexts/StandaloneModeProvider';
import { ThemeProvider } from '~/contexts/ThemeProvider';
import { UnifiedMetaMaskProvider } from '~/contexts/UnifiedMetaMaskProvider';
import { VideoPlayStatusProvider } from '~/contexts/VideoPlayStatusProvider';
import { WebFarcasterApiClientProvider } from '~/contexts/WebFarcasterApiClientProvider';
import { InteractedSnapUrlsWebProvider } from '~/providers/InteractedSnapUrlsWebProvider';
import { PrivyRoot } from '~/providers/PrivyRoot';
import { wagmiConfig } from '~/utils/wagmi';

import { FullScreenErrorBoundary } from './errors/FullScreenErrorBoundary';
import { SnapWindowErrorListenerInstaller } from './SnapWindowErrorListenerInstaller';

const AuthGatedBlockedDomainsProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { authToken } = useAuth();
  return (
    <BlockedDomainsProvider enabled={!!authToken}>
      {children}
    </BlockedDomainsProvider>
  );
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 3,
      gcTime: 1000 * 60 * 5,
    },
  },
});

const localStoragePersister = createSyncStoragePersister({
  storage: window.localStorage,
});

// This obviously busts the cache on every load but we are not built
// to handle that well for many surfaces such as threads and Direct Casts.
localStoragePersister.removeClient();

persistQueryClient({
  queryClient: queryClient,
  persister: localStoragePersister,
} as unknown as PersistQueryClientOptions);

/** The id the document gives the shell it paints before the app runs. */
const SHELL_SKELETON_ID = 'shell-skeleton';

/**
 * Hands the shell over from the document to the app.
 *
 * `index.html` carries the shell as static markup, so a reader looks at it from
 * the first paint — but it sits outside `#root`, because React clears its own
 * container before it paints anything, and a skeleton inside would be cleared
 * with it.
 *
 * It goes when the app has something to show, which is not the same moment as
 * the app's first commit: measured on a cold load, the first commit painted
 * nothing at all (an empty root for ~800 ms while the session and the route
 * resolved). So this waits for the app's first element to appear in `#root` —
 * a real surface or one of the shell's own fallbacks, which are the same shape
 * — and takes the document's copy away one painted frame later.
 */
const useShellSkeletonHandoff = () => {
  useEffect(() => {
    const skeleton = document.getElementById(SHELL_SKELETON_ID);
    const root = document.getElementById('root');
    if (!skeleton || !root) {
      return undefined;
    }

    let frame = 0;
    const handOver = () => {
      frame = requestAnimationFrame(() => {
        skeleton.remove();
      });
    };

    if (root.childElementCount > 0) {
      handOver();
      return () => cancelAnimationFrame(frame);
    }

    const observer = new MutationObserver(() => {
      if (root.childElementCount === 0) {
        return;
      }
      observer.disconnect();
      handOver();
    });
    observer.observe(root, { childList: true });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
};

const App: FC = () => {
  useShellSkeletonHandoff();

  return (
    <HelmetProvider>
      {/* This needs to be outside QueryClientProvider so that Wagmi uses a basic queryClient rather than our normal one with suspense */}
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          {/* Unfortunately, PersistQueryClientProvider does not seem to epxose the persister. We use our own provider to get access to the persister in the event that we need to remove storage (e.g. during signout). */}
          <PersistQueryClientInstanceProvider
            localStoragePersister={localStoragePersister}
          >
            <PopStateProvider>
              <HasUnmountedProvider>
                <ScrollProvider>
                  <StandaloneModeProvider>
                    <GlobalKeyPressProvider>
                      <LinkDetailsPopoverManagerProvider>
                        <RecentFetchProvider>
                          {/* The shell is meant to be on screen whatever the
                              feed is doing, and this boundary sits above every
                              provider in it: anything that suspends up here
                              falls back to the shell and its loading column,
                              never to an empty page. The same shell is what the
                              document itself paints, so the reader sees one
                              shape from the first paint onwards. */}
                          <Suspense fallback={<ShellSkeleton />}>
                            <QueryClientProvider client={queryClient}>
                              {/* FullScreenErrorBoundary must be a child of QueryClientProvider */}
                              <FullScreenErrorBoundary>
                                <LinkifyProvider>
                                  {/* WebFarcasterApiClientProvider must be a child of QueryClientProvider, AuthProvider, and RecentFetchProvider */}
                                  <WebFarcasterApiClientProvider>
                                    {/* AuthProvider must be a child of QueryClientProvider, AuthProvider, WebFarcasterApiClientProvider, and FeatureFlagProvider */}
                                    <AuthProvider>
                                      <AuthGatedBlockedDomainsProvider>
                                        <ThemeProvider>
                                          <AnalyticsProvider>
                                            <SnapWindowErrorListenerInstaller />
                                            <InteractedSnapUrlsWebProvider>
                                              <PubSubProvider>
                                                <VideoPlayStatusProvider>
                                                  <DirectCastToTakeActionProvider>
                                                    <MiniAppProvider>
                                                      <MinimizableWindowProvider>
                                                        <BrowserRouter>
                                                          <UnifiedMetaMaskProvider>
                                                            <SolanaWalletProvider>
                                                              {/* Privy's provider is mounted here, low and
                                                                  late: it appears only when this build has an
                                                                  app id, and only once its chunk has arrived,
                                                                  so nothing above it waits for a third-party
                                                                  script. See ~/providers/PrivyRoot. */}
                                                              <PrivyRoot>
                                                                <Router />
                                                              </PrivyRoot>
                                                            </SolanaWalletProvider>
                                                          </UnifiedMetaMaskProvider>
                                                        </BrowserRouter>
                                                      </MinimizableWindowProvider>
                                                    </MiniAppProvider>
                                                  </DirectCastToTakeActionProvider>
                                                </VideoPlayStatusProvider>
                                              </PubSubProvider>
                                            </InteractedSnapUrlsWebProvider>
                                          </AnalyticsProvider>
                                        </ThemeProvider>
                                      </AuthGatedBlockedDomainsProvider>
                                    </AuthProvider>
                                  </WebFarcasterApiClientProvider>
                                </LinkifyProvider>
                              </FullScreenErrorBoundary>
                            </QueryClientProvider>
                          </Suspense>
                        </RecentFetchProvider>
                      </LinkDetailsPopoverManagerProvider>
                    </GlobalKeyPressProvider>
                  </StandaloneModeProvider>
                </ScrollProvider>
              </HasUnmountedProvider>
            </PopStateProvider>
          </PersistQueryClientInstanceProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </HelmetProvider>
  );
};

export { App };
