/**
 * The head read behind "N new posts".
 *
 * The point of the read is its cost, so the tests count requests: one small
 * `castsByFid` page per author, no follow-graph re-read, and a fan-out that does
 * not start new reads once the feed has looked away.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAppKey } from '../appKey';
import { fetchFeedHead } from '../feed';
import { SnapchainNodeClient } from '../http';
import { buildCastAddMessage } from '../messages';
import type { NodeMessage } from '../types';
import {
  fixedRandomBytes,
  startTestNode,
  TEST_FID,
  type TestNode,
} from './fixtures';

let node: TestNode;
let client: SnapchainNodeClient;

beforeEach(async () => {
  node = await startTestNode();
  client = new SnapchainNodeClient({ baseUrl: node.url });
});

afterEach(async () => {
  await node.close();
});

const seedCast = async (options: {
  fid: number;
  text: string;
  timestamp: number;
}) => {
  const appKey = await generateAppKey(fixedRandomBytes(options.fid % 250));
  node.store(
    (
      await buildCastAddMessage({
        fid: options.fid,
        signerPrivateKey: appKey.privateKey,
        text: options.text,
        timestamp: options.timestamp,
      })
    ).message,
  );
};

/** A message a stub client can hand back without a node behind it. */
const fakeCast = (
  fid: number,
  hash: string,
  timestampMs: number,
): NodeMessage =>
  ({
    hash,
    signer: '0x0',
    signature: '',
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    hashScheme: 'HASH_SCHEME_BLAKE3',
    fid,
    timestamp: Math.floor(timestampMs / 1000),
    timestampMs,
    network: 'FARCASTER_NETWORK_MAINNET',
    type: 'MESSAGE_TYPE_CAST_ADD',
    castAdd: {
      text: `cast ${hash}`,
      embeds: [],
      mentions: [],
      mentionsPositions: [],
      castType: 'CAST_TYPE_CAST',
    },
  }) as unknown as NodeMessage;

describe('the feed head', () => {
  it('reads one small page per author and keeps the newest casts', async () => {
    await seedCast({ fid: 3, text: 'old', timestamp: 12_000_001 });
    await seedCast({ fid: 3, text: 'latest', timestamp: 12_000_003 });
    await seedCast({ fid: 3, text: 'middle', timestamp: 12_000_002 });
    await seedCast({ fid: 4, text: 'theirs', timestamp: 12_000_004 });

    const head = await fetchFeedHead({
      node: client,
      fids: [3, 4],
      perAuthor: 2,
    });

    expect(head.casts.map((cast) => cast.castAdd?.text)).toEqual([
      'theirs',
      'latest',
      'middle',
    ]);
    expect(head.unread).toEqual([]);
    // Two authors, two requests: the cost of a poll is the graph, not its casts.
    expect(head.requests).toBe(2);
    expect(node.requestsFor('/v1/castsByFid')).toHaveLength(2);
  });

  it('reads each author once, however the caller built the list', async () => {
    await seedCast({ fid: 3, text: 'once', timestamp: 12_000_001 });

    const head = await fetchFeedHead({
      node: client,
      fids: [3, 3, 3, TEST_FID],
    });

    expect(head.requests).toBe(2);
    expect(head.casts).toHaveLength(1);
  });

  it('marks the authors it could not read instead of failing the poll', async () => {
    const down = {
      ...client,
      castsByFid: async () => {
        throw new Error('node is down');
      },
    } as unknown as SnapchainNodeClient;

    const head = await fetchFeedHead({ node: down, fids: [3, 4, 5] });

    expect(head.casts).toEqual([]);
    expect(head.unread.sort()).toEqual([3, 4, 5]);
    // The count is unverified when this is non-empty; the callers must say so.
    expect(head.requests).toBe(3);
  });

  it('stops starting reads once the caller says it looked away', async () => {
    let cancelled = false;
    const stub = {
      castsByFid: async ({ fid }: { fid: number }) => {
        cancelled = true;
        return {
          messages: [fakeCast(fid, `0x${'11'.repeat(20)}`, 12_000_001)],
        };
      },
    } as unknown as SnapchainNodeClient;

    const head = await fetchFeedHead({
      node: stub,
      fids: [3, 4, 5, 6],
      concurrency: 1,
      isCancelled: () => cancelled,
    });

    expect(head.cancelled).toBe(true);
    // Only the read already in flight was made.
    expect(head.requests).toBe(1);
  });

  it('drops an author whose newest message is a remove', async () => {
    interface Page {
      messages: NodeMessage[];
    }
    const page = (messages: NodeMessage[]): Page => ({ messages });
    const stub = {
      castsByFid: async ({ fid }: { fid: number }) =>
        page([
          {
            ...fakeCast(fid, `0x${'22'.repeat(20)}`, 12_000_009),
            castAdd: undefined,
          },
          fakeCast(fid, `0x${'33'.repeat(20)}`, 12_000_008),
        ]),
    } as unknown as SnapchainNodeClient;

    const head = await fetchFeedHead({ node: stub, fids: [3] });

    expect(head.casts.map((cast) => cast.hash)).toEqual([
      `0x${'33'.repeat(20)}`,
    ]);
  });
});
