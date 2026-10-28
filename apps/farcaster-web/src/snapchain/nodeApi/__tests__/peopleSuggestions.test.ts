/**
 * `readPeopleSuggestions` end to end against a synthetic node: the follow
 * graph, the viewer's channel casts, the channel's authors, and the answer
 * the page renders — rank, reason names, and latest casts, with Follow's
 * viewer state read the way `readAuthor` reads it.
 *
 * The graph is small on purpose: every rule of the ported engine can be
 * checked by eye against the fixture tables below.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { createNodeBackedFetch, NodeBackedReads } from '~/snapchain/nodeApi';

import { offlineEmbedKinds } from './fakeEmbedKinds';

const NODE = 'http://node.test';
const TERMINAL = 'W251bGwsbnVsbF0=';
const VIEWER = 1;

/**
 * The synthetic world. Timestamps are Farcaster seconds and chosen so the
 * newest-first order is unambiguous:
 *
 *   viewer (1) follows, newest first: 2, 3, 4, 5, 6 (6 the longest ago)
 *   2 follows: 10, 11, 6
 *   3 follows: 10, 12
 *   4 follows: nobody
 *   5 follows: 11
 *
 *   viewer's casts: two top-level casts in #dev, one in #founders, one reply
 *   #dev's latest casts: fid 10 twice, fid 11 once, fid 20 once
 *   #founders' latest casts: fid 99 once
 *
 * Expected: 10 and 11 tie at score 4 (2 mutuals + 1 channel) — 10 first,
 * more channel posts; then 20 and 99 tie at score 2 (channel only) — 20
 * first, the lower fid. 12 has one mutual and no channel, so
 * min_followed_by drops it. 6 is already followed. The viewer never appears.
 * Sampled: all five follow edges, 6 included — phunk samples the newest 40
 * follows, not only the recent ones.
 */
const FOLLOW_EDGES: Record<number, { targetFid: number; timestamp: number }[]> =
  {
    [VIEWER]: [
      { targetFid: 2, timestamp: 1900 },
      { targetFid: 3, timestamp: 1800 },
      { targetFid: 4, timestamp: 1700 },
      { targetFid: 5, timestamp: 1600 },
      { targetFid: 6, timestamp: 200 },
    ],
    2: [
      { targetFid: 11, timestamp: 950 },
      { targetFid: 6, timestamp: 900 },
      { targetFid: 10, timestamp: 850 },
    ],
    3: [
      { targetFid: 12, timestamp: 750 },
      { targetFid: 10, timestamp: 700 },
    ],
    4: [],
    5: [{ targetFid: 11, timestamp: 550 }],
  };

const DEV = 'https://warpcast.com/~/channel/dev';
const FOUNDERS = 'https://farcaster.xyz/~/channel/founders';

interface CastSpec {
  fid: number;
  text: string;
  timestamp: number;
  parentUrl?: string;
  parentCastId?: string;
}

const VIEWER_CASTS: CastSpec[] = [
  { fid: VIEWER, text: 'hello dev', timestamp: 2200, parentUrl: DEV },
  { fid: VIEWER, text: 'hello again dev', timestamp: 2100, parentUrl: DEV },
  { fid: VIEWER, text: 'founders only', timestamp: 1400, parentUrl: FOUNDERS },
  // A reply: its parent is a cast, so it must NOT count as a channel.
  {
    fid: VIEWER,
    text: 'a reply',
    timestamp: 1300,
    parentUrl: DEV,
    parentCastId: '0xreplyparent',
  },
];

const CHANNEL_CASTS: Record<string, CastSpec[]> = {
  [DEV]: [
    { fid: 10, text: 'dev post one', timestamp: 2400 },
    { fid: 10, text: 'dev post two', timestamp: 2300 },
    { fid: 11, text: 'dev hello', timestamp: 2000 },
    { fid: 20, text: 'drive-by', timestamp: 1500 },
  ],
  [FOUNDERS]: [{ fid: 99, text: 'founders post', timestamp: 1200 }],
};

const USER_NAMES: Record<number, string> = {
  2: 'two',
  3: 'three',
  5: 'five',
  10: 'ten',
  11: 'eleven',
  20: 'twenty',
};

/** The suggestion users' own latest casts (page order = newest first). */
const USER_CASTS: Record<number, CastSpec[]> = {
  10: [
    { fid: 10, text: 'latest from ten', timestamp: 2500 },
    { fid: 10, text: 'older from ten', timestamp: 2450 },
    { fid: 10, text: 'oldest from ten', timestamp: 2350 },
    { fid: 10, text: 'beyond the limit', timestamp: 100 },
  ],
  11: [{ fid: 11, text: 'latest from eleven', timestamp: 2050 }],
  20: [{ fid: 20, text: 'latest from twenty', timestamp: 1550 }],
};

let hashCounter = 0;
const nextHash = (): string => {
  hashCounter += 1;
  return `0x${hashCounter.toString(16).padStart(64, '0')}`;
};

const signerFor = (fid: number): string =>
  `0x${fid.toString(16).padStart(64, '0')}`;

const message = (data: Record<string, unknown>) => ({
  hash: nextHash(),
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: '0x' + 'f'.repeat(128),
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: signerFor(data.fid as number),
  data: {
    network: 'FARCASTER_NETWORK_MAINNET',
    ...data,
  },
});

const linkMessage = (fid: number, targetFid: number, timestamp: number) =>
  message({
    type: 'MESSAGE_TYPE_LINK_ADD',
    fid,
    timestamp,
    linkBody: { type: 'follow', displayTimestamp: null, targetFid },
  });

const castMessage = (cast: CastSpec) =>
  message({
    type: 'MESSAGE_TYPE_CAST_ADD',
    fid: cast.fid,
    timestamp: cast.timestamp,
    castAddBody: {
      embedsDeprecated: [],
      mentions: [],
      parentCastId: cast.parentCastId
        ? { fid: VIEWER, hash: cast.parentCastId }
        : null,
      parentUrl: cast.parentUrl ?? null,
      text: cast.text,
      embeds: [],
      mentionsPositions: [],
      type: 'CAST',
    },
  });

const userDataPage = (fid: number) => ({
  messages: [
    message({
      type: 'MESSAGE_TYPE_USER_DATA_ADD',
      fid,
      timestamp: 100,
      userDataBody: {
        type: 'USER_DATA_TYPE_USERNAME',
        value: USER_NAMES[fid] ?? `fid${fid}`,
      },
    }),
    message({
      type: 'MESSAGE_TYPE_USER_DATA_ADD',
      fid,
      timestamp: 101,
      userDataBody: {
        type: 'USER_DATA_TYPE_DISPLAY',
        value: USER_NAMES[fid] ?? `FID ${fid}`,
      },
    }),
    message({
      type: 'MESSAGE_TYPE_USER_DATA_ADD',
      fid,
      timestamp: 102,
      userDataBody: { type: 'USER_DATA_TYPE_PFP', value: '' },
    }),
    message({
      type: 'MESSAGE_TYPE_USER_DATA_ADD',
      fid,
      timestamp: 103,
      userDataBody: { type: 'USER_DATA_TYPE_BIO', value: '' },
    }),
  ],
  nextPageToken: TERMINAL,
});

const page = (messages: unknown[]) => ({
  messages,
  nextPageToken: TERMINAL,
});

/** The synthetic node: every route the reader asks, answered from the tables. */
const fakeNodeFetch = (log: string[]): typeof fetch => {
  const fetchImpl = async (input: string) => {
    const url = new URL(input, NODE);
    const params = url.searchParams;
    const path = url.pathname;
    log.push(path);

    const answer = (): unknown => {
      switch (path) {
        case '/v1/linksByFid': {
          const fid = Number(params.get('fid'));
          const edges = FOLLOW_EDGES[fid] ?? [];
          return page(
            edges.map((edge) =>
              linkMessage(fid, edge.targetFid, edge.timestamp),
            ),
          );
        }
        case '/v1/castsByFid': {
          const fid = Number(params.get('fid'));
          const casts = fid === VIEWER ? VIEWER_CASTS : (USER_CASTS[fid] ?? []);
          const limit = casts.length > 0 ? 3 : casts.length;
          return page(
            casts.slice(0, Math.max(limit, casts.length)).map(castMessage),
          );
        }
        case '/v1/castsByParent': {
          const url_ = params.get('url') ?? '';
          return page((CHANNEL_CASTS[url_] ?? []).map(castMessage));
        }
        case '/v1/userDataByFid':
          return userDataPage(Number(params.get('fid')));
        case '/v1/linkById':
          // No follow edge from the viewer to anyone in this world's answer.
          return { error: 'not found' };
        case '/v1/reactionsByFid':
        case '/v1/reactionsByCast':
          return page([]);
        default:
          return undefined;
      }
    };

    const body = answer();
    if (body === undefined) {
      return new Response(`Not Found: ${path}`, { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return fetchImpl as unknown as typeof fetch;
};

const readerWith = (log: string[]) => {
  const fetchImpl = fakeNodeFetch(log);
  return new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl,
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => VIEWER,
  });
};

describe('readPeopleSuggestions', () => {
  it('ranks friends-of-friends and channel authors the way phunk does', async () => {
    const log: string[] = [];
    const reader = readerWith(log);
    const result = await reader.readPeopleSuggestions({ limit: 20 });

    expect(result.sampled).toBe(5);
    expect(result.channelsRead).toEqual([DEV, FOUNDERS]);

    const ranked = result.suggestions.map((suggestion) => ({
      fid: suggestion.user.fid,
      score: suggestion.score,
    }));
    // 10 and 11 tie at 4 (two mutuals + the shared #dev channel); 10 has more
    // channel posts, so it is first. 20 and 99 tie at 2 (channel only); 20 is
    // first, the lower fid. 12 (one mutual, no channel) and 6 (already
    // followed) are absent.
    expect(ranked).toEqual([
      { fid: 10, score: 4 },
      { fid: 11, score: 4 },
      { fid: 20, score: 2 },
      { fid: 99, score: 2 },
    ]);
  });

  it('carries the reason names and the shared channels', async () => {
    const reader = readerWith([]);
    const result = await reader.readPeopleSuggestions({ limit: 20 });

    const ten = result.suggestions.find(
      (suggestion) => suggestion.user.fid === 10,
    );
    expect(ten?.channels).toEqual([DEV]);
    // 10's own mutuals: the names resolved off the node. 10 is a suggestion,
    // never in its own followedBy; the ties' reason names come from the graph.
    expect(ten?.followedBy.map((name) => name.username).sort()).toEqual([
      'three',
      'two',
    ]);

    const twenty = result.suggestions.find(
      (suggestion) => suggestion.user.fid === 20,
    );
    expect(twenty?.followedBy).toEqual([]);
    expect(twenty?.channels).toEqual([DEV]);
  });

  it('caps each suggestion at three latest casts, newest first', async () => {
    const reader = readerWith([]);
    const result = await reader.readPeopleSuggestions({ limit: 20 });

    const ten = result.suggestions.find(
      (suggestion) => suggestion.user.fid === 10,
    );
    expect(ten?.latestCasts.length).toBe(3);
    expect(ten?.latestCasts.map((cast) => cast.text)).toEqual([
      'latest from ten',
      'older from ten',
      'oldest from ten',
    ]);
  });

  it('never pages an account the node refuses', async () => {
    // A world where one sampled account's read 500s: the suggestion list
    // still answers, from the accounts that could be read.
    const log: string[] = [];
    const base = fakeNodeFetch(log);
    const failing = (async (input: string) => {
      const url = new URL(input, NODE);
      if (
        url.pathname === '/v1/linksByFid' &&
        Number(url.searchParams.get('fid')) === 2
      ) {
        return new Response('boom', { status: 500 });
      }
      return base(input);
    }) as unknown as typeof fetch;

    const reader = new NodeBackedReads({
      node: new SnapchainNodeClient({
        baseUrl: NODE,
        fetch: failing as unknown as FetchLike,
      }),
      nodeBaseUrl: NODE,
      fetchImpl: failing,
      embedKinds: offlineEmbedKinds(),
      getSignedInFid: () => VIEWER,
    });
    const result = await reader.readPeopleSuggestions({ limit: 20 });

    // Without 2's graph, 11 keeps one mutual (5) + the channel; 10 keeps one
    // mutual (3) + the channel. 20 and 99 stay channel-only.
    expect(result.suggestions.map((suggestion) => suggestion.user.fid)).toEqual(
      [10, 11, 20, 99],
    );
  });

  it('answers the route through the adapter in the hosted envelope', async () => {
    const log: string[] = [];
    const fetchImpl = fakeNodeFetch(log);
    const handle = createNodeBackedFetch({
      nodeBaseUrl: NODE,
      embedKinds: offlineEmbedKinds(),
      getSignedInFid: () => VIEWER,
      fetchImpl,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/people-suggestions?limit=20',
      { method: 'GET' },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        suggestions: { user: { fid: number }; score: number }[];
        sampled: number;
      };
    };
    expect(body.result.sampled).toBe(5);
    expect(
      body.result.suggestions.map((suggestion) => suggestion.user.fid),
    ).toEqual([10, 11, 20, 99]);
  });

  it('says the honest sentence when nobody is signed in', async () => {
    const log: string[] = [];
    const fetchImpl = fakeNodeFetch(log);
    const handle = createNodeBackedFetch({
      nodeBaseUrl: NODE,
      embedKinds: offlineEmbedKinds(),
      getSignedInFid: () => undefined,
      fetchImpl,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/people-suggestions',
      { method: 'GET' },
    );
    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toMatch(/sign/i);
  });
});
