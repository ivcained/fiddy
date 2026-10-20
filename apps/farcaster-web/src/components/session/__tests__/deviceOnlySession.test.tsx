// @vitest-environment jsdom

/**
 * The decision this file guards: when does the client treat a session as
 * device-only, what does it say about it, and does the landing offer a retry
 * that could never succeed? Getting any of those wrong is what produced the
 * bare "Could not reach Farcaster" page this card is about, so they are pinned
 * here rather than left to the end-to-end probe alone.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_SESSION_SECRET_PREFIX } from '~/lib/siwfSession';

const state = vi.hoisted(() => ({
  authToken: undefined as { secret: string; expiresAt: number } | undefined,
  localApiEnabled: false,
  user: undefined as
    | { fid?: number; username?: string; displayName?: string }
    | undefined,
  signOut: vi.fn(async () => undefined),
}));

vi.mock('~/contexts/AuthProvider', () => ({
  useAuth: () => ({ authToken: state.authToken, signOut: state.signOut }),
}));

vi.mock('farcaster-client-hooks', () => ({
  useCachedOnboardingState: () => ({
    result: { state: { user: state.user } },
  }),
}));

vi.mock('~/constants/api', () => ({
  get localApiEnabled() {
    return state.localApiEnabled;
  },
}));

vi.mock('~/components/links/Link', () => ({
  Link: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('a', null, children),
}));

const { describeDeviceOnlyAccount, useDeviceOnlySession } =
  await import('~/components/session/useDeviceOnlySession');
const { DeviceOnlySessionPage } =
  await import('~/components/session/DeviceOnlySessionPage');
const { ShellSectionErrorBoundary } =
  await import('~/components/errors/ShellSectionErrorBoundary');

const localToken = {
  secret: `${LOCAL_SESSION_SECRET_PREFIX}4242:abc`,
  expiresAt: 0,
};
const serverToken = { secret: 'a-real-token', expiresAt: 0 };

beforeEach(() => {
  state.authToken = undefined;
  state.localApiEnabled = false;
  state.user = undefined;
  state.signOut.mockClear();
});

describe('useDeviceOnlySession', () => {
  it('is device-only for a local marker with no API that can serve it', () => {
    state.authToken = localToken;
    state.user = { fid: 4242, username: 'fiddy', displayName: 'Fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(true);
    expect(result.current).toMatchObject({
      fid: 4242,
      username: 'fiddy',
      displayName: 'Fiddy',
    });
  });

  it('is NOT device-only when the dev mock API is serving the app', () => {
    // The escape hatch exists so the shell can be worked on; a local marker
    // with the mock API behind it is a session that works, and must not be
    // sent to the "nothing can serve this" landing.
    state.authToken = localToken;
    state.localApiEnabled = true;
    state.user = { fid: 4242, username: 'fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(false);
  });

  it('is NOT device-only for a server-backed session', () => {
    state.authToken = serverToken;
    state.user = { fid: 4242, username: 'fiddy' };

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(false);
  });

  it('survives a session with no cached identity at all', () => {
    state.authToken = localToken;

    const { result } = renderHook(() => useDeviceOnlySession());

    expect(result.current.isDeviceOnly).toBe(true);
    expect(describeDeviceOnlyAccount(result.current)).toBe('');
  });
});

describe('describeDeviceOnlyAccount', () => {
  it('names handle and fid the way the sign-in screen does', () => {
    expect(
      describeDeviceOnlyAccount({
        isDeviceOnly: true,
        fid: 4242,
        username: 'fiddy',
      }),
    ).toBe('@fiddy · fid 4242');
  });

  it('falls back to the display name, then to the fid alone', () => {
    expect(
      describeDeviceOnlyAccount({
        isDeviceOnly: true,
        fid: 4242,
        displayName: 'Fiddy Tester',
      }),
    ).toBe('Fiddy Tester');

    expect(describeDeviceOnlyAccount({ isDeviceOnly: true, fid: 4242 })).toBe(
      'fid 4242',
    );
  });

  it('says nothing for a normal session', () => {
    expect(describeDeviceOnlyAccount({ isDeviceOnly: false })).toBe('');
  });
});

describe('DeviceOnlySessionPage', () => {
  beforeEach(() => {
    state.authToken = localToken;
    state.user = { fid: 4242, username: 'fiddy', displayName: 'Fiddy' };
  });

  it('names the account and says what is missing', () => {
    const { getByText, queryByText } = render(<DeviceOnlySessionPage />);

    expect(getByText('@fiddy · fid 4242')).toBeTruthy();
    expect(
      getByText(/Farcaster signed this device in, and that sign-in is real/),
    ).toBeTruthy();
    expect(getByText(/Not reachable from this device yet/)).toBeTruthy();

    // Never the fork's generic network page, and never a retry that cannot
    // succeed for a session with nothing behind it.
    expect(queryByText(/Could not reach Farcaster/)).toBeNull();
    expect(queryByText(/Try again/)).toBeNull();
  });

  it('offers the account-free surfaces and a single way out', () => {
    const { getByText } = render(<DeviceOnlySessionPage />);

    expect(getByText('Add a brain')).toBeTruthy();
    expect(getByText('Connect apps')).toBeTruthy();

    getByText(/Sign out/).click();
    expect(state.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('ShellSectionErrorBoundary', () => {
  const Thrower = () => {
    throw new Error('the region could not load');
  };

  const renderBoundary = (label: string) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ShellSectionErrorBoundary label={label}>
          <Thrower />
        </ShellSectionErrorBoundary>
      </QueryClientProvider>,
    );

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('degrades in place, and with a device-only session offers no false retry', () => {
    state.authToken = localToken;
    state.user = { fid: 4242, username: 'fiddy' };

    const { getByText, queryByText } = renderBoundary('Channels');

    expect(getByText('Channels needs a server session')).toBeTruthy();
    expect(queryByText(/Try again/)).toBeNull();
  });

  it('keeps a real retry for a normal session', () => {
    state.authToken = serverToken;

    const { getByText } = renderBoundary('Channels');

    expect(getByText('Channels couldn’t load')).toBeTruthy();
    expect(getByText(/Try again/)).toBeTruthy();
  });
});
