/**
 * The thing that actually watches: one loop, one live server, one story.
 *
 * This module keeps the answers the whole client needs, readable synchronously
 * and from anywhere, because the reads adapter asks "where do my answers come
 * from?" during a render:
 *
 *   order        the reader's servers, in their order (see `catalog`)
 *   health       what each one measured last time (see `health`)
 *   failover     which one is live, and why (see `failover`)
 *
 * A module store rather than React state on purpose — the same reason
 * `nodeChoice` is one: the fetch seam cannot suspend, and a check that runs on a
 * timer has to be able to hand its result to whatever is rendering right now.
 *
 * The loop checks every `checkIntervalMs` (a minute), all servers at once, and
 * moves the live one only through `nextFailoverState`. It also reacts to the
 * reader changing their mind: choosing a server in the picker re-runs the checks
 * immediately instead of waiting out the interval.
 */

import {
  getActiveNodeChoice,
  subscribeToNodeChoice,
} from '~/snapchain/nodeChoice';

import { resolveProviderOrder } from './catalog';
import {
  DEFAULT_FAILOVER_CONFIG,
  type FailoverConfig,
  type FailoverState,
  initialFailoverState,
  nextFailoverState,
} from './failover';
import {
  DEFAULT_HEALTH_CONFIG,
  type FreshnessRecord,
  type HealthConfig,
  judgeFreshness,
  judgeProbe,
  probeProvider,
  type ProbeSample,
  type ProviderHealth,
} from './health';
import {
  loadProviderOrder,
  neynarApiKeyFromEnv,
  saveProviderOrder,
} from './preferences';
import type { NodeProvider } from './providerTypes';

export interface ProviderRuntimeSnapshot {
  order: NodeProvider[];
  health: Record<string, ProviderHealth>;
  failover: FailoverState;
  /** The server answering right now, or null before the first check lands. */
  activeId: string | null;
  /** Why that server is the live one, in plain words. */
  explanation: string;
  /** True while a round of checks is in flight. */
  checking: boolean;
  lastCheckedAt: number | null;
  /** True when the reader turned the whole thing off. */
  paused: boolean;
}

export interface ProviderRuntimeOptions {
  fetchImpl?: typeof fetch;
  healthConfig?: HealthConfig;
  failoverConfig?: FailoverConfig;
  /** Test seam: skip the network entirely. */
  probe?: (provider: NodeProvider) => Promise<ProbeSample>;
  /** Test seam: no timers. */
  autoStart?: boolean;
}

let snapshot: ProviderRuntimeSnapshot = {
  order: [],
  health: {},
  failover: initialFailoverState(0),
  activeId: null,
  explanation: '',
  checking: false,
  lastCheckedAt: null,
  paused: false,
};

const listeners = new Set<() => void>();
const freshnessByProvider = new Map<string, FreshnessRecord>();

let options: ProviderRuntimeOptions = {};
let fid: number | null = null;
let storedIds: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeChoice: (() => void) | null = null;
let running = false;
let checkInFlight: Promise<void> | null = null;

const notify = (): void => {
  listeners.forEach((listener) => listener());
};

const setSnapshot = (next: Partial<ProviderRuntimeSnapshot>): void => {
  snapshot = { ...snapshot, ...next };
  notify();
};

export const getProviderSnapshot = (): ProviderRuntimeSnapshot => snapshot;

export const subscribeToProviders = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const apiKey = (): string | null => neynarApiKeyFromEnv();

/** The reader's servers in order, as they stand right now. */
export const currentProviderOrder = (): NodeProvider[] =>
  resolveProviderOrder({
    chosen: getActiveNodeChoice(),
    storedIds,
    neynarConfigured: apiKey() !== null,
  });

const refreshOrder = (): NodeProvider[] => {
  const order = currentProviderOrder();
  setSnapshot({ order });
  return order;
};

const probe = async (provider: NodeProvider): Promise<ProbeSample> => {
  if (options.probe) {
    return options.probe(provider);
  }
  return probeProvider({
    provider,
    apiKey: apiKey(),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    config: options.healthConfig ?? DEFAULT_HEALTH_CONFIG,
  });
};

/**
 * One round of checks: measure every server, then move the live one if the
 * measurements say to. The order is decided before the probes so a provider the
 * reader just added is measured in the same round it appears in.
 */
export const checkProvidersNow = async (): Promise<void> => {
  if (checkInFlight) {
    return checkInFlight;
  }
  const run = (async () => {
    const order = refreshOrder();
    if (order.length === 0) {
      setSnapshot({ checking: false });
      return;
    }

    setSnapshot({ checking: true });
    const healthConfig = options.healthConfig ?? DEFAULT_HEALTH_CONFIG;
    const results = await Promise.all(
      order.map(async (provider) => {
        const sample = await probe(provider);
        const now = Date.now();
        const judgement = judgeFreshness(
          freshnessByProvider.get(provider.id),
          sample.watermark,
          now,
          healthConfig,
        );
        freshnessByProvider.set(provider.id, judgement.record);
        return judgeProbe({
          providerId: provider.id,
          sample,
          freshness: judgement.freshness,
          config: healthConfig,
          now,
        });
      }),
    );

    const health: Record<string, ProviderHealth> = { ...snapshot.health };
    for (const entry of results) {
      health[entry.providerId] = entry;
    }

    const decision = nextFailoverState({
      order,
      health,
      state: snapshot.failover,
      now: Date.now(),
      config: options.failoverConfig ?? DEFAULT_FAILOVER_CONFIG,
    });

    setSnapshot({
      order,
      health,
      failover: decision.state,
      activeId: decision.state.activeId,
      explanation: decision.explanation,
      checking: false,
      lastCheckedAt: Date.now(),
    });
  })();

  checkInFlight = run.finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
};

/** The live server's descriptor, or null when nothing is live yet. */
export const getActiveProvider = (): NodeProvider | null => {
  const { activeId, order } = snapshot;
  if (activeId === null) {
    return order[0] ?? null;
  }
  return order.find((provider) => provider.id === activeId) ?? order[0] ?? null;
};

/** The provider that would answer next if the live one were skipped. */
export const getProviderById = (id: string | null): NodeProvider | null =>
  id === null
    ? null
    : (snapshot.order.find((provider) => provider.id === id) ?? null);

/**
 * Start watching. Loading the reader's stored order is part of starting, so a
 * caller that forgot to await anything still gets the right list.
 */
export const startProviderWatch = async (
  forFid: number | null,
  runtimeOptions: ProviderRuntimeOptions = {},
): Promise<void> => {
  options = runtimeOptions;
  if (forFid !== fid) {
    fid = forFid;
    storedIds = forFid === null ? [] : await loadProviderOrder(forFid);
    // A different account is a different list; judge nothing on the old one.
    freshnessByProvider.clear();
    snapshot = {
      ...snapshot,
      health: {},
      failover: initialFailoverState(Date.now()),
      activeId: null,
      explanation: '',
    };
  }

  if (unsubscribeChoice === null) {
    unsubscribeChoice = subscribeToNodeChoice(() => {
      // The reader changed where they read from: measure again now rather than
      // waiting out the interval, so the pill never shows a stale answer.
      void checkProvidersNow();
    });
  }

  if (running) {
    await checkProvidersNow();
    return;
  }

  running = true;
  setSnapshot({ paused: false });
  await checkProvidersNow();

  if (runtimeOptions.autoStart === false) {
    return;
  }
  const interval = (runtimeOptions.failoverConfig ?? DEFAULT_FAILOVER_CONFIG)
    .checkIntervalMs;
  timer = setInterval(() => {
    void checkProvidersNow();
  }, interval);
};

export const stopProviderWatch = (): void => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (unsubscribeChoice !== null) {
    unsubscribeChoice();
    unsubscribeChoice = null;
  }
  running = false;
  checkInFlight = null;
};

/** Store the reader's order and use it at once. */
export const chooseProviderOrder = async (
  forFid: number,
  ids: string[],
): Promise<void> => {
  storedIds = ids;
  if (fid === forFid) {
    await saveProviderOrder(forFid, ids);
  }
  await checkProvidersNow();
};

/** Move one provider to the front of the reader's list. */
export const preferProvider = async (
  forFid: number,
  id: string,
): Promise<void> => {
  const rest = storedIds.filter((entry) => entry !== id);
  await chooseProviderOrder(forFid, [id, ...rest]);
};

export const isProviderIdStored = (id: string): boolean =>
  storedIds.includes(id);

/** The ids currently stored, for the picker's own rendering. */
export const storedProviderIds = (): string[] => [...storedIds];

/** Test seam: put the store back to nothing, with no timers running. */
export const resetProviderRuntimeForTests = (): void => {
  stopProviderWatch();
  snapshot = {
    order: [],
    health: {},
    failover: initialFailoverState(0),
    activeId: null,
    explanation: '',
    checking: false,
    lastCheckedAt: null,
    paused: false,
  };
  freshnessByProvider.clear();
  fid = null;
  storedIds = [];
  options = {};
};
