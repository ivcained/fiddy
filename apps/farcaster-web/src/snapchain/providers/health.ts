/**
 * "Is this server worth reading from right now?" — the measurement half.
 *
 * A server can be up and still be the wrong one to read from: out of sync, or
 * answering so slowly that the feed takes a minute to appear. So a check
 * measures two separate things and says which one is bad:
 *
 *   speed      how long the answer took (a request that never answers is a
 *              failure with a deadline, not a hang — this is a browser)
 *   freshness  is this server still following the network?
 *              - a Snapchain node reports it directly: `blockDelay` is how many
 *                blocks behind the tip it is, and `isSyncing` says it is
 *                catching up. Both are measured, not guessed.
 *              - Neynar and `api.farcaster.xyz` publish no such field, so for
 *                Neynar we watch the newest timestamp on a busy channel: a
 *                watermark that stops moving is a stale index.
 *              - `api.farcaster.xyz` cannot report its lag at all, so its
 *                freshness is reported as `unknown` rather than invented. That
 *                is exactly why it is the last provider in any order.
 *
 * Nothing here throws at a caller: a probe always answers with a sample, and a
 * sample that failed carries a sentence in plain words saying why.
 */

import type { NodeProvider } from './providerTypes';

export type ProviderStatus =
  | 'live'
  | 'slow'
  | 'stale'
  | 'down'
  | 'unconfigured';

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface ProbeSample {
  ok: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  /** Plain-words reason when the probe did not come back usable. */
  reason: string | null;
  /** A number that only moves forward while the server follows the network. */
  watermark: number | null;
  /** This server says it is still catching up. */
  catchingUp: boolean;
  /** How far behind the tip the server says it is, when it says anything. */
  blocksBehind: number | null;
}

export interface ProviderHealth {
  providerId: string;
  status: ProviderStatus;
  latencyMs: number | null;
  watermark: number | null;
  freshness: Freshness;
  /** One sentence for a human, in plain words. */
  detail: string;
  checkedAt: number;
}

export interface HealthConfig {
  /** A request that takes longer than this counts as slow. */
  slowMs: number;
  /** A request that has not answered by then is a failure. */
  timeoutMs: number;
  /** A server says it is more than this many blocks behind → stale. */
  maxBlocksBehind: number;
  /** A watermark that has not moved for this long → stale. */
  staleAfterMs: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  // MEASURED (2026-10-20): a healthy public read node answers /v1/info in
  // 0.19–1.6s. Five seconds is several times the worst healthy answer, which is
  // where "slow enough to switch away from" belongs.
  slowMs: 5_000,
  timeoutMs: 5_000,
  // blogDelay is in blocks behind the chain tip; a node a handful of blocks
  // behind is normal, a node minutes behind is not following.
  maxBlocksBehind: 20,
  // Two minutes of a frozen watermark while we are watching is a stalled index.
  staleAfterMs: 120_000,
};

interface FreshnessRecord {
  watermark: number | null;
  /** When the watermark last moved forward. */
  advancedAt: number | null;
  /** When we first looked at this server. */
  firstSeenAt: number;
}

export interface FreshnessJudgement {
  freshness: Freshness;
  record: FreshnessRecord;
}

/**
 * Judge freshness from a watermark that should only move forward.
 *
 * Deliberately not "is the newest thing recent": a quiet server can be perfectly
 * in sync. The question is whether the number is still moving. A first look
 * cannot answer that, so it says `unknown` and starts the clock.
 */
export const judgeFreshness = (
  previous: FreshnessRecord | undefined,
  watermark: number | null,
  now: number,
  config: HealthConfig = DEFAULT_HEALTH_CONFIG,
): FreshnessJudgement => {
  if (watermark === null) {
    return {
      freshness: 'unknown',
      record: previous ?? {
        watermark: null,
        advancedAt: null,
        firstSeenAt: now,
      },
    };
  }

  if (!previous || previous.watermark === null) {
    return {
      freshness: 'unknown',
      record: {
        watermark,
        advancedAt: now,
        firstSeenAt: previous?.firstSeenAt ?? now,
      },
    };
  }

  if (watermark > previous.watermark) {
    return {
      freshness: 'fresh',
      record: { ...previous, watermark, advancedAt: now },
    };
  }

  const stillSince = previous.advancedAt ?? previous.firstSeenAt;
  const freshness: Freshness =
    now - stillSince >= config.staleAfterMs ? 'stale' : 'fresh';
  return { freshness, record: { ...previous, watermark: previous.watermark } };
};

/** The sentence a human reads for each status. */
export const statusDetail = (
  status: ProviderStatus,
  sample: { reason: string | null; latencyMs: number | null },
): string => {
  switch (status) {
    case 'live':
      return sample.latencyMs === null
        ? 'Answering normally.'
        : `Answering normally, in about ${(sample.latencyMs / 1000).toFixed(1)}s.`;
    case 'slow':
      return sample.latencyMs === null
        ? 'Answering, but slowly.'
        : `Answering, but slowly — about ${(sample.latencyMs / 1000).toFixed(1)}s.`;
    case 'stale':
      return (
        sample.reason ??
        'Answering, but it has stopped keeping up with the network.'
      );
    case 'unconfigured':
      return sample.reason ?? 'This one still needs your key.';
    case 'down':
    default:
      return sample.reason ?? 'It did not answer.';
  }
};

/**
 * Turn one probe's raw result into the status the client acts on.
 *
 * Kept pure and separate from the network so the pill's claims and the
 * failover's decisions are testable without a browser: the only inputs are a
 * sample and a freshness judgement.
 */
export const judgeProbe = ({
  providerId,
  sample,
  freshness,
  config = DEFAULT_HEALTH_CONFIG,
  now,
}: {
  providerId: string;
  sample: ProbeSample;
  freshness: Freshness;
  config?: HealthConfig;
  now: number;
}): ProviderHealth => {
  let status: ProviderStatus;
  if (!sample.ok) {
    status = 'down';
  } else if (
    sample.catchingUp ||
    (sample.blocksBehind ?? 0) > config.maxBlocksBehind
  ) {
    status = 'stale';
  } else if (freshness === 'stale') {
    status = 'stale';
  } else if ((sample.latencyMs ?? 0) > config.slowMs) {
    status = 'slow';
  } else {
    status = 'live';
  }

  const reason =
    status === 'stale' && sample.ok
      ? sample.catchingUp
        ? 'It answered, but it says it is still catching up with the network.'
        : `It answered, but it is ${sample.blocksBehind} blocks behind the network.`
      : sample.reason;

  return {
    providerId,
    status,
    latencyMs: sample.latencyMs,
    watermark: sample.watermark,
    freshness,
    detail: statusDetail(status, { reason, latencyMs: sample.latencyMs }),
    checkedAt: now,
  };
};

/** A probe that failed before it could say anything. */
const failedSample = (
  reason: string,
  latencyMs: number | null,
): ProbeSample => ({
  ok: false,
  latencyMs,
  httpStatus: null,
  reason,
  watermark: null,
  catchingUp: false,
  blocksBehind: null,
});

/**
 * Fetch with a deadline that survives the body read.
 *
 * `AbortController` alone would leave the timer armed past the response; the
 * timer is cleared in `finally` so a page that probes every minute never grows
 * a pile of live timers.
 */
const fetchWithDeadline = async (
  url: string,
  {
    fetchImpl,
    timeoutMs,
    headers,
  }: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    headers?: Record<string, string>;
  },
): Promise<{
  response: Response | null;
  latencyMs: number;
  aborted: boolean;
}> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      // A probe is a read of a stranger's server: never send credentials, and
      // never let a cached answer stand in for a measurement.
      credentials: 'omit',
      cache: 'no-store',
    });
    return { response, latencyMs: Date.now() - started, aborted: false };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      response: null,
      latencyMs: Date.now() - started,
      aborted:
        aborted || (error instanceof Error && error.name === 'AbortError'),
    };
  } finally {
    clearTimeout(timer);
  }
};

const readJson = async (response: Response): Promise<unknown | null> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

/** Largest `maxHeight` a Snapchain `/v1/info` body reports, or null. */
const snapchainWatermark = (body: unknown): number | null => {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as Record<string, unknown>;
  const heights: number[] = [];
  const shards = record.shardInfos;
  if (Array.isArray(shards)) {
    for (const shard of shards) {
      const height = (shard as { maxHeight?: unknown })?.maxHeight;
      if (typeof height === 'number' && Number.isFinite(height)) {
        heights.push(height);
      }
    }
  }
  if (
    typeof record.maxHeight === 'number' &&
    Number.isFinite(record.maxHeight)
  ) {
    heights.push(record.maxHeight);
  }
  return heights.length > 0 ? Math.max(...heights) : null;
};

/** How many blocks behind the tip the node says it is. */
const snapchainBlocksBehind = (body: unknown): number | null => {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as Record<string, unknown>;
  const delays: number[] = [];
  const shards = record.shardInfos;
  if (Array.isArray(shards)) {
    for (const shard of shards) {
      const delay = (shard as { blockDelay?: unknown })?.blockDelay;
      if (typeof delay === 'number' && Number.isFinite(delay)) {
        delays.push(delay);
      }
    }
  }
  if (
    typeof record.blockDelay === 'number' &&
    Number.isFinite(record.blockDelay)
  ) {
    delays.push(record.blockDelay);
  }
  return delays.length > 0 ? Math.max(...delays) : null;
};

/**
 * Probe a Snapchain node: `GET /v1/info`.
 *
 * The node reports its own version, whether it is syncing and per-shard
 * heights, which is the strongest freshness signal any of the three kinds of
 * provider offers — so a snapchain provider is judged on what the node says
 * about itself, not on a guess.
 */
export const probeSnapchain = async ({
  provider,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  provider: NodeProvider;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  if (provider.baseUrl.trim().length === 0) {
    return failedSample('This one has no address yet.', null);
  }

  const { response, latencyMs, aborted } = await fetchWithDeadline(
    `${provider.baseUrl}/v1/info?dbstats=0`,
    { fetchImpl, timeoutMs: config.timeoutMs },
  );

  if (!response) {
    return failedSample(
      aborted
        ? `It did not answer within ${config.timeoutMs / 1000}s.`
        : 'It did not answer at all.',
      latencyMs,
    );
  }

  if (!response.ok) {
    return {
      ...failedSample(
        `It answered with an error (${response.status}).`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const body = await readJson(response);
  if (body === null) {
    return {
      ...failedSample(
        'It answered, but not like a node — no chain status came back.',
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const record = body as Record<string, unknown>;
  if (!Number.isFinite(snapchainWatermark(body))) {
    // A 200 that carries no heights is not a node this client can read:
    // answering "fine" here would make the pill vouch for a stranger's HTML.
    return {
      ...failedSample(
        'It answered, but not like a node — no chain status came back.',
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  return {
    ok: true,
    latencyMs,
    httpStatus: response.status,
    reason: null,
    watermark: snapchainWatermark(body),
    catchingUp: record.isSyncing === true,
    blocksBehind: snapchainBlocksBehind(body),
  };
};

/** Newest ISO timestamp in a Neynar feed body, as milliseconds. */
const newestNeynarTimestamp = (body: unknown): number | null => {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const casts = (body as { casts?: unknown }).casts;
  if (!Array.isArray(casts)) {
    return null;
  }
  const stamps: number[] = [];
  for (const cast of casts) {
    const raw = (cast as { timestamp?: unknown })?.timestamp;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) {
        stamps.push(parsed);
      }
    }
  }
  return stamps.length > 0 ? Math.max(...stamps) : null;
};

/**
 * Probe Neynar.
 *
 * Two honest answers it can give: no key (`unconfigured`, a setup task, not a
 * fault), and a key that was refused (401/402 — measured: a wrong key comes
 * back either "Incorrect or missing API key" or a payment challenge). A usable
 * key gets one cheap documented read whose newest timestamp is the watermark.
 */
export const probeNeynar = async ({
  apiKey,
  provider,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  apiKey: string | null;
  provider: NodeProvider;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  if (!apiKey || apiKey.trim().length === 0) {
    return failedSample(
      'Neynar needs your key before it can be used. Run scripts/fiddy-setup.command to add it.',
      null,
    );
  }

  const { response, latencyMs, aborted } = await fetchWithDeadline(
    `${provider.baseUrl}/v2/farcaster/feed/channels?channel_ids=base&limit=5`,
    {
      fetchImpl,
      timeoutMs: config.timeoutMs,
      headers: { 'x-api-key': apiKey.trim() },
    },
  );

  if (!response) {
    return failedSample(
      aborted
        ? `It did not answer within ${config.timeoutMs / 1000}s.`
        : 'It did not answer at all.',
      latencyMs,
    );
  }

  if (response.status === 401 || response.status === 402) {
    return {
      ...failedSample(
        `Neynar refused your key (${response.status}). Check the key, or the plan it belongs to.`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  if (!response.ok) {
    return {
      ...failedSample(
        `Neynar answered with an error (${response.status}).`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const body = await readJson(response);
  return {
    ok: true,
    latencyMs,
    httpStatus: response.status,
    reason: null,
    watermark: newestNeynarTimestamp(body),
    catchingUp: false,
    blocksBehind: null,
  };
};

/**
 * Probe `api.farcaster.xyz`: one documented public read that needs no account.
 *
 * It reports reachability and speed, and freshness stays `unknown` — this API
 * publishes nothing about how far behind it is, and this client will not
 * pretend otherwise.
 */
export const probeFarcasterPublic = async ({
  provider,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  provider: NodeProvider;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  const { response, latencyMs, aborted } = await fetchWithDeadline(
    `${provider.baseUrl}/fc/primary-address?fid=12152&protocol=ethereum`,
    { fetchImpl, timeoutMs: config.timeoutMs },
  );

  if (!response) {
    return failedSample(
      aborted
        ? `It did not answer within ${config.timeoutMs / 1000}s.`
        : 'It did not answer at all.',
      latencyMs,
    );
  }

  if (!response.ok) {
    return {
      ...failedSample(
        `It answered with an error (${response.status}).`,
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  const body = await readJson(response);
  if (body === null || typeof body !== 'object') {
    return {
      ...failedSample(
        'It answered with something that was not a list.',
        latencyMs,
      ),
      httpStatus: response.status,
    };
  }

  return {
    ok: true,
    latencyMs,
    httpStatus: response.status,
    reason: null,
    watermark: null,
    catchingUp: false,
    blocksBehind: null,
  };
};

/** Probe whichever kind of server this provider is. */
export const probeProvider = async ({
  provider,
  apiKey,
  fetchImpl = fetch,
  config = DEFAULT_HEALTH_CONFIG,
}: {
  provider: NodeProvider;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  config?: HealthConfig;
}): Promise<ProbeSample> => {
  switch (provider.kind) {
    case 'neynar':
      return probeNeynar({ apiKey, provider, fetchImpl, config });
    case 'farcaster-public':
      return probeFarcasterPublic({ provider, fetchImpl, config });
    case 'snapchain':
    default:
      return probeSnapchain({ provider, fetchImpl, config });
  }
};

export type { FreshnessRecord };
