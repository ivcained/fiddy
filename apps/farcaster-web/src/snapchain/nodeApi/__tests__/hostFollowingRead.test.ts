/**
 * ONE account's Following feed, read with NO session (the continue-as read).
 *
 * The two facts this file pins are the ones a refusal path depends on:
 *
 *   1. the read never asks who is signed in. It is asked by a person whose own
 *      Farcaster client refused to sign them in, so `getSignedInFid` throws
 *      here — a version of this that reached for `requireFid()` would leave the
 *      exact person it exists for on the signed-out wall.
 *   2. an unreadable feed and an empty one are DIFFERENT answers: a follow graph
 *      where nobody answered throws (so the surface can say the feed is
 *      unavailable, never "the network looks dead"), and a graph with nothing
 *      in it answers empty.
 *
 * The fake node is the repo's own fixture fetch, so pages are decoded as real
 * node JSON; the accounts under test are stated by the fallback, because the
 * recorded fixture is one account's (fid 3).
 */

import { type ApiCastFeedItem } from 'farcaster-client-data';
import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { createNodeBackedFetch, NodeBackedReads } from '~/snapchain/nodeApi';
import { createEmbedCardResolver } from '~/snapchain/nodeApi/embedCards';
import {
  hostFeedFid,
  hostFeedKey,
  hostFidOf,
} from '~/snapchain/nodeApi/publicFeedWindow';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch, TERMINAL_PAGE_TOKEN } from './fakeNodeFetch';

const NODE = 'http://node.test';

const HASH = (letter: string) => `0x${letter.repeat(40)}`;

/** The account whose Following feed is being read. */
const VIEWER_FID = 3;

/** The accounts it follows. */
const FOLLOWED = [40, 41];

const rawCast = ({
  fid,
  hash,
  seconds,
  text,
  parentCastId = null,
  parentUrl = null,
}: {
  fid: number;
  hash: string;
  seconds: number;
  text: string;
  parentCastId?: { fid: number; hash: string } | null;
  parentUrl?: string | null;
}) => ({
  data: {
    type: 'MESSAGE_TYPE_CAST_ADD',
    fid,
    timestamp: seconds,
    network: 'FARCASTER_NETWORK_MAINNET',
    castAddBody: {
      embedsDeprecated: [],
      mentions: [],
      parentCastId,
      parentUrl,
      text,
      embeds: [],
      mentionsPositions: [],
      type: 'CAST',
    },
  },
  hash,
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: 'c2ln',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: '0x0',
});

const rawFollow = ({
  fid,
  targetFid,
  seconds,
}: {
  fid: number;
  targetFid: number;
  seconds: number;
}) => ({
  data: {
    type: 'MESSAGE_TYPE_LINK_ADD',
    fid,
    timestamp: seconds,
    network: 'FARCASTER_NETWORK_MAINNET',
    linkBody: { type: 'follow', displayTimestamp: null, targetFid },
  },
  hash: HASH('e'),
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: 'c2ln',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: '0x0',
});

const page = (messages: unknown[]) => ({
  messages,
  nextPageToken: TERMINAL_PAGE_TOKEN,
});

/** Two authors: three root casts (one of them a reply) and a channel post. */
const CASTS: Record<number, unknown[]> = {
  40: [
    rawCast({ fid: 40, hash: HASH('a'), seconds: 1000, text: 'older root' }),
    rawCast({
      fid: 40,
      hash: HASH('b'),
      seconds: 3000,
      text: 'a reply, not this feed',
      parentCastId: { fid: 41, hash: HASH('c') },
    }),
    rawCast({
      fid: 40,
      hash: HASH('d'),
      seconds: 4000,
      text: 'a channel post, not this feed',
      parentUrl: 'https://warpcast.com/~/channel/dev',
    }),
  ],
  41: [rawCast({ fid: 41, hash: HASH('c'), seconds: 2000, text: 'newest' })],
};

const offlineEmbedCards = () =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

/**
 * A node that answers one account's follow graph and those accounts' casts.
 *
 * `failAuthors` makes the per-author reads fail, which is the "nobody answered"
 * case; `followed: []` is a person who follows nobody.
 */
const followingFetch = ({
  log,
  followed = FOLLOWED,
  failAuthors = false,
}: {
  log?: string[];
  followed?: number[];
  failAuthors?: boolean;
}) =>
  createFixtureNodeFetch({
    ...(log ? { log } : {}),
    fallback: ({ path, params }) => {
      if (path === '/v1/linksByFid') {
        return page(
          followed.map((targetFid, index) =>
            rawFollow({
              fid: Number(params.get('fid')),
              targetFid,
              seconds: 100 + index,
            }),
          ),
        );
      }
      if (path === '/v1/castsByFid') {
        if (failAuthors) {
          throw new Error('the node refused this page');
        }
        return page(CASTS[Number(params.get('fid'))] ?? []);
      }
      return undefined;
    },
  });

/**
 * The reader under test, with NOBODY signed in.
 *
 * `getSignedInFid` answering undefined is what a session-less browser really
 * looks like here, and it is the state the refusal path is in. The read must
 * still answer — a version of it that reached for `requireFid()` would throw
 * the "sign in to read this" sentence at the one person this exists for.
 */
const noSessionReader = (fetchImpl: typeof fetch) =>
  new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl,
    embedKinds: offlineEmbedKinds(),
    embedCards: offlineEmbedCards(),
    getSignedInFid: () => undefined,
  });

describe('the feed key', () => {
  it('names one account, and only a real one', () => {
    expect(hostFeedKey(3)).toBe('as:3');
    expect(hostFeedFid('as:3')).toBe(3);
    expect(hostFeedFid('as:191554')).toBe(191554);
  });

  it.each([
    ['a bare fid', '3'],
    ['another key', 'public'],
    ['nothing', undefined],
    ['zero', 'as:0'],
    ['negative', 'as:-3'],
    ['fractional', 'as:1.5'],
    ['not a number', 'as:dwr'],
    ['empty', 'as:'],
    ['past the safe range', 'as:9007199254740992'],
  ])('refuses %s', (_label, key) => {
    expect(hostFeedFid(key)).toBeNull();
  });

  it('validates a FID typed into a URL the same way', () => {
    expect(hostFidOf('3')).toBe(3);
    expect(hostFidOf(' 3 ')).toBeNull();
    expect(hostFidOf('0')).toBeNull();
    expect(hostFidOf('-1')).toBeNull();
    expect(hostFidOf('1.5')).toBeNull();
    expect(hostFidOf(null)).toBeNull();
  });
});

describe('one account’s Following feed, read with no session', () => {
  it('answers that account’s follows, newest first, and asks nobody who is signed in', async () => {
    const log: string[] = [];
    const reads = noSessionReader(followingFetch({ log }));

    const result = await reads.readFollowingFeedFor({ fid: VIEWER_FID });

    expect(result.items.map((item: ApiCastFeedItem) => item.cast.text)).toEqual(
      ['newest', 'older root'],
    );
    expect(
      result.items.map((item: ApiCastFeedItem) => item.cast.author.fid),
    ).toEqual([41, 40]);

    // The follow graph read is the HOST's, not a viewer's.
    expect(
      log.some((entry) => entry.startsWith(`/v1/linksByFid?fid=${VIEWER_FID}`)),
    ).toBe(true);
    expect(log.some((entry) => entry.startsWith('/v1/castsByFid?fid=40'))).toBe(
      true,
    );
  });

  it('refuses a number that cannot be a Farcaster account', async () => {
    const reads = noSessionReader(followingFetch({}));

    await expect(reads.readFollowingFeedFor({ fid: 0 })).rejects.toThrow(
      /not a Farcaster account number/,
    );
    await expect(reads.readFollowingFeedFor({ fid: -1 })).rejects.toThrow(
      /not a Farcaster account number/,
    );
    await expect(reads.readFollowingFeedFor({ fid: 1.5 })).rejects.toThrow(
      /not a Farcaster account number/,
    );
  });

  it('answers EMPTY for somebody who follows nobody', async () => {
    const reads = noSessionReader(followingFetch({ followed: [] }));

    const result = await reads.readFollowingFeedFor({ fid: VIEWER_FID });

    expect(result.items).toEqual([]);
  });

  it('throws when nobody answered, rather than calling that an empty feed', async () => {
    const reads = noSessionReader(followingFetch({ failAuthors: true }));

    // The difference the surface shows: "this feed is unavailable" is not
    // "these people said nothing", and a signed-out reader must never be shown
    // a dead-looking network because a node was down.
    await expect(
      reads.readFollowingFeedFor({ fid: VIEWER_FID }),
    ).rejects.toThrow(/none of the 2 accounts/);
  });
});

describe('the adapter’s `as:<fid>` dispatch', () => {
  it('answers POST /v2/feed-items for a host feed key with no session at all', async () => {
    const handle = createNodeBackedFetch({
      nodeBaseUrl: NODE,
      embedKinds: offlineEmbedKinds(),
      // Exactly what a signed-out browser gives it.
      getSignedInFid: () => undefined,
      fetchImpl: followingFetch({}),
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({ feedKey: hostFeedKey(VIEWER_FID) }),
      },
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      result: { items: { cast: { text: string } }[] };
    };

    expect(body.result.items.map((item) => item.cast.text)).toEqual([
      'newest',
      'older root',
    ]);
  });

  it('says a feed it cannot read is unavailable, not empty', async () => {
    const handle = createNodeBackedFetch({
      nodeBaseUrl: NODE,
      embedKinds: offlineEmbedKinds(),
      getSignedInFid: () => undefined,
      fetchImpl: followingFetch({ failAuthors: true }),
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({ feedKey: hostFeedKey(VIEWER_FID) }),
      },
    );

    expect(response.status).toBe(502);
  });
});
