// @vitest-environment jsdom
/**
 * Whom a Farcaster client says is using Fiddy, and when that may be offered.
 *
 * The rule this file exists to hold: the host's word is UNVERIFIED, so it may
 * name a person and open public reads, and nothing else. Every case below is one
 * way a context can be wrong, plus the two behaviours the refusal path leans on
 * — one lookup at a time, and a failed lookup that is asked again rather than
 * cached as "nobody".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostSdk = vi.hoisted(() => {
  const state = {
    contextReads: 0,
    contextValue: Promise.resolve({}) as Promise<unknown>,
  };

  return {
    state,
    isInMiniApp: vi.fn<(timeoutMs?: number) => Promise<boolean>>(),
    // A getter, so a test can prove the context is never even asked for when
    // the host check says this is not a host.
    get context() {
      state.contextReads += 1;
      return state.contextValue;
    },
    actions: { ready: vi.fn(), signIn: vi.fn() },
    back: { enableWebNavigation: vi.fn() },
  };
});

vi.mock('@farcaster/miniapp-sdk', () => ({ default: hostSdk }));

/** A fresh copy of the module, so the one-in-flight cache starts empty. */
const freshHost = async () => {
  vi.resetModules();
  return await import('~/lib/miniAppHost');
};

beforeEach(() => {
  window.sessionStorage.clear();
  hostSdk.isInMiniApp.mockReset();
  hostSdk.state.contextReads = 0;
  hostSdk.state.contextValue = Promise.resolve({});
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('fidOfContext', () => {
  it('reads a FID only from a positive safe integer', async () => {
    const { fidOfContext } = await freshHost();

    expect(fidOfContext({ user: { fid: 3, username: 'dwr' } })).toBe(3);
    expect(fidOfContext({ user: { fid: 2 ** 32 + 5 } })).toBe(2 ** 32 + 5);
    expect(fidOfContext({ user: { fid: 191554 } })).toBe(191554);
  });

  it.each([
    ['no context', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['no user', { user: null }],
    ['an empty user', { user: {} }],
    ['zero', { user: { fid: 0 } }],
    ['a negative fid', { user: { fid: -1 } }],
    ['a fractional fid', { user: { fid: 1.5 } }],
    ['a string fid', { user: { fid: '3' } }],
    ['NaN', { user: { fid: NaN } }],
    ['past the safe-integer range', { user: { fid: 2 ** 53 } }],
  ])('refuses %s', async (_label, context) => {
    const { fidOfContext } = await freshHost();

    expect(fidOfContext(context)).toBeNull();
  });
});

describe('hostFromContext', () => {
  it('carries the name and picture when the host chose to give them', async () => {
    const { hostFromContext } = await freshHost();

    expect(
      hostFromContext({
        user: {
          fid: 3,
          username: 'dwr',
          displayName: 'Dan',
          pfpUrl: 'https://example.com/dwr.png',
        },
      }),
    ).toEqual({
      fid: 3,
      username: 'dwr',
      displayName: 'Dan',
      pfpUrl: 'https://example.com/dwr.png',
    });
  });

  it('invents no name for an account the context only numbers', async () => {
    const { hostFromContext } = await freshHost();

    expect(hostFromContext({ user: { fid: 3, username: '  ' } })).toEqual({
      fid: 3,
    });
  });

  it('answers null for a context that names nobody', async () => {
    const { hostFromContext } = await freshHost();

    expect(hostFromContext({ user: { username: 'dwr' } })).toBeNull();
  });

  it('calls them by handle, then name, then number — never a made-up name', async () => {
    const { hostAt } = await freshHost();

    expect(hostAt({ fid: 3, username: 'dwr', displayName: 'Dan' })).toBe(
      '@dwr',
    );
    expect(hostAt({ fid: 3, displayName: 'Dan' })).toBe('Dan');
    expect(hostAt({ fid: 3 })).toBe('fid 3');
  });
});

describe('offered', () => {
  const host = { fid: 3, username: 'dwr' };

  it('never re-offers an account this browser is already signed in as', async () => {
    const { offered } = await freshHost();

    expect(offered(null, [])).toBeNull();
    expect(offered(host, [])).toBe(host);
    expect(offered(host, [{ fid: 3, done: true }])).toBeNull();
  });

  it('treats an account still being set up as not signed in', async () => {
    const { offered } = await freshHost();

    // Started, unfinished: the offer is what gets them reading rather than
    // stranded on a setup screen they did not mean to open.
    expect(offered(host, [{ fid: 3, done: false }])).toBe(host);
    expect(offered(host, [{ fid: 3 }])).toBe(host);
  });

  it('still offers the host account when a DIFFERENT account is signed in', async () => {
    const { offered } = await freshHost();

    expect(offered(host, [{ fid: 4, done: true }])).toBe(host);
  });
});

describe('hostIdentity', () => {
  it('claims nobody outside a host, and asks the host nothing else', async () => {
    const { hostIdentity } = await freshHost();

    hostSdk.isInMiniApp.mockResolvedValue(false);
    hostSdk.state.contextValue = Promise.resolve({ user: { fid: 3 } });

    expect(await hostIdentity()).toBeNull();
    // The host check is what comes first: no context is even touched, and
    // nothing that could sign as a person is called.
    expect(hostSdk.state.contextReads).toBe(0);
    expect(hostSdk.actions.signIn).not.toHaveBeenCalled();
    expect(hostSdk.actions.ready).not.toHaveBeenCalled();
  });

  it('reads the context once and keeps what it found for this tab', async () => {
    const { hostIdentity, readRememberedHost } = await freshHost();

    hostSdk.isInMiniApp.mockResolvedValue(true);
    hostSdk.state.contextValue = Promise.resolve({
      user: { fid: 3, username: 'dwr', displayName: 'Dan' },
    });

    expect(await hostIdentity()).toEqual({
      fid: 3,
      username: 'dwr',
      displayName: 'Dan',
    });
    // Kept synchronously, and kept in the tab: the reload after a sign-in must
    // not ask the host again and wait a second for an answer it already had.
    expect(readRememberedHost()).toEqual({
      fid: 3,
      username: 'dwr',
      displayName: 'Dan',
    });
    expect(await hostIdentity()).toEqual(readRememberedHost());
  });

  it('asks ONE question at a time', async () => {
    const { hostIdentity } = await freshHost();

    hostSdk.isInMiniApp.mockResolvedValue(true);
    hostSdk.state.contextValue = Promise.resolve({ user: { fid: 3 } });

    const first = hostIdentity();

    expect(hostIdentity()).toBe(first);
    expect(await first).toEqual({ fid: 3 });
  });

  it('drops a failed lookup, so the next page asks again', async () => {
    const { hostIdentity } = await freshHost();

    hostSdk.isInMiniApp.mockResolvedValue(true);
    const failed = Promise.reject(new Error('the host never answered'));
    // The read reaches this a tick later (the SDK import comes first), so the
    // rejection has an owner from the moment it exists.
    failed.catch(() => undefined);
    hostSdk.state.contextValue = failed;

    const first = hostIdentity();

    expect(await first).toBeNull();

    const second = hostIdentity();

    // A host slow to answer once is not a host with nothing to say: a NEW
    // promise, not the settled failure served from a cache.
    expect(second).not.toBe(first);
    expect(await second).toBeNull();
  });

  it('gives up on a context the host never answers, rather than waiting', async () => {
    const { hostIdentity } = await freshHost();

    hostSdk.isInMiniApp.mockResolvedValue(true);
    hostSdk.state.contextValue = new Promise(() => undefined);

    const startedAt = Date.now();

    // The one timeout this client already owns (MINI_APP_HOST_TIMEOUT_MS), not
    // a second clock: a host that answered "yes I am a host" and then went
    // quiet costs a second, never the page.
    expect(await hostIdentity()).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });
});
