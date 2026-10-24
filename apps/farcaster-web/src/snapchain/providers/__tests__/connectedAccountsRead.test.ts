/**
 * The linked-accounts read: classified, mapped, and answered by the index.
 *
 * WHAT THIS PINS, AND WHY. Reported live (2026-10-24): the signed-in reader's own
 * profile answered “the accounts linked to your Farcaster account are Warpcast
 * account state” and the sentence took the whole page down. Three facts have to
 * hold for that to be gone for good, and each is checked here:
 *
 *   1. the route is classified `index` — a read an indexer answers, which the
 *      matrix lets only the index serve, so a node is never asked and never
 *      stands in with its own refusal;
 *   2. the mapper turns the index's answer into the envelope the surface reads
 *      (`result.accounts`, the fork's own `platform`/`username` fields), and
 *      asks about the SIGNED-IN account, because the request carries no fid;
 *   3. the index's own profile answer carries the same links, so a reader sees
 *      what the index says about an account rather than a row derived from the
 *      viewer's own.
 */

import { describe, expect, it } from 'vitest';

import { classifyHostedRequest } from '~/snapchain/nodeApi/hostedRoutes';
import { providerCanServe } from '~/snapchain/providers/capabilities';
import {
  neynarProvider,
  ownNodeProvider,
  publicNodeProvider,
} from '~/snapchain/providers/catalog';
import {
  answerFromNeynar,
  apiUserFromNeynar,
  connectedAccountsFromNeynar,
  neynarCallFor,
} from '~/snapchain/providers/neynarMap';

/** The index's answer for fid 3, as measured on 2026-10-24. */
const NEYNAR_USER = {
  fid: 3,
  username: 'dwr',
  display_name: 'Dan',
  verified_accounts: [
    { platform: 'x', username: 'dwr' },
    { platform: 'github', username: 'danromero' },
    // A platform the fork's shapes do not name: dropped, never re-labelled.
    { platform: 'mastodon', username: 'dwr' },
  ],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('GET /v2/connected-accounts is a read an index answers', () => {
  it('is classified `index`, in words that name no other product', () => {
    const route = classifyHostedRequest({
      method: 'GET',
      path: '/v2/connected-accounts',
    });
    expect(route.kind).toBe('index');
    expect(route.why).toContain('Neynar’s index');
    expect(route.why).not.toMatch(/warpcast/i);
  });

  it('is served by the index and by no node', () => {
    const kind = 'index' as const;
    expect(
      providerCanServe({
        provider: neynarProvider(),
        kind,
        path: '/v2/connected-accounts',
      }),
    ).toEqual({ can: true });
    for (const provider of [
      ownNodeProvider('https://mine.example'),
      publicNodeProvider('https://public.example'),
    ]) {
      const decision = providerCanServe({
        provider,
        kind,
        path: '/v2/connected-accounts',
      });
      expect(decision.can).toBe(false);
    }
  });

  it('asks the index about the signed-in account, and asks nothing without one', () => {
    const call = neynarCallFor({
      path: '/v2/connected-accounts',
      searchParams: new URLSearchParams({ limit: '15' }),
      signedInFid: 3,
    });
    expect(call?.kind).toBe('index');
    expect(call?.shape).toBe('connected-accounts');
    expect(call?.url).toBe(
      'https://api.neynar.com/v2/farcaster/user/bulk?fids=3',
    );

    expect(
      neynarCallFor({
        path: '/v2/connected-accounts',
        searchParams: new URLSearchParams(),
      }),
    ).toBeNull();
  });

  it('answers in the envelope the surface reads, from the index’s own fields', async () => {
    const requests: string[] = [];
    const response = await answerFromNeynar({
      path: '/v2/connected-accounts',
      searchParams: new URLSearchParams(),
      signedInFid: 3,
      apiKey: 'k'.repeat(36),
      fetchImpl: (async (url: string) => {
        requests.push(String(url));
        return jsonResponse({ users: [NEYNAR_USER] });
      }) as unknown as typeof fetch,
    });

    const body = (await response.json()) as {
      result: { accounts: { platform: string; username: string }[] };
    };
    expect(response.status).toBe(200);
    expect(requests[0]).toContain('/v2/farcaster/user/bulk?fids=3');
    expect(body.result.accounts).toEqual([
      {
        connectedAccountId: 'x:dwr',
        platform: 'x',
        username: 'dwr',
        expired: false,
      },
      {
        connectedAccountId: 'gh:danromero',
        platform: 'gh',
        username: 'danromero',
        expired: false,
      },
    ]);
  });

  it('says what is missing, in its own words, without a signed-in account', async () => {
    const response = await answerFromNeynar({
      path: '/v2/connected-accounts',
      searchParams: new URLSearchParams(),
      signedInFid: undefined,
      apiKey: 'k'.repeat(36),
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(response.status).toBe(501);
    expect(body.errors[0]!.message).toContain('Sign in, and this list loads');
    expect(body.errors[0]!.message).not.toMatch(/warpcast/i);
  });

  it('carries the links on the profile answer too', () => {
    expect(
      connectedAccountsFromNeynar(NEYNAR_USER).map((a) => a.platform),
    ).toEqual(['x', 'gh']);
    const user = apiUserFromNeynar(NEYNAR_USER);
    expect(user.connectedAccounts?.map((a) => a.username)).toEqual([
      'dwr',
      'danromero',
    ]);
    // An account with no links states none rather than an empty array, so a
    // surface can tell “not stated” from “nothing is linked”.
    expect(
      apiUserFromNeynar({ fid: 4, username: 'nobody' }).connectedAccounts,
    ).toBeUndefined();
  });
});
