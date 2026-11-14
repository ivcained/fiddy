// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MiniAppAutoSignIn } from '~/components/session/MiniAppAutoSignIn';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { continueAsHref } from '~/lib/miniAppHost';

const { signIn, trackEvent, getItem, setItem, loadMiniAppHostSdk, hostFns } =
  vi.hoisted(() => ({
    signIn: vi.fn(),
    trackEvent: vi.fn(),
    getItem: vi.fn(),
    setItem: vi.fn(),
    loadMiniAppHostSdk: vi.fn(),
    hostFns: {
      isInsideMiniAppHost: vi.fn(),
      announceMiniAppReady: vi.fn(),
      signInInsideMiniApp: vi.fn(),
    },
  }));

vi.mock('~/contexts/AuthProvider', () => ({
  useAuth: () => ({ signIn }),
}));

vi.mock('~/contexts/AnalyticsProvider', () => ({
  useAnalytics: () => ({ trackEvent }),
}));

vi.mock('~/utils/storageUtils', () => ({ getItem, setItem }));

vi.mock('~/utils/logUtils', () => ({ logError: vi.fn() }));

vi.mock('~/lib/miniAppSession', () => ({
  loadMiniAppHostSdk,
  isInsideMiniAppHost: hostFns.isInsideMiniAppHost,
  announceMiniAppReady: hostFns.announceMiniAppReady,
  signInInsideMiniApp: hostFns.signInInsideMiniApp,
}));

const FAKE_SDK = { actions: { ready: vi.fn(), signIn: vi.fn() } };

const signedInOutcome = {
  status: 'signed-in' as const,
  fid: 191554,
  username: 'ivc',
  displayName: 'Ivc',
  pfpUrl: 'https://example.com/pfp.png',
  authToken: { secret: 'siwf-local:191554:abc', expiresAt: Date.now() + 1 },
  onboardingState: { result: { state: { id: 'siwf-local-191554' } } },
  fidBoundToSignature: true,
  readyAnnounced: true,
};

beforeEach(() => {
  installFakeStorage();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  signIn.mockReset();
  trackEvent.mockClear();
  getItem.mockReset();
  setItem.mockReset();
  loadMiniAppHostSdk.mockReset();
  hostFns.isInsideMiniAppHost.mockReset();
  hostFns.announceMiniAppReady.mockReset();
  hostFns.signInInsideMiniApp.mockReset();

  // The ordinary case: no session stored yet.
  getItem.mockResolvedValue(undefined);
  loadMiniAppHostSdk.mockResolvedValue(FAKE_SDK);
  hostFns.isInsideMiniAppHost.mockResolvedValue(true);
  hostFns.announceMiniAppReady.mockResolvedValue(true);
  hostFns.signInInsideMiniApp.mockResolvedValue(signedInOutcome);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MiniAppAutoSignIn', () => {
  it('signs in from the host context and stores the session under the token key', async () => {
    render(<MiniAppAutoSignIn />);

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));

    expect(signIn.mock.calls[0][0].authToken).toBe(signedInOutcome.authToken);
    // The onboarding state is written BEFORE the sign-in, keyed by the token
    // secret, because the reboot that follows reads it back by that key.
    expect(setItem.mock.calls[0][0].value).toBe(
      signedInOutcome.onboardingState,
    );
    expect(String(setItem.mock.calls[0][0].key)).toContain('onboarding-state');
    expect(String(trackEvent.mock.calls[0][0])).toContain(
      'logged in inside miniapp host',
    );
  });

  it('says what it is doing while it does it, instead of leaving a blank app', async () => {
    let resolveSignIn: (value: unknown) => void = () => undefined;
    hostFns.signInInsideMiniApp.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );

    render(<MiniAppAutoSignIn />);

    expect(
      await screen.findByText('Signing you in with Farcaster…'),
    ).toBeTruthy();

    resolveSignIn(signedInOutcome);
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });

  it('keeps the sign-in door open and says why when the host refuses', async () => {
    hostFns.signInInsideMiniApp.mockResolvedValue({
      status: 'refused',
      reason: 'that sign-in was not approved in Farcaster, so nothing was in',
      host: null,
    });

    render(<MiniAppAutoSignIn />);

    // The card speaks to the person, not to a log: the refusal is one plain
    // sentence, and the reason string is not printed at them.
    const notice = await screen.findByText(/won’t sign this one in/);

    expect(notice.textContent).toContain('Nothing was signed in');
    expect(screen.queryByText(/that sign-in was not approved/)).toBeNull();
    // Nobody to continue as, so no offer and no dead-end button either.
    expect(screen.queryByText(/Continue as/)).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('offers to continue as the account the host named, read-only', async () => {
    hostFns.signInInsideMiniApp.mockResolvedValue({
      status: 'refused',
      reason: 'that sign-in was not approved in Farcaster',
      host: { fid: 191554, username: 'ivc', displayName: 'Ivc' },
    });

    render(<MiniAppAutoSignIn />);

    const offer = await screen.findByText('Continue as @ivc');

    expect(screen.getByText(/You can still read as @ivc here/)).toBeTruthy();
    // Still no session, and the offer does NOT sign anything by itself.
    expect(signIn).not.toHaveBeenCalled();

    // The account survives the rest of the tab, so the front door and a reload
    // both know who this is without asking the host again.
    expect(window.sessionStorage.getItem('fiddy.miniapp.host')).toContain(
      '191554',
    );

    // Pressing it leaves for that account's Following feed, read-only. jsdom
    // cannot navigate, so the destination is pinned through the helper the
    // button calls.
    expect(continueAsHref(191554)).toBe('/feed?as=191554');
    fireEvent.click(offer);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('signs in nobody when the page is not in a host', async () => {
    hostFns.isInsideMiniAppHost.mockResolvedValue(false);

    render(<MiniAppAutoSignIn />);

    await waitFor(() =>
      expect(hostFns.isInsideMiniAppHost).toHaveBeenCalledTimes(1),
    );

    expect(hostFns.signInInsideMiniApp).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it('leaves an existing session alone, and still takes the host splash down', async () => {
    getItem.mockResolvedValue({ secret: 'a-real-api-token' });

    render(<MiniAppAutoSignIn />);

    await waitFor(() =>
      expect(hostFns.announceMiniAppReady).toHaveBeenCalledTimes(1),
    );

    expect(hostFns.signInInsideMiniApp).not.toHaveBeenCalled();
  });

  it('never loops: one attempt per tab session, even if the first did not take', async () => {
    window.sessionStorage.setItem('fiddy.miniapp.auto-sign-in', 'true');

    render(<MiniAppAutoSignIn />);

    await waitFor(() =>
      expect(hostFns.announceMiniAppReady).toHaveBeenCalledTimes(1),
    );

    expect(hostFns.signInInsideMiniApp).not.toHaveBeenCalled();
  });
});
