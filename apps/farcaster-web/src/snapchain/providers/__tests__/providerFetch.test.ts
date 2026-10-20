/**
 * The routing fetch, as tests — including the one thing that must never happen.
 *
 * The live provider decides where a request goes, and the three ways of
 * answering are each checked here: a node-backed read goes to the node the live
 * provider names, Farcaster's public server gets the same path at its own
 * address with no session attached, and Neynar gets its mapped call. The last
 * test is the security one: this device's session headers are never replayed to
 * a third-party server.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  farcasterPublicProvider,
  neynarProvider,
  ownNodeProvider,
} from '~/snapchain/providers/catalog';
import { createProviderBackedFetch } from '~/snapchain/providers/providerFetch';
import type { NodeProvider } from '~/snapchain/providers/providerTypes';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A stand-in for the node-backed adapter, so no node client is constructed. */
const stubNodeAdapter = () => {
  const calls: string[] = [];
  const factory = (({ nodeBaseUrl }: { nodeBaseUrl: string }) => {
    return {
      fetch: (async (url: string) => {
        calls.push(url);
        return jsonResponse({ result: { from: nodeBaseUrl } });
      }) as typeof fetch,
      reads: {} as never,
      log: [],
      nodeBaseUrl,
    };
  }) as unknown as typeof import('~/snapchain/nodeApi/nodeBackedFetch').createNodeBackedFetch;
  return { calls, factory };
};

describe('createProviderBackedFetch: a node provider', () => {
  it('sends the read to the live provider’s own address', async () => {
    const { calls, factory } = stubNodeAdapter();
    const provider: NodeProvider = ownNodeProvider('https://mine.example');
    const handle = createProviderBackedFetch({
      getActiveProvider: () => provider,
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter: factory,
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/me');

    expect(calls[0]).toContain('/v2/me');
    expect(handle.log[0]).toEqual({
      path: '/v2/me',
      providerId: 'snapchain:https://mine.example',
      kind: 'snapchain',
    });
  });

  it('builds one adapter per address and reuses it', async () => {
    const factory = vi.fn(stubNodeAdapter().factory);
    const provider = ownNodeProvider('https://mine.example');
    const handle = createProviderBackedFetch({
      getActiveProvider: () => provider,
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter:
        factory as unknown as typeof import('~/snapchain/nodeApi/nodeBackedFetch').createNodeBackedFetch,
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/me');
    await handle.fetch('https://farcaster.xyz/~api/v2/verifications?fid=3');

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('falls back to the build’s own node before anything has been measured', async () => {
    const { calls, factory } = stubNodeAdapter();
    const handle = createProviderBackedFetch({
      getActiveProvider: () => null,
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter: factory,
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/me');

    expect(calls.length).toBe(1);
    expect(handle.log[0]!.providerId).toBe('build-configured');
  });
});

describe('createProviderBackedFetch: Farcaster’s own public server', () => {
  it('asks the same path at that server, and passes the hosted answer through', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ result: { user: { fid: 3 } } });
    }) as unknown as typeof fetch;

    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/user-by-fid?fid=3',
    );

    expect(calls[0]!.url).toBe(
      'https://api.farcaster.xyz/v2/user-by-fid?fid=3',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { user: { fid: 3 } } });
  });

  it('sends no session at all to a third-party server', async () => {
    const calls: { init?: RequestInit }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse({ result: {} });
    }) as unknown as typeof fetch;

    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/user-by-fid?fid=3', {
      headers: {
        authorization: 'Bearer this-device-session-token',
        cookie: 'fiddy=1',
        'fc-device-id': 'device-1',
      },
    });

    const headers = new Headers(calls[0]!.init?.headers ?? undefined);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('fc-device-id')).toBeNull();
    expect(calls[0]!.init?.credentials).toBe('omit');
  });

  it('says a signed-in read needs a node instead of showing a raw 401', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { errors: [{ message: 'Authentication required' }] },
        401,
      )) as unknown as typeof fetch;
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
    });

    const response = await handle.fetch('https://farcaster.xyz/~api/v2/unseen');

    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('needs a signed-in session');
    expect(body.errors[0]!.message).toContain('reads that from a node');
  });

  it('refuses a write by name', async () => {
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({ feedKey: 'home' }),
      },
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('does not take writes');
  });
});

describe('createProviderBackedFetch: Neynar', () => {
  it('refuses honestly when the build has no key, and names the setup script', async () => {
    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      neynarApiKey: null,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/user-by-fid?fid=3',
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('fiddy-setup.command');
  });

  it('routes the read through the mapper when a key is present', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        users: [{ fid: 3, username: 'dwr', follower_count: 1 }],
      });
    }) as unknown as typeof fetch;

    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
      neynarApiKey: 'a-key',
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/user-by-fid?fid=3',
    );

    expect(calls[0]!.url).toContain(
      'https://api.neynar.com/v2/farcaster/user/bulk?fids=3',
    );
    const body = (await response.json()) as {
      result: { user: { username?: string } };
    };
    expect(body.result.user.username).toBe('dwr');
    expect(handle.log[0]!.kind).toBe('neynar');
  });
});
