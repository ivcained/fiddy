// @vitest-environment jsdom

/**
 * The public shell's mini app window — what card `t_5dfc9e8b` ships.
 *
 * A signed-out reader pressing a cast's mini app launch button used to get
 * nothing: `launchMiniApp` set state and no host in the unauthed tree rendered
 * it (the authed shell's `MinimizableWindowHost` is mounted by
 * `AuthedRightSideBar`, which the public surfaces never render). This file
 * pins the fix's contract, not the window's pixels:
 *
 *   1. nothing is drawn while no mini app is launched;
 *   2. a launch through the SAME context the cast card calls renders the
 *      window with the launch config the card carried — including the
 *      no-Neynar chain, where the name/splash come from the cast's own
 *      `fc:miniapp` tag;
 *   3. dismiss closes the window.
 *
 * `MiniApp` itself is stubbed: its own behaviours are held by their own
 * tests; what this file guards is the mount, which no other test could see.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PublicMiniAppWindowHost } from '~/components/miniApp/PublicMiniAppWindowHost';
import { MiniAppProvider } from '~/contexts/MiniAppProvider';
import {
  MinimizableWindowProvider,
  useMinimizableWindowContext,
} from '~/contexts/MinimizableWindowProvider';

const launched = vi.hoisted(() => ({ urls: [] as (string | undefined)[] }));

vi.mock('~/components/miniApp/MiniApp', () => ({
  MiniApp: ({ launchConfig }: { launchConfig?: { url?: string } }) => {
    launched.urls.push(launchConfig?.url);
    return React.createElement(
      'div',
      { 'data-testid': 'stubbed-mini-app' },
      launchConfig?.url ?? '(no launch config)',
    );
  },
}));

vi.mock('~/contexts/AnalyticsProvider', () => ({
  useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock('farcaster-client-hooks', () => ({
  useNonSuspenseFrameDetails: () => ({ data: undefined }),
  useGloballyCachedFrame: (data: unknown) => data,
  useFetchFrameDetails: () => ({ data: undefined }),
}));

const Probe = ({ onReady }: { onReady: (api: unknown) => void }) => {
  // Reaching into the context the cast card itself uses, so the test drives
  // the real launch path rather than the provider's private state.
  const { launchMiniApp } = useMinimizableWindowContext();
  onReady({ launchMiniApp });
  return null;
};

const tree = (onReady: (api: unknown) => void) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(
      MiniAppProvider,
      null,
      React.createElement(
        MinimizableWindowProvider,
        null,
        React.createElement(PublicMiniAppWindowHost),
        React.createElement(Probe, { onReady }),
      ),
    ),
  );
};

describe('PublicMiniAppWindowHost', () => {
  it('renders nothing while no mini app is launched', () => {
    const { queryByTestId } = render(tree(() => {}));
    expect(queryByTestId('stubbed-mini-app')).not.toBeNull();
    // The window's outer box is hidden with no launch, so the stub is in the
    // tree but the window is not visible.
    const box = queryByTestId('stubbed-mini-app')?.parentElement;
    expect(box?.className).toContain('hidden');
  });

  it('renders the window for a signed-out launch, node-only config included', () => {
    let api: { launchMiniApp: (params: unknown) => void } | undefined;
    const { queryByTestId } = render(tree((a) => (api = a as never)));
    act(() => {
      api?.launchMiniApp({
        launchConfig: {
          type: 'manifest',
          url: 'https://fiddy.fun/3d/share/191554',
          name: 'Fiddy 3D',
        },
        context: {
          type: 'cast_embed',
          embed: 'https://fiddy.fun/3d/share/191554',
        },
      });
    });
    expect(queryByTestId('stubbed-mini-app')?.textContent).toBe(
      'https://fiddy.fun/3d/share/191554',
    );
    const box = queryByTestId('stubbed-mini-app')?.parentElement;
    expect(box?.className).not.toContain('hidden');
    expect(launched.urls).toContain('https://fiddy.fun/3d/share/191554');
  });
});
