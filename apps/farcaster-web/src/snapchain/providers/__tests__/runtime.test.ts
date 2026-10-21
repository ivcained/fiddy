/**
 * The watching loop, as tests — the wiring, not the arithmetic.
 *
 * `failover.test.ts` proves the decision rule on its own. This file proves the
 * loop that feeds it: that the reader's stored order is loaded, that a first
 * choice which stops answering hands the feed to a backup and says so, that a
 * first choice which recovers gets it back, and that three failed reads in a row
 * are enough to move off a server whose status check still looks fine.
 *
 * The network is stubbed out entirely (`probe`), and no timers are started.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      store.has(key) ? store.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import { FARCASTER_PUBLIC_PROVIDER_ID } from '~/snapchain/providers/catalog';
import type { ProbeSample } from '~/snapchain/providers/health';
import { providerPillView } from '~/snapchain/providers/pill';
import {
  checkProvidersNow,
  chooseProviderOrder,
  getProviderSnapshot,
  noteProviderReadResult,
  READ_ERRORS_BEFORE_DOWN,
  resetProviderRuntimeForTests,
  startProviderWatch,
} from '~/snapchain/providers/runtime';

// These tests describe a build WITHOUT a Neynar key: `catalog.ts` puts Neynar
// first when one exists, so without this the developer's own `.env.local` would
// decide what "the reader's first choice" means in the assertions below.
vi.stubEnv('VITE_NEYNAR_API_KEY', '');

const FID = 4242;
const DEAD = 'snapchain:https://dead.example';
/** Fiddy's own relay: the full node that rides behind whatever the reader chose. */
const RELAY = 'snapchain:https://haatz.quilibrium.com';

const sample = (overrides: Partial<ProbeSample> = {}): ProbeSample => ({
  ok: true,
  latencyMs: 200,
  httpStatus: 200,
  reason: null,
  watermark: 100,
  catchingUp: false,
  blocksBehind: 0,
  ...overrides,
});

const down = (): ProbeSample =>
  sample({
    ok: false,
    reason: 'It did not answer at all.',
    watermark: null,
    httpStatus: null,
  });

const slow = (): ProbeSample => sample({ latencyMs: 6_400 });

/** The dead server is dead; Farcaster's own public server always answers. */
const probeWhere =
  (deadAreDown: boolean) => async (provider: { id: string }) =>
    provider.id === DEAD && deadAreDown ? down() : sample();

beforeEach(() => {
  store.clear();
  resetProviderRuntimeForTests();
});

describe('startProviderWatch', () => {
  it('measures the reader’s stored order, dead first, live second', async () => {
    store.set(`snapchain_provider_order_${FID}`, [DEAD]);
    await startProviderWatch(FID, {
      probe: probeWhere(true),
      autoStart: false,
    });

    const snapshot = getProviderSnapshot();
    expect(snapshot.order.map((provider) => provider.id)).toEqual([
      DEAD,
      RELAY,
      FARCASTER_PUBLIC_PROVIDER_ID,
    ]);
    // Nothing was live before the checks, so the first pick is not a switch —
    // and the fallback is the next full node, not the read-only safety net.
    expect(snapshot.activeId).toBe(RELAY);
    expect(snapshot.health[DEAD]!.status).toBe('down');
    expect(snapshot.health[FARCASTER_PUBLIC_PROVIDER_ID]!.status).toBe('live');
  });

  it('keeps the reader on their choice while it answers', async () => {
    await chooseProviderOrder(FID, [DEAD]);
    await startProviderWatch(FID, {
      probe: probeWhere(false),
      autoStart: false,
    });

    const snapshot = getProviderSnapshot();
    expect(snapshot.activeId).toBe(DEAD);
    expect(snapshot.readErrors[DEAD]).toBeUndefined();
  });

  it('moves to a backup when the first choice goes slow, and says it in the pill', async () => {
    store.set(`snapchain_provider_order_${FID}`, [DEAD]);
    const probe = async (provider: { id: string }) =>
      provider.id === DEAD ? slow() : sample();
    await startProviderWatch(FID, { probe, autoStart: false });

    const snapshot = getProviderSnapshot();
    expect(snapshot.activeId).toBe(RELAY);
    expect(snapshot.failover.reason).toBe('preferred-slow');
    expect(providerPillView(snapshot).label).toBe(
      'Switched to a backup node — your first choice got slow.',
    );
  });

  it('comes back to the first choice after it recovers, once the cooldown has passed', async () => {
    store.set(`snapchain_provider_order_${FID}`, [DEAD]);
    let deadIsDown = true;
    const probe = async (provider: { id: string }) =>
      provider.id === DEAD && deadIsDown ? down() : sample();

    await startProviderWatch(FID, { probe, autoStart: false });
    expect(getProviderSnapshot().activeId).toBe(RELAY);

    // The first choice comes back. One good check is not recovery — the engine
    // wants two in a row before it moves the reader back.
    deadIsDown = false;
    await checkProvidersNow();
    expect(getProviderSnapshot().activeId).toBe(RELAY);
    expect(getProviderSnapshot().failover.preferredGoodChecks).toBe(1);

    await checkProvidersNow();
    expect(getProviderSnapshot().activeId).toBe(DEAD);
    expect(getProviderSnapshot().failover.reason).toBe('backup-recovered');
    expect(getProviderSnapshot().explanation).toContain('answering again');
  });
});

describe('noteProviderReadResult', () => {
  it('moves off a server that fails read after read, even though it answers status checks', async () => {
    store.set(`snapchain_provider_order_${FID}`, [DEAD]);
    await startProviderWatch(FID, {
      probe: probeWhere(false),
      autoStart: false,
    });
    expect(getProviderSnapshot().activeId).toBe(DEAD);

    for (let i = 1; i < READ_ERRORS_BEFORE_DOWN; i += 1) {
      noteProviderReadResult({ providerId: DEAD, ok: false });
      expect(getProviderSnapshot().activeId).toBe(DEAD);
    }
    noteProviderReadResult({ providerId: DEAD, ok: false });

    const snapshot = getProviderSnapshot();
    expect(snapshot.readErrors[DEAD]).toBe(READ_ERRORS_BEFORE_DOWN);
    expect(snapshot.activeId).toBe(RELAY);
    expect(snapshot.explanation).toContain('stopped answering');
    expect(snapshot.health[DEAD]!.detail).toContain('3 in a row failed');
  });

  it('forgets the streak on the next good read', async () => {
    store.set(`snapchain_provider_order_${FID}`, [DEAD]);
    await startProviderWatch(FID, {
      probe: probeWhere(false),
      autoStart: false,
    });

    noteProviderReadResult({ providerId: DEAD, ok: false });
    noteProviderReadResult({ providerId: DEAD, ok: false });
    noteProviderReadResult({ providerId: DEAD, ok: true });
    expect(getProviderSnapshot().readErrors[DEAD]).toBeUndefined();
    noteProviderReadResult({ providerId: DEAD, ok: false });
    expect(getProviderSnapshot().readErrors[DEAD]).toBe(1);
    expect(getProviderSnapshot().activeId).toBe(DEAD);
  });

  it('ignores a provider that is not on the list', async () => {
    await startProviderWatch(FID, {
      probe: probeWhere(false),
      autoStart: false,
    });
    noteProviderReadResult({
      providerId: 'snapchain:https://stranger.example',
      ok: false,
    });
    expect(
      getProviderSnapshot().readErrors['snapchain:https://stranger.example'],
    ).toBeUndefined();
  });
});
