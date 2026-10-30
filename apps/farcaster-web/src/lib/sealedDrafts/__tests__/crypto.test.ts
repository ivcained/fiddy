import { describe, expect, it } from 'vitest';

import {
  compareSealedDraftVersions,
  createDraftRecoveryCode,
  importDraftRecoveryCode,
  openSealedDraftBox,
  sealDraftValue,
} from '~/lib/sealedDrafts/crypto';

const key = (extractable = false) =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
  ]);

describe('sealed draft crypto', () => {
  it('round trips a draft without putting its plaintext in the box', async () => {
    const draftKey = await key();
    const box = await sealDraftValue({
      key: draftKey,
      fid: 42,
      id: 'draft-1',
      value: { text: 'not sent yet', embeds: ['https://example.com/a.png'] },
    });

    expect(box).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(box).not.toContain('not sent yet');
    await expect(
      openSealedDraftBox({ key: draftKey, fid: 42, id: 'draft-1', box }),
    ).resolves.toEqual({
      text: 'not sent yet',
      embeds: ['https://example.com/a.png'],
    });
  });

  it('refuses the wrong key, another account, another id, and tampering', async () => {
    const draftKey = await key();
    const box = await sealDraftValue({
      key: draftKey,
      fid: 42,
      id: 'draft-1',
      value: { text: 'private' },
    });

    await expect(
      openSealedDraftBox({ key: await key(), fid: 42, id: 'draft-1', box }),
    ).rejects.toThrow();
    await expect(
      openSealedDraftBox({ key: draftKey, fid: 43, id: 'draft-1', box }),
    ).rejects.toThrow();
    await expect(
      openSealedDraftBox({ key: draftKey, fid: 42, id: 'draft-2', box }),
    ).rejects.toThrow();
    const parts = box.split('.');
    const first = parts[2][0];
    parts[2] = `${first === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    await expect(
      openSealedDraftBox({
        key: draftKey,
        fid: 42,
        id: 'draft-1',
        box: parts.join('.'),
      }),
    ).rejects.toThrow();
  });

  it('rejects malformed boxes instead of returning partial data', async () => {
    const draftKey = await key();
    for (const box of ['', 'v1.nope', 'v2.aaaaaaaaaaaaaaaa.aaaa', 'v1...']) {
      await expect(
        openSealedDraftBox({ key: draftKey, fid: 42, id: 'draft-1', box }),
      ).rejects.toThrow();
    }
  });

  it('exports a recovery code only from an explicitly extractable enrollment key', async () => {
    const enrollmentKey = await key(true);
    const code = await createDraftRecoveryCode(enrollmentKey);
    const recovered = await importDraftRecoveryCode(code);
    expect(recovered.extractable).toBe(false);
    const value = { text: 'across devices' };
    const box = await sealDraftValue({
      key: enrollmentKey,
      fid: 42,
      id: 'draft-1',
      value,
    });
    await expect(
      openSealedDraftBox({ key: recovered, fid: 42, id: 'draft-1', box }),
    ).resolves.toEqual(value);
    await expect(importDraftRecoveryCode('not a key')).rejects.toThrow();
  });

  it('uses the same deterministic conflict order as the server', () => {
    expect(
      compareSealedDraftVersions(
        { updatedAt: 20, writerId: 'b' },
        { updatedAt: 10, writerId: 'a' },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSealedDraftVersions(
        { updatedAt: 10, writerId: 'a' },
        { updatedAt: 10, writerId: 'b' },
      ),
    ).toBeGreaterThan(0);
  });
});
