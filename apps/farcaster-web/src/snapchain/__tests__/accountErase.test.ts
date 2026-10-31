/**
 * The delete-account engine against a fake node: paging, rate-limit waits,
 * conflict counting, clock-skewed follows and the read-back that counts what
 * the node still lists. Modeled on quilcast's `src/erase.test.ts`
 * (backmeupplz/quilcast@8aba47042319, MIT). Never run against a real node.
 */
import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import {
  deleteServerData,
  eraseFarcasterAccount,
  type EraseStep,
} from '~/snapchain/accountErase';

// Protocol message type numbers (@farcaster/core's MessageType; the app does
// not depend on that package directly, so the test pins the values).
const MT = {
  CAST_REMOVE: 2,
  REACTION_REMOVE: 4,
  LINK_REMOVE: 6,
  USER_DATA_ADD: 11,
} as const;

const FID = 7;
const APP_KEY = `0x${'03'.repeat(32)}`;
const noWait = () => Promise.resolve();

// ---------------------------------------------------------------------------
// a tiny protobuf reader, so a test can say WHICH message was submitted

/** Read a varint at `i`; answer its value and the index after it. */
const varint = (b: Uint8Array, i: number): [number, number] => {
  let value = 0;
  let shift = 0;
  for (;;) {
    value += (b[i] & 0x7f) * 2 ** shift;
    if (!(b[i] & 0x80)) {
      return [value, i + 1];
    }
    i += 1;
    shift += 7;
  }
};

/** The MessageData inside a submitted Message: type (1), fid (2), timestamp (3). */
const messageData = (
  bytes: Uint8Array,
): { type: number; fid: number; timestamp: number } => {
  // Message field 1 is the data blob, length-delimited.
  let i = 0;
  const [key] = varint(bytes, i);
  if (key >> 3 !== 1) {
    throw new Error('expected data first');
  }
  i = 1;
  const [length, after] = varint(bytes, i);
  const data = bytes.subarray(after, after + length);
  const out = { type: 0, fid: 0, timestamp: 0 };
  let j = 0;
  while (j < data.length) {
    const [fieldKey, afterKey] = varint(data, j);
    const field = fieldKey >> 3;
    const wire = fieldKey & 7;
    if (wire === 0) {
      const [value, next] = varint(data, afterKey);
      if (field === 1) {
        out.type = value;
      }
      if (field === 2) {
        out.fid = value;
      }
      if (field === 3) {
        out.timestamp = value;
      }
      j = next;
    } else if (wire === 2) {
      const [innerLength, afterLength] = varint(data, afterKey);
      j = afterLength + innerLength;
    } else {
      throw new Error(`wire type ${wire} not read here`);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// the fake node

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const envelope = (data: Record<string, unknown>, hash: string) => ({
  hash,
  signer: `0x${'00'.repeat(32)}`,
  signature: '',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  hashScheme: 'HASH_SCHEME_BLAKE3',
  data: {
    fid: FID,
    timestamp: 100,
    network: 'FARCASTER_NETWORK_MAINNET',
    ...data,
  },
});

const cast = (n: number) =>
  envelope(
    {
      type: 'MESSAGE_TYPE_CAST_ADD',
      castAddBody: {
        text: `cast ${n}`,
        embeds: [],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        type: 'CAST',
      },
    },
    `0x${n.toString(16).padStart(40, '0')}`,
  );

const reaction = (type: 'REACTION_TYPE_LIKE' | 'REACTION_TYPE_RECAST') =>
  envelope(
    {
      type: 'MESSAGE_TYPE_REACTION_ADD',
      reactionBody: {
        type,
        targetCastId: { fid: 2, hash: `0x${'ab'.repeat(20)}` },
        targetUrl: null,
      },
    },
    `0x${'cd'.repeat(20)}`,
  );

const follow = (targetFid: number, timestamp = 100) =>
  envelope(
    {
      type: 'MESSAGE_TYPE_LINK_ADD',
      timestamp,
      linkBody: { type: 'follow', targetFid, displayTimestamp: null },
    },
    `0x${'ef'.repeat(20)}`,
  );

const userData = (type: string, value: string) =>
  envelope(
    { type: 'MESSAGE_TYPE_USER_DATA_ADD', userDataBody: { type, value } },
    `0x${'0a'.repeat(20)}`,
  );

interface FakeNode {
  client: SnapchainNodeClient;
  submitted: { type: number; fid: number; timestamp: number }[];
}

/**
 * A node that lists the account's messages until the first removal lands, then
 * lists only what `left` keeps. `submit` answers each POST /v1/submitMessage.
 */
const fakeNode = ({
  submit = () =>
    res(
      200,
      envelope({ type: 'MESSAGE_TYPE_CAST_REMOVE' }, `0x${'0b'.repeat(20)}`),
    ),
  left = () => false,
  messages = {},
}: {
  submit?: (
    data: { type: number; fid: number; timestamp: number },
    n: number,
  ) => Response;
  left?: (path: string) => boolean;
  messages?: {
    casts?: unknown[];
    likes?: unknown[];
    recasts?: unknown[];
    follows?: unknown[];
    profile?: unknown[];
  };
}): FakeNode => {
  const submitted: FakeNode['submitted'] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const q = url.searchParams;
    if (url.pathname === '/v1/submitMessage') {
      const data = messageData(init?.body ?? new Uint8Array());
      submitted.push(data);
      return submit(data, submitted.length);
    }
    if (q.get('fid') !== String(FID)) {
      throw new Error(`unexpected fid ${q.get('fid')}`);
    }
    const empty = { messages: [], nextPageToken: '' };
    if (submitted.length > 0 && !left(url.pathname)) {
      return res(200, empty);
    }
    if (url.pathname === '/v1/castsByFid') {
      const casts = messages.casts ?? [cast(1), cast(2), cast(3)];
      // page 1 holds two, page 2 the third, so paging really is walked
      if (q.get('pageToken') === 'next') {
        return res(200, { messages: casts.slice(2), nextPageToken: '' });
      }
      return res(200, {
        messages: casts.slice(0, 2),
        nextPageToken: casts.length > 2 ? 'next' : '',
      });
    }
    if (url.pathname === '/v1/reactionsByFid') {
      const list =
        q.get('reaction_type') === 'Like'
          ? (messages.likes ?? [reaction('REACTION_TYPE_LIKE')])
          : (messages.recasts ?? [reaction('REACTION_TYPE_RECAST')]);
      return res(200, { messages: list, nextPageToken: '' });
    }
    if (url.pathname === '/v1/linksByFid') {
      return res(200, {
        messages: messages.follows ?? [follow(2), follow(3)],
        nextPageToken: '',
      });
    }
    if (url.pathname === '/v1/userDataByFid') {
      return res(200, {
        messages: messages.profile ?? [
          userData('USER_DATA_TYPE_PFP', 'https://x/p.png'),
          userData('USER_DATA_TYPE_DISPLAY', 'Seven'),
          userData('USER_DATA_TYPE_BIO', ''), // empty already: nothing to clear
          userData('USER_DATA_TYPE_USERNAME', 'seven'), // stays with the account
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  return {
    client: new SnapchainNodeClient({
      baseUrl: 'https://node.test',
      fetch: fetchImpl,
    }),
    submitted,
  };
};

const erase = (node: FakeNode) =>
  eraseFarcasterAccount({
    fid: FID,
    appKeyHex: APP_KEY,
    node: node.client,
    sleep: noWait,
    settleMs: 0,
  });

describe('eraseFarcasterAccount', () => {
  it('removes casts, likes, recasts and follows and empties the clearable profile fields', async () => {
    const node = fakeNode({});
    const steps = new Map<string, string>();
    const out = await eraseFarcasterAccount({
      fid: FID,
      appKeyHex: APP_KEY,
      node: node.client,
      sleep: noWait,
      settleMs: 0,
      onProgress: (step: EraseStep | 'find', done: number, total: number) =>
        steps.set(step, `${done}/${total}`),
    });

    expect(out).toEqual({
      casts: 3,
      reactions: 2,
      follows: 2,
      profile: 2,
      failed: 0,
    });
    const count = (type: number) =>
      node.submitted.filter((m) => m.type === type).length;
    expect(count(MT.CAST_REMOVE)).toBe(3);
    expect(count(MT.REACTION_REMOVE)).toBe(2);
    expect(count(MT.LINK_REMOVE)).toBe(2);
    expect(count(MT.USER_DATA_ADD)).toBe(2); // pfp + display; not the empty bio, not the username
    expect(node.submitted.every((message) => message.fid === FID)).toBe(true);
    expect(steps.get('casts')).toBe('3/3');
    expect(steps.get('profile')).toBe('2/2');
  });

  it('waits out a rate limit, and a cast the node calls already-removed counts as done', async () => {
    const node = fakeNode({
      submit: (_data, n) => {
        if (n === 1) {
          return res(429, { error: 'rate limit exceeded' });
        }
        if (n === 3) {
          return res(400, {
            error: 'bad request',
            error_detail: 'message conflicts with a CastRemove',
          });
        }
        return res(
          200,
          envelope(
            { type: 'MESSAGE_TYPE_CAST_REMOVE' },
            `0x${'0b'.repeat(20)}`,
          ),
        );
      },
    });
    const out = await erase(node);
    expect(out).toEqual({
      casts: 3,
      reactions: 2,
      follows: 2,
      profile: 2,
      failed: 0,
    });
    // every removal once, plus the one retry after the 429
    expect(node.submitted.length).toBe(10);
  });

  it('what the node refuses is reported with its own words, and the rest still go', async () => {
    const node = fakeNode({
      submit: (data) =>
        data.type === MT.LINK_REMOVE
          ? res(400, {
              error: 'bad request',
              error_detail: 'invalid link body',
            })
          : res(
              200,
              envelope(
                { type: 'MESSAGE_TYPE_LINK_REMOVE' },
                `0x${'0b'.repeat(20)}`,
              ),
            ),
      left: (path) => path === '/v1/linksByFid', // and the follows are indeed still listed
    });
    const out = await erase(node);
    expect(out.casts).toBe(3);
    expect(out.follows).toBe(0);
    expect(out.failed).toBe(2);
    expect(out.error).toContain('invalid link body');
  });

  it('a follow stamped in the future is removed with a newer timestamp than it', async () => {
    const nowFc = Math.floor(Date.now() / 1000) - 1609459200;
    const node = fakeNode({ messages: { follows: [follow(2, nowFc + 120)] } });
    const out = await erase(node);
    expect(out.follows).toBe(1);
    const removal = node.submitted.find((m) => m.type === MT.LINK_REMOVE);
    expect(removal).toBeDefined();
    expect(removal!.timestamp).toBeGreaterThan(nowFc + 120);
    expect(removal!.timestamp).toBeLessThan(nowFc + 600);
  });

  it('a remove the node accepted but never landed is caught by the second look', async () => {
    const node = fakeNode({ left: (path) => path === '/v1/userDataByFid' });
    const out = await erase(node);
    expect(out.failed).toBe(2); // the two clearable fields are still listed
    expect(out.error).toMatch(/still lists/);
  });
});

describe('deleteServerData', () => {
  it('asks the service, signed, until it says done', async () => {
    const asked: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://fiddy.fun');
      expect(url.pathname).toBe('/api/fiddy/account');
      const auth = (init?.headers as Record<string, string> | undefined)
        ?.authorization;
      asked.push(
        `${init?.method} ${auth === 'Bearer token-7' ? 'signed' : 'UNSIGNED'}`,
      );
      return asked.length < 2
        ? res(200, { ok: true, state: 'running' })
        : res(200, {
            ok: true,
            state: 'done',
            drafts: 2,
            media: 1,
            mediaKept: 1,
            connect: 1,
            connectFailed: 0,
            fundingKept: true,
          });
    };
    const out = await deleteServerData({
      fid: FID,
      token: 'token-7',
      fetchImpl: fetchImpl as typeof fetch,
      sleep: noWait,
    });
    expect(asked).toEqual(['DELETE signed', 'DELETE signed']);
    expect(out).toMatchObject({
      drafts: 2,
      media: 1,
      mediaKept: 1,
      fundingKept: true,
    });
  });

  it('a refusal is said, not retried forever', async () => {
    const fetchImpl = async () =>
      res(503, { ok: false, code: 'ACCOUNT_PURGE_UNAVAILABLE' });
    await expect(
      deleteServerData({
        fid: FID,
        token: 'token-7',
        fetchImpl: fetchImpl as typeof fetch,
        sleep: noWait,
      }),
    ).rejects.toThrow(/ACCOUNT_PURGE_UNAVAILABLE/);
  });
});
