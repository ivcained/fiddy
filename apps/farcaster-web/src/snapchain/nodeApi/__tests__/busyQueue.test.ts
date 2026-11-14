/**
 * A full node queue is a wait, not a refusal.
 *
 * MEASURED (the live node's own words, and the shape quilcast retries —
 * `ee50eae`, "a full node queue retried"): a node under load answers
 * `POST /v1/submitMessage` with a non-ok
 *
 *     status: Unavailable, message: "unavailable/mempool channel is full"
 *
 * which is transient — the same message, sent a second or two later, is accepted.
 * This client used to catch every `NodeApiError` and answer it as a terminal 501
 * "would not accept this write", so a write that would have landed was reported to
 * the reader as refused.
 *
 * What is pinned here, at the writer:
 *
 *   - a busy node is offered the SAME signed bytes again, and the write succeeds;
 *   - after the last wait it fails in plain words, saying it already tried again;
 *   - a message the node really refused (a signer it does not know) is not retried
 *     — asking again would only be a slower way of saying the same thing;
 *   - every retry is the same bytes. A Farcaster message IS its hash, so a retry
 *     cannot double-post; re-signing would make a second message that could.
 */

import {
  bytesToHex,
  decodeMessageBytes,
  messageTypeName,
} from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import {
  BUSY_RETRY_DELAYS_MS,
  NODE_BUSY,
  NodeBackedWrites,
  type WriteEvidence,
} from '~/snapchain/nodeApi/nodeWrites';

const FID = 3;
const TARGET = {
  fid: 37,
  hash: '0x50184b62b4c52fd76628713562e1eda3dccaf63d',
};
const SIGNER_KEY =
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

const BUSY_BODY = {
  error: 'Failed to submit message',
  // Verbatim: what a node whose submit queue is full answers.
  error_detail:
    'status: Unavailable, message: "unavailable/mempool channel is full"',
};

const messageJson = ({
  type,
  hash,
  reactionType,
}: {
  type: string;
  hash: string;
  reactionType: string;
}) => ({
  data: {
    type,
    fid: FID,
    timestamp: 183107142,
    network: 'FARCASTER_NETWORK_MAINNET',
    reactionBody: {
      type: reactionType,
      targetCastId: { fid: TARGET.fid, hash: TARGET.hash },
    },
  },
  hash,
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: 'c2lnbmF0dXJl',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: `0x${'11'.repeat(32)}`,
});

/**
 * A node whose submit queue is full `busyTimes` times, then accepts. It keeps
 * every body it was handed, because "the same bytes" is the claim under test.
 */
const createQueueNode = ({
  busyTimes,
  accepts = true,
}: {
  busyTimes: number | 'always';
  accepts?: boolean;
}) => {
  const submitted: Uint8Array[] = [];
  let busySoFar = 0;

  const fetchImpl = (async (input: string, init?: { body?: unknown }) => {
    const url = new URL(input, 'http://node.test');
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/v1/submitMessage') {
      submitted.push(init?.body as Uint8Array);
      const stillBusy = busyTimes === 'always' ? true : busySoFar < busyTimes;
      if (stillBusy) {
        busySoFar += 1;
        return json(BUSY_BODY, 503);
      }
      if (!accepts) {
        // A refusal that is *not* about load: the node does not know this signer.
        return json(
          {
            error: 'Failed to submit message',
            error_detail:
              'status: InvalidArgument, message: "bad_request.validation_failure/invalid signer"',
          },
          400,
        );
      }
      const decoded = decodeMessageBytes(init?.body as Uint8Array);
      const hash = bytesToHex(decoded.hash);
      const added =
        messageTypeName(
          (decoded.data as unknown as { type: number }).type as Parameters<
            typeof messageTypeName
          >[0],
        ) === 'MESSAGE_TYPE_REACTION_ADD';
      return json(
        messageJson({
          type: added
            ? 'MESSAGE_TYPE_REACTION_ADD'
            : 'MESSAGE_TYPE_REACTION_REMOVE',
          hash,
          reactionType: 'REACTION_TYPE_LIKE',
        }),
      );
    }

    if (url.pathname === '/v1/reactionsByCast') {
      // The node's merged state after accepting: this account's like is there.
      return json({
        messages: [
          messageJson({
            type: 'MESSAGE_TYPE_REACTION_ADD',
            hash: `0x${'33'.repeat(32)}`,
            reactionType: 'REACTION_TYPE_LIKE',
          }),
        ],
        nextPageToken: '',
      });
    }

    return json({ messages: [], nextPageToken: '' });
  }) as unknown as typeof fetch;

  return { fetchImpl, submitted };
};

const writerWith = (
  node: ReturnType<typeof createQueueNode>,
  evidence: WriteEvidence[],
) =>
  new NodeBackedWrites({
    nodeBaseUrl: 'http://node.test',
    nodeLabel: 'Your node',
    fetchImpl: node.fetchImpl,
    getAppKeyHex: async () => SIGNER_KEY,
    castAuthor: () => TARGET.fid,
    // The waits are what this test is *about*, so they are recorded rather than
    // slept: a suite that really waited 7 s would be measuring the clock.
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    onEvidence: (write) => {
      evidence.push(write);
    },
  });

const waits: number[] = [];

const likeOnTarget = async (writer: NodeBackedWrites) =>
  writer.answer({
    method: 'PUT',
    path: '/v2/cast-likes',
    body: { castHash: TARGET.hash },
    fid: FID,
  });

const messageOf = async (response: Response): Promise<string> => {
  const body = (await response.json()) as { errors: { message: string }[] };
  return body.errors[0]?.message ?? '';
};

describe('a write offered to a node whose submit queue is full', () => {
  it('waits and offers the same bytes again until the queue clears', async () => {
    waits.length = 0;
    const evidence: WriteEvidence[] = [];
    const node = createQueueNode({ busyTimes: 2 });
    const writer = writerWith(node, evidence);

    const response = await likeOnTarget(writer);

    expect(response.status).toBe(200);
    // Three attempts: two busy answers, then accepted.
    expect(node.submitted).toHaveLength(3);
    // The waits are the ones upstream uses: one second, then two.
    expect(waits).toEqual([BUSY_RETRY_DELAYS_MS[0], BUSY_RETRY_DELAYS_MS[1]]);

    // ONE unique body across all three tries: the same signed message, never
    // re-signed. A new signature would be a different message — and a different
    // message is something the network could merge twice.
    const bodies = new Set(node.submitted.map((bytes) => bytesToHex(bytes)));
    expect(bodies.size).toBe(1);

    // The like really landed, and the evidence says how it got there.
    expect(evidence.at(-1)).toMatchObject({
      accepted: true,
      landed: true,
      attempts: 3,
    });
    expect(await response.json()).toMatchObject({
      result: { like: { type: 'like', castHash: TARGET.hash } },
    });
  });

  it('gives up in plain words after the last wait, not with the node’s error', async () => {
    waits.length = 0;
    const evidence: WriteEvidence[] = [];
    const node = createQueueNode({ busyTimes: 'always' });
    const writer = writerWith(node, evidence);

    const response = await likeOnTarget(writer);

    // The message went out once per allowed attempt, and then it stopped.
    expect(node.submitted).toHaveLength(BUSY_RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...BUSY_RETRY_DELAYS_MS]);

    expect(response.status).toBe(503);
    // The sentence a person reads: what happened, that we tried again, and the
    // one thing left to do. Never `unavailable/mempool channel is full`.
    const shown = await messageOf(response);
    expect(shown).toBe(NODE_BUSY);
    expect(shown).not.toMatch(/mempool|Unavailable/);

    // The evidence keeps the node's own words and says the queue was the reason,
    // which is the signal the provider chain needs in order to move.
    expect(evidence.at(-1)).toMatchObject({
      accepted: false,
      landed: null,
      busy: true,
      attempts: BUSY_RETRY_DELAYS_MS.length + 1,
    });
    expect(evidence.at(-1)?.refusal).toMatch(/mempool channel is full/);
  });

  it('does not retry a message the node really refused', async () => {
    waits.length = 0;
    const evidence: WriteEvidence[] = [];
    const node = createQueueNode({ busyTimes: 0, accepts: false });
    const writer = writerWith(node, evidence);

    const response = await likeOnTarget(writer);

    // One attempt: a signer the node does not know will not become known by
    // asking again.
    expect(node.submitted).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(response.status).toBe(501);
    expect(await messageOf(response)).toMatch(/invalid signer/);
    expect(evidence.at(-1)).toMatchObject({ accepted: false, attempts: 1 });
    expect(evidence.at(-1)?.busy).toBeUndefined();
  });
});
