/**
 * The measurements, as tests — including the ones taken from the real servers.
 *
 * The snapchain body below is the shape a live public node returned on
 * 2026-10-20 (`haatz.quilibrium.com`, trimmed): per-shard `maxHeight` and
 * `blockDelay`, plus `numShards`. The Neynar and `api.farcaster.xyz` bodies are
 * the shapes their documented endpoints return. What the tests check is the part
 * that would otherwise be a claim: which of those answers counts as live, slow,
 * stale, refused or not a node at all.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  farcasterPublicProvider,
  neynarProvider,
  ownNodeProvider,
} from '~/snapchain/providers/catalog';
import {
  DEFAULT_HEALTH_CONFIG,
  judgeFreshness,
  judgeProbe,
  probeFarcasterPublic,
  probeNeynar,
  type ProbeSample,
  probeSnapchain,
} from '~/snapchain/providers/health';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const NODE_INFO = {
  version: '1.5.5',
  isSyncing: false,
  numShards: 2,
  shardInfos: [
    { shardId: 0, maxHeight: 48_501_853, blockDelay: 1 },
    { shardId: 1, maxHeight: 49_177_741, blockDelay: 0 },
    { shardId: 2, maxHeight: 49_013_091, blockDelay: 0 },
  ],
};

describe('judgeFreshness', () => {
  const config = { ...DEFAULT_HEALTH_CONFIG, staleAfterMs: 120_000 };

  it('cannot judge a server it has only just looked at', () => {
    const { freshness, record } = judgeFreshness(undefined, 100, 1_000, config);
    expect(freshness).toBe('unknown');
    expect(record.watermark).toBe(100);
  });

  it('is fresh while the watermark is still moving', () => {
    const first = judgeFreshness(undefined, 100, 1_000, config);
    const second = judgeFreshness(first.record, 101, 61_000, config);
    expect(second.freshness).toBe('fresh');
    expect(second.record.advancedAt).toBe(61_000);
  });

  it('goes stale once the watermark stops moving', () => {
    const first = judgeFreshness(undefined, 100, 1_000, config);
    const still = judgeFreshness(first.record, 100, 61_000, config);
    expect(still.freshness).toBe('fresh');
    const stalled = judgeFreshness(still.record, 100, 121_001, config);
    expect(stalled.freshness).toBe('stale');
  });

  it('reports unknown for a server that publishes no watermark', () => {
    const { freshness } = judgeFreshness(undefined, null, 1_000, config);
    expect(freshness).toBe('unknown');
  });
});

describe('judgeProbe', () => {
  const sample = (overrides: Partial<ProbeSample> = {}): ProbeSample => ({
    ok: true,
    latencyMs: 200,
    httpStatus: 200,
    reason: null,
    watermark: 10,
    catchingUp: false,
    blocksBehind: 0,
    ...overrides,
  });

  const judge = (
    overrides: Partial<ProbeSample>,
    freshness: 'fresh' | 'stale' | 'unknown' = 'fresh',
  ) =>
    judgeProbe({
      providerId: 'mine',
      sample: sample(overrides),
      freshness,
      now: 1_000,
    });

  it('calls a fast, caught-up server live', () => {
    expect(judge({}).status).toBe('live');
    expect(judge({}).detail).toContain('normally');
  });

  it('calls a server slower than the threshold slow', () => {
    const health = judge({ latencyMs: 6_500 });
    expect(health.status).toBe('slow');
    expect(health.detail).toContain('6.5s');
  });

  it('calls a server that says it is catching up stale', () => {
    const health = judge({ catchingUp: true });
    expect(health.status).toBe('stale');
    expect(health.detail).toContain('catching up');
  });

  it('calls a server many blocks behind stale', () => {
    const health = judge({ blocksBehind: 400 });
    expect(health.status).toBe('stale');
    expect(health.detail).toContain('400 blocks behind');
  });

  it('calls a server whose watermark stopped moving stale', () => {
    expect(judge({}, 'stale').status).toBe('stale');
  });

  it('calls a server that did not answer down, and keeps its reason', () => {
    const health = judge({ ok: false, reason: 'It did not answer at all.' });
    expect(health.status).toBe('down');
    expect(health.detail).toBe('It did not answer at all.');
  });

  it('never lets a fast answer hide a stale one', () => {
    expect(judge({ latencyMs: 50, blocksBehind: 1_000 }).status).toBe('stale');
  });
});

describe('probeSnapchain', () => {
  it('reads a live node body as live, with its real height', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(NODE_INFO),
    ) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
    });
    expect(sample.ok).toBe(true);
    expect(sample.watermark).toBe(49_177_741);
    expect(sample.blocksBehind).toBe(1);
    expect(sample.catchingUp).toBe(false);
    expect(
      String(
        (fetchImpl as unknown as { mock: { calls: string[][] } }).mock
          .calls[0]![0],
      ),
    ).toBe('https://node.example/v1/info?dbstats=0');
  });

  it('reports a node that is syncing as catching up', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        ...NODE_INFO,
        isSyncing: true,
      })) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
    });
    expect(sample.catchingUp).toBe(true);
  });

  it('refuses to call a 200 that carries no chain status a node', async () => {
    const fetchImpl = (async () =>
      new Response('<html>Farcaster docs</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://docs.example'),
      fetchImpl,
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('no chain status came back');
  });

  it('reports an error status with the status in the sentence', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'nope' }, 503)) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('503');
  });

  it('turns a request that never answers into a failure with a deadline', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const sample = await probeSnapchain({
      provider: ownNodeProvider('https://node.example'),
      fetchImpl,
      config: { ...DEFAULT_HEALTH_CONFIG, timeoutMs: 20 },
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('0.02s');
  });
});

describe('probeFarcasterPublic', () => {
  it('reads a documented public endpoint as reachable', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        result: { address: { fid: 12152 } },
      })) as unknown as typeof fetch;
    const sample = await probeFarcasterPublic({
      provider: farcasterPublicProvider(),
      fetchImpl,
    });
    expect(sample.ok).toBe(true);
    expect(sample.watermark).toBeNull();
  });
});

describe('probeNeynar', () => {
  const neynarFeed = {
    casts: [
      { hash: '0xaa', timestamp: '2026-10-20T20:00:00.000Z' },
      { hash: '0xbb', timestamp: '2026-10-20T19:59:00.000Z' },
    ],
    next: { cursor: null },
  };

  it('says a missing key is a setup task, not a fault', async () => {
    const sample = await probeNeynar({
      apiKey: null,
      provider: neynarProvider(),
    });
    expect(sample.ok).toBe(false);
    expect(sample.reason).toContain('fiddy-setup.command');
  });

  it('reports a refused key as refused, by status', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { message: 'Incorrect or missing API key' },
        401,
      )) as unknown as typeof fetch;
    const sample = await probeNeynar({
      apiKey: 'deliberately-wrong-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(sample.ok).toBe(false);
    expect(sample.httpStatus).toBe(401);
    expect(sample.reason).toContain('refused your key');
  });

  it('reports a payment challenge (402) as a refused key too', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: 'X-PAYMENT header or API key required' },
        402,
      )) as unknown as typeof fetch;
    const sample = await probeNeynar({
      apiKey: 'deliberately-wrong-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(sample.httpStatus).toBe(402);
    expect(sample.reason).toContain('refused your key');
  });

  it('uses the newest cast timestamp as the freshness watermark', async () => {
    const fetchImpl = (async () =>
      jsonResponse(neynarFeed)) as unknown as typeof fetch;
    const sample = await probeNeynar({
      apiKey: 'a-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(sample.ok).toBe(true);
    expect(sample.watermark).toBe(Date.parse('2026-10-20T20:00:00.000Z'));
  });

  it('sends the key in a header, never in the URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(neynarFeed);
    }) as unknown as typeof fetch;
    await probeNeynar({
      apiKey: 'a-secret-key',
      provider: neynarProvider(),
      fetchImpl,
    });
    expect(calls[0]!.url).not.toContain('a-secret-key');
    expect(
      (calls[0]!.init?.headers as Record<string, string>)['x-api-key'],
    ).toBe('a-secret-key');
    expect(calls[0]!.url).toContain('/v2/farcaster/feed/channels');
  });
});
