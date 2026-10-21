/**
 * Mounting Privy's browser half — when configured, and never in the way when not.
 *
 * TWO THINGS THIS HAS TO GET RIGHT.
 *
 * 1. NO APP ID MEANS NO FEATURE, NOT A BROKEN ONE. With `VITE_PRIVY_APP_ID`
 *    unset — every build today — this renders its children and nothing else: no
 *    SDK is fetched, no iframe, no network. That is what makes the social door a
 *    switch rather than a risk.
 *
 * 2. THE APP'S FIRST PAINT DOES NOT WAIT FOR THE SDK. The provider is imported
 *    in its own chunk and mounted only once that chunk has arrived, so the shell
 *    paints as it always did and a slow (or blocked) third-party script cannot
 *    hold the front door shut. The subtree remounts once, when the provider
 *    appears — which is why `ready` is published through a context rather than
 *    left implicit: a component that needs Privy hooks can ask whether the
 *    provider is here yet instead of assuming, and a click that arrives too early
 *    is a disabled button rather than a crash.
 *
 * WHY NOT AT THE VERY TOP OF THE TREE. The provider is mounted inside
 * `~/components/App` rather than around it, so the routes, the shell and the
 * error boundaries that already exist keep working exactly as measured, whether
 * or not Privy is in the picture.
 */

import type { PrivyProviderProps } from '@privy-io/react-auth';
import React, {
  createContext,
  FC,
  ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

import {
  areSocialSignUpsAvailable,
  privyAppId,
  privyBrowserConfig,
} from '~/lib/socialSignUp';

type PrivyRootValue = {
  /** True once the SDK is loaded and the provider is mounted above this point. */
  ready: boolean;
  /** True when this build has the feature at all. */
  configured: boolean;
};

const PrivyRootContext = createContext<PrivyRootValue>({
  ready: false,
  configured: false,
});

/** Ask whether Privy's provider is up. Safe to call with no provider at all. */
export const usePrivyRoot = (): PrivyRootValue => useContext(PrivyRootContext);

const PrivyRoot: FC<{ children: ReactNode }> = ({ children }) => {
  const appId = privyAppId();
  const configured = areSocialSignUpsAvailable();

  const [Provider, setProvider] = useState<
    React.ComponentType<PrivyProviderProps> | undefined
  >();

  useEffect(() => {
    if (!configured) {
      return;
    }

    let live = true;

    void import('@privy-io/react-auth').then((module) => {
      if (live) {
        setProvider(() => module.PrivyProvider);
      }
    });

    return () => {
      live = false;
    };
  }, [configured]);

  const ready = configured && Provider !== undefined;

  if (!configured || !Provider || !appId) {
    return (
      <PrivyRootContext.Provider value={{ ready: false, configured }}>
        {children}
      </PrivyRootContext.Provider>
    );
  }

  return (
    <PrivyRootContext.Provider value={{ ready, configured }}>
      <Provider appId={appId} config={privyBrowserConfig()}>
        {children}
      </Provider>
    </PrivyRootContext.Provider>
  );
};

export { PrivyRoot, PrivyRootContext };
export type { PrivyRootValue };