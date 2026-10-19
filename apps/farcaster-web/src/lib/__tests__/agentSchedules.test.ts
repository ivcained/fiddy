// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadSchedules,
  newScheduleId,
  saveSchedules,
  type ScheduleRequest,
  upsertSchedule,
} from '~/lib/agentSchedules';

// In-memory stand-in for the browser store: the module under test is the
// validation and merge logic, not localforage.
const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: async ({ key, fallback }: { key: string; fallback: unknown }) =>
    store.has(key) ? store.get(key) : fallback,
  setItem: async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  },
  deleteItem: async (key: string) => {
    store.delete(key);
  },
}));

const schedule = (over: Partial<ScheduleRequest> = {}): ScheduleRequest => ({
  id: 's1',
  agentId: 'a1',
  prompt: 'Every morning at 9, read my mentions',
  state: 'requested',
  createdAt: 1_792_000_000_000,
  ...over,
});

beforeEach(() => {
  store.clear();
});

describe('schedule records', () => {
  it('round-trips through storage', async () => {
    await saveSchedules('a1', [schedule()]);
    await expect(loadSchedules('a1')).resolves.toEqual([schedule()]);
  });

  it('keeps schedules per agent', async () => {
    await saveSchedules('a1', [schedule()]);
    await expect(loadSchedules('a2')).resolves.toEqual([]);
  });

  it('drops rows that storage cannot vouch for', async () => {
    store.set('fiddy.agent.schedules.a1', [
      schedule(),
      { id: 'x', agentId: 'a1' },
      { ...schedule({ id: 's2' }), state: 'married' },
      null,
    ]);

    const loaded = await loadSchedules('a1');

    expect(loaded.map((item) => item.id)).toEqual(['s1']);
  });

  it('treats a non-array as empty instead of throwing', async () => {
    store.set('fiddy.agent.schedules.a1', '{"not":"an array"}');
    await expect(loadSchedules('a1')).resolves.toEqual([]);
  });
});

describe('upsertSchedule', () => {
  it('prepends a new request and keeps history', () => {
    const next = upsertSchedule([schedule()], schedule({ id: 's2' }));
    expect(next.map((item) => item.id)).toEqual(['s2', 's1']);
  });

  it('replaces in place when the agent answers the same request', () => {
    const answered = schedule({
      state: 'answered',
      reply: 'Scheduled for 09:00.',
    });
    const next = upsertSchedule([schedule()], answered);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(answered);
    // The log must not lose the prompt when the reply lands.
    expect(next[0].prompt).toBe(schedule().prompt);
  });
});

describe('newScheduleId', () => {
  it('is unique enough to key a list', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newScheduleId()));
    expect(ids.size).toBe(200);
  });
});
