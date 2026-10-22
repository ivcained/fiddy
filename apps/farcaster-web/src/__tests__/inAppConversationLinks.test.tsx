// @vitest-environment jsdom

/**
 * The link inside the app to a cast's own page.
 *
 * It used to be the pretty `/<handle>/<0x prefix>` route, which the node-backed
 * client answers with "This page isn't on your node": that route is read
 * through `/v2/user-thread-casts` and a Snapchain node shards by FID, so no node
 * can answer a hash prefix at all (measured live 2026-10-22, card t_5068bb26).
 * The timestamp inside every cast in the feed is that link, so this is the page
 * a reader tapped and could not open.
 *
 * These tests hold the shape that replaced it: the full hash, on the route a
 * node can address — and the same page `getFiddyCastUrl` copies when somebody
 * shares the cast, so the link inside the app and the link somebody else opens
 * are one page.
 */

import { cleanup, render } from '@testing-library/react';
import { ApiCast, getCastHashPrefix } from 'farcaster-client-data';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { LinkToConversation } from '~/components/links/LinkToConversation';

const HASH = `0x${'a'.repeat(40)}`;

const cast = {
  hash: HASH,
  author: { fid: 3, username: 'dwr' },
} as unknown as ApiCast;

const hrefOf = (element: ApiCast) => {
  const { container } = render(
    <MemoryRouter>
      <LinkToConversation cast={element} title="" />
    </MemoryRouter>,
  );
  const href = container.querySelector('a[href]')?.getAttribute('href') ?? null;
  cleanup();
  return href;
};

describe('the link to a cast inside this client', () => {
  it('is the full-hash route, never the prefix route', () => {
    const href = hrefOf(cast);

    expect(href).toBe(`/~/conversations/${HASH}`);
    // The prefix the fork used to paint — and the route a node cannot read.
    expect(href).not.toBe(`/dwr/${getCastHashPrefix({ castHash: HASH })}`);
    expect(href).not.toMatch(/^\/[^/]+\/0x/);
    // The whole hash is in the URL: this is what makes a cold open answerable
    // without an indexer (the reader resolves the author from the hash).
    expect(href).toContain(HASH);
  });

  it('is the same route when the author has no handle at all', () => {
    const anonymous = {
      hash: HASH,
      author: { fid: 3, username: undefined },
    } as unknown as ApiCast;

    expect(hrefOf(anonymous)).toBe(`/~/conversations/${HASH}`);
  });
});
