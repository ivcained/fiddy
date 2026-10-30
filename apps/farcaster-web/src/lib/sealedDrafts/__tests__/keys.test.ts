import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSealedDraftKeys,
  enrollSealedDraftKey,
  listSealedDraftKeys,
  recoverSealedDraftKey,
} from '~/lib/sealedDrafts/keys';

describe('sealed draft key enrollment', () => {
  beforeEach(async () => {
    await clearSealedDraftKeys(42);
  });

  it('keeps the active browser key non-extractable and returns a recovery code once', async () => {
    const { recoveryCode } = await enrollSealedDraftKey(42);
    const keys = await listSealedDraftKeys(42);
    expect(keys).toHaveLength(1);
    expect(keys[0].extractable).toBe(false);
    expect(recoveryCode.length).toBeGreaterThan(40);
    expect(recoveryCode).not.toContain('=');
  });

  it('recovers on another device and keeps older keys for locked drafts', async () => {
    const { recoveryCode } = await enrollSealedDraftKey(42);
    await clearSealedDraftKeys(42);
    await recoverSealedDraftKey(42, recoveryCode);
    await enrollSealedDraftKey(42);
    const keys = await listSealedDraftKeys(42);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => !key.extractable)).toBe(true);
  });
});
