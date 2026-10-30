import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const payload = btoa(JSON.stringify({ fid: 42, exp: Date.now() + 60_000 }))
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/u, '');
const token = `fiddy-owner.${payload}.signature`;

vi.mock('~/lib/agentService', () => ({
  DEFAULT_AGENT_SERVICE_URL: 'https://fiddy.fun',
  loadAgentSession: async () => ({ baseUrl: 'https://fiddy.fun', token }),
  saveAgentSession: vi.fn(),
}));

import { sealDraftValue } from '~/lib/sealedDrafts/crypto';
import {
  enrollSealedDraftKey,
  listSealedDraftKeys,
} from '~/lib/sealedDrafts/keys';
import {
  readSealedValues,
  whenSealedValuesReady,
  writeSealedValues,
} from '~/lib/sealedDrafts/runtime';
import { syncDraftsNow } from '~/lib/sealedDrafts/sync';

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
};

describe('cross-device sealed draft sync', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { hostname: 'fiddy.fun' },
      dispatchEvent: vi.fn(),
    });
  });

  it('lets a newer remote draft win and never sends plaintext in a request', async () => {
    const storage = fakeStorage();
    storage.setItem('fiddy:sealed-drafts:sync:42', 'yes');
    await enrollSealedDraftKey(42);
    const [key] = await listSealedDraftKeys(42);
    writeSealedValues(storage, 42, 'node', {
      s_draft1: { draftId: 'draft1', casts: [{ text: 'old offline words' }] },
    });
    await whenSealedValuesReady(storage, 42, 'node');
    const localRecord = JSON.parse(
      storage.getItem('fiddy:sealed-drafts:v1:42:node') ?? '{}',
    ).records[0];
    const remote = {
      id: 's_draft1',
      box: await sealDraftValue({
        key,
        fid: 42,
        id: 's_draft1',
        value: { draftId: 'draft1', casts: [{ text: 'newer other device' }] },
      }),
      updatedAt: localRecord.updatedAt + 1000,
      writerId: crypto.randomUUID(),
    };
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        if (init?.body) {
          bodies.push(String(init.body));
        }
        return init?.method === 'PUT'
          ? Response.json({ ok: true, draft: JSON.parse(String(init.body)) })
          : Response.json({ ok: true, drafts: [remote] });
      }),
    );

    await syncDraftsNow(storage, 42);

    expect(readSealedValues(storage, 42, 'node')).toEqual({
      s_draft1: { draftId: 'draft1', casts: [{ text: 'newer other device' }] },
    });
    expect(bodies.join('\n')).not.toContain('newer other device');
    expect(bodies.join('\n')).not.toContain('old offline words');
  });

  it('keeps an undecryptable remote draft visible as locked, not silently gone', async () => {
    const storage = fakeStorage();
    storage.setItem('fiddy:sealed-drafts:sync:42', 'yes');
    await enrollSealedDraftKey(42);
    const otherKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const remote = {
      id: 's_other',
      box: await sealDraftValue({
        key: otherKey,
        fid: 42,
        id: 's_other',
        value: { draftId: 'other', casts: [{ text: 'locked words' }] },
      }),
      updatedAt: Date.now(),
      writerId: crypto.randomUUID(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) =>
        init?.method === 'PUT'
          ? Response.json({ ok: true, draft: JSON.parse(String(init.body)) })
          : Response.json({ ok: true, drafts: [remote] }),
      ),
    );

    await syncDraftsNow(storage, 42);

    expect(readSealedValues(storage, 42, 'node')).toEqual({});
    expect(storage.getItem('fiddy:sealed-drafts:v1:42:node')).toContain(
      remote.box,
    );
    const { getDraftSyncState } = await import('~/lib/sealedDrafts/sync');
    expect(getDraftSyncState(storage, 42).lockedCount).toBe(1);
  });

  it('applies a newer remote tombstone instead of resurrecting the local text', async () => {
    const storage = fakeStorage();
    storage.setItem('fiddy:sealed-drafts:sync:42', 'yes');
    await enrollSealedDraftKey(42);
    writeSealedValues(storage, 42, 'node', {
      s_deleted: {
        draftId: 'deleted',
        casts: [{ text: 'offline stale copy' }],
      },
    });
    await whenSealedValuesReady(storage, 42, 'node');
    const localRecord = JSON.parse(
      storage.getItem('fiddy:sealed-drafts:v1:42:node') ?? '{}',
    ).records[0];
    const remote = {
      id: 's_deleted',
      box: null,
      updatedAt: localRecord.updatedAt + 1000,
      writerId: crypto.randomUUID(),
    };
    const puts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts.push(String(init.body));
        }
        return init?.method === 'PUT'
          ? Response.json({ ok: true, draft: JSON.parse(String(init.body)) })
          : Response.json({ ok: true, drafts: [remote] });
      }),
    );

    await syncDraftsNow(storage, 42);

    expect(readSealedValues(storage, 42, 'node')).toEqual({});
    expect(storage.getItem('fiddy:sealed-drafts:v1:42:node')).toContain(
      '"box":null',
    );
    expect(puts).toHaveLength(0);
  });

  it('makes no hosted request on a self-hosted install', async () => {
    window.location.hostname = 'drafts.localhost';
    const storage = fakeStorage();
    storage.setItem('fiddy:sealed-drafts:sync:42', 'yes');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await syncDraftsNow(storage, 42);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.getItem('fiddy:sealed-drafts:v1:42:node')).toBeNull();
  });

  it('keeps local drafts readable when the sync service fails', async () => {
    const storage = fakeStorage();
    storage.setItem('fiddy:sealed-drafts:sync:42', 'yes');
    writeSealedValues(storage, 42, 'node', {
      s_offline: { draftId: 'offline', casts: [{ text: 'still mine' }] },
    });
    await whenSealedValuesReady(storage, 42, 'node');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 503 })),
    );

    await expect(syncDraftsNow(storage, 42)).rejects.toThrow('503');

    expect(readSealedValues(storage, 42, 'node')).toEqual({
      s_offline: { draftId: 'offline', casts: [{ text: 'still mine' }] },
    });
  });
});
