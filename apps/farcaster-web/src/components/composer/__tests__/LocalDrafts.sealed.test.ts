// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  getLocalDraft,
  setLocalDraft,
  whenLocalDraftsReady,
} from '~/components/composer/LocalDrafts';
import { clearSealedDraftKeys } from '~/lib/sealedDrafts/keys';
import {
  resetSealedDraftRuntimeForTests,
  sealedCacheEntry,
  sealStorageKey,
} from '~/lib/sealedDrafts/runtime';

describe('sealed composer recovery', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    resetSealedDraftRuntimeForTests();
    await clearSealedDraftKeys(42);
  });

  it('starts hydration before a fresh composer reads its recovery draft', async () => {
    const draft = {
      casts: [{ text: 'recover me after reload', embeds: [] }],
      channelKey: undefined,
      parentCastHash: undefined,
      scheduledAt: undefined,
      updatedAt: Date.now(),
    };
    setLocalDraft(draft, 'cast:new', 42);
    await whenLocalDraftsReady(42);
    expect(
      window.localStorage.getItem(sealStorageKey(42, 'recovery')),
    ).not.toContain('recover me after reload');

    resetSealedDraftRuntimeForTests(window.localStorage);
    await whenLocalDraftsReady(42);

    const hydrated = sealedCacheEntry(window.localStorage, 42, 'recovery');
    expect(hydrated.lockedCount).toBe(0);
    expect(hydrated.records).toHaveProperty('r_Y2FzdDpuZXc');
    expect(hydrated.values).toMatchObject({
      r_Y2FzdDpuZXc: {
        casts: [{ text: 'recover me after reload', embeds: [] }],
      },
    });
    expect(getLocalDraft('cast:new', 42)).toMatchObject({
      casts: [{ text: 'recover me after reload', embeds: [] }],
    });
  });

  it('clears a posted draft with a tombstone instead of a plaintext delete only', async () => {
    setLocalDraft(
      {
        casts: [{ text: 'posted', embeds: [] }],
        channelKey: undefined,
        parentCastHash: undefined,
        scheduledAt: undefined,
        updatedAt: Date.now(),
      },
      'cast:new',
      42,
    );
    await whenLocalDraftsReady(42);
    setLocalDraft(undefined, 'cast:new', 42);
    await whenLocalDraftsReady(42);

    expect(getLocalDraft('cast:new', 42)).toBeUndefined();
    expect(
      window.localStorage.getItem(sealStorageKey(42, 'recovery')),
    ).toContain('"box":null');
  });
});
