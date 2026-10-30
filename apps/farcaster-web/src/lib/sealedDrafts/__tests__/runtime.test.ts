import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSealedDraftKeys } from '~/lib/sealedDrafts/keys';
import {
  readSealedValues,
  resetSealedDraftRuntimeForTests,
  sealStorageKey,
  whenSealedValuesReady,
  writeSealedValues,
} from '~/lib/sealedDrafts/runtime';

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

describe('sealed local collections', () => {
  beforeEach(() => {
    resetSealedDraftRuntimeForTests();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('keeps plaintext out of browser storage and makes no network request while sync is off', async () => {
    const storage = fakeStorage();
    writeSealedValues(storage, 42, 'node', {
      s_draft1: { draftId: 'draft1', casts: [{ text: 'unfinished words' }] },
    });
    await whenSealedValuesReady(storage, 42, 'node');

    const persisted = storage.getItem(sealStorageKey(42, 'node')) ?? '';
    expect(persisted).not.toContain('unfinished words');
    expect(persisted).toContain('v1.');
    expect(fetch).not.toHaveBeenCalled();
    expect(readSealedValues(storage, 42, 'node')).toEqual({
      s_draft1: { draftId: 'draft1', casts: [{ text: 'unfinished words' }] },
    });
  });

  it('isolates accounts and restores sealed values after the memory cache is gone', async () => {
    const storage = fakeStorage();
    writeSealedValues(storage, 42, 'node', {
      s_draft1: { draftId: 'draft1', casts: [{ text: 'mine' }] },
    });
    await whenSealedValuesReady(storage, 42, 'node');
    resetSealedDraftRuntimeForTests(storage);

    expect(readSealedValues(storage, 42, 'node')).toEqual({});
    await whenSealedValuesReady(storage, 42, 'node');
    expect(readSealedValues(storage, 42, 'node')).toEqual({
      s_draft1: { draftId: 'draft1', casts: [{ text: 'mine' }] },
    });
    expect(readSealedValues(storage, 43, 'node')).toEqual({});
  });

  it('keeps an honest locked record instead of dropping ciphertext another key wrote', async () => {
    const storage = fakeStorage();
    writeSealedValues(storage, 42, 'node', {
      s_draft1: { draftId: 'draft1', casts: [{ text: 'other device' }] },
    });
    await whenSealedValuesReady(storage, 42, 'node');
    resetSealedDraftRuntimeForTests(storage);
    await clearSealedDraftKeys(42);

    readSealedValues(storage, 42, 'node');
    await whenSealedValuesReady(storage, 42, 'node');
    expect(readSealedValues(storage, 42, 'node')).toEqual({});
    expect(storage.getItem(sealStorageKey(42, 'node'))).toContain('v1.');
  });

  it('survives corrupt stored JSON without throwing or making a request', async () => {
    const storage = fakeStorage();
    storage.setItem(sealStorageKey(42, 'node'), '{broken');
    readSealedValues(storage, 42, 'node');
    await expect(
      whenSealedValuesReady(storage, 42, 'node'),
    ).resolves.toBeUndefined();
    expect(readSealedValues(storage, 42, 'node')).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
});
