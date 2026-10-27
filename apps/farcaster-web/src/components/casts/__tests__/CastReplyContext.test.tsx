// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { ApiCast } from 'farcaster-client-data';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { CastReplyContext } from '~/components/casts/CastReplyContext';

const PARENT_HASH = '0xd7792fbf5004198c0ec37d12e8626b883c8e52a7';

const reply = {
  hash: '0xf8efbc8682a7d6b1f0eaa2c5e95140f9931cd5a5',
  threadHash: PARENT_HASH,
  parentHash: PARENT_HASH,
  parentAuthor: {
    fid: 4877,
    username: 'trish',
    displayName: 'trish',
    followerCount: 0,
    followingCount: 0,
  },
  author: {
    fid: 15211,
    username: 'statuette',
    displayName: 'statuette',
    followerCount: 0,
    followingCount: 0,
  },
  text: 'a short reply',
  timestamp: 1_700_000_000_000,
  replies: { count: 0 },
  watches: { count: 0 },
} as ApiCast;

afterEach(cleanup);

describe('CastReplyContext', () => {
  it('names the parent author and links to the parent conversation', () => {
    const { container } = render(
      <MemoryRouter>
        <CastReplyContext cast={reply} />
      </MemoryRouter>,
    );

    const context = container.querySelector('[data-fiddy="reply-context"]');
    expect(context?.textContent).toBe('Replying to @trish');
    expect(context?.getAttribute('data-parent-hash')).toBe(PARENT_HASH);
    expect(screen.getByTitle('Open parent cast').getAttribute('href')).toBe(
      `/~/conversations/${PARENT_HASH}`,
    );
  });
});
