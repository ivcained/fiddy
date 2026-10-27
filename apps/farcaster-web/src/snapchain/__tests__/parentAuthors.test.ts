import { ApiUser } from 'farcaster-client-data';
import { NodeMessage } from 'farcaster-node-client';
import { describe, expect, it, vi } from 'vitest';

import { readParentAuthors } from '~/snapchain/parentAuthors';

const PARENT = '0xd7792fbf5004198c0ec37d12e8626b883c8e52a7';

const reply = (hash: string): NodeMessage =>
  ({
    fid: 15211,
    hash,
    signer: `0x${'11'.repeat(32)}`,
    timestampMs: 1_700_000_000_000,
    castAdd: {
      text: 'reply',
      mentions: [],
      mentionsPositions: [],
      parentCastId: { fid: 42, hash: PARENT },
    },
  }) as unknown as NodeMessage;

describe('readParentAuthors', () => {
  it('reads a reply parent once and returns its real profile', async () => {
    const parentAuthor = { fid: 42, username: 'parent-author' } as ApiUser;
    const castById = vi.fn(async () => ({ ...reply(PARENT), fid: 42 }));
    const readAuthor = vi.fn(async () => parentAuthor);

    const authors = await readParentAuthors({
      messages: [reply('0xreply-one'), reply('0xreply-two')],
      castById,
      readAuthor,
    });

    expect(castById).toHaveBeenCalledTimes(1);
    expect(castById).toHaveBeenCalledWith(42, PARENT);
    expect(readAuthor).toHaveBeenCalledWith(42);
    expect(authors.get(PARENT)).toBe(parentAuthor);
  });
});
