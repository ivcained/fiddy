/**
 * Bare-text-link previews, as tests.
 *
 * Some clients never hoist a typed link into the protocol embeds, so a cast
 * whose message has no embeds at all used to render no preview even when its
 * text carried a bare http(s) link. The recovery lives at the
 * `castEmbedsFromNode` seam: the first typed public http(s) link stands in as
 * one link embed and flows through the same kind/card chain a real embed gets.
 *
 * These are quilcast's `urlsOf` cases ported to that seam (MIT,
 * https://github.com/backmeupplz/quilcast src/shared.ts): a cast with no
 * embeds recovers its first typed link; embeds always win; blank embed objects
 * recover nothing; and a `javascript:` or malformed string is never recovered.
 */

import type { NodeCastAddBody, NodeEmbed } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { castEmbedsFromNode } from '~/snapchain/nodeApi/fromNode';
import {
  firstTypedLinkOf,
  publicHttpUrlOf,
  recoveredTextLinkOf,
} from '~/snapchain/nodeApi/textLinks';

const body = (text: string, embeds: NodeEmbed[] = []): NodeCastAddBody => ({
  text,
  castType: 'CAST',
  embeds,
  embedsDeprecated: [],
  mentions: [],
  mentionsPositions: [],
});

describe('a cast with no embeds', () => {
  it('recovers the first typed http(s) link as a url embed', () => {
    const result = castEmbedsFromNode({
      body: body('look at this https://example.com/story great read'),
    });

    expect(result.embeds.images).toEqual([]);
    expect(result.embeds.urls).toEqual([
      { type: 'url', openGraph: { url: 'https://example.com/story' } },
    ]);
    expect(result.quoteTargets).toEqual([]);
  });

  it('recovers at most one link, the first one', () => {
    const result = castEmbedsFromNode({
      body: body('https://first.example/a and https://second.example/b'),
    });

    expect(result.embeds.urls).toEqual([
      { type: 'url', openGraph: { url: 'https://first.example/a' } },
    ]);
  });

  it('reads the recovered link card through the same cardOf chain', () => {
    const result = castEmbedsFromNode({
      body: body('https://example.com/story'),
      cardOf: (url) =>
        url === 'https://example.com/story'
          ? { title: 'A page', description: 'Said by its own tags' }
          : undefined,
    });

    expect(result.embeds.urls).toEqual([
      {
        type: 'url',
        openGraph: {
          url: 'https://example.com/story',
          title: 'A page',
          description: 'Said by its own tags',
        },
      },
    ]);
  });

  it('drops the punctuation a sentence hangs on a typed link', () => {
    const result = castEmbedsFromNode({
      body: body('this was great (https://example.com/a).'),
    });

    expect(result.embeds.urls).toEqual([
      { type: 'url', openGraph: { url: 'https://example.com/a' } },
    ]);
  });

  it('recovers nothing from text without a schemed link', () => {
    const result = castEmbedsFromNode({
      body: body('a bare domain like example.com/x is not a typed link'),
    });

    expect(result.embeds.urls).toEqual([]);
  });
});

describe('embeds always win', () => {
  it('ignores text links when the message carries a url embed', () => {
    const result = castEmbedsFromNode({
      body: body('https://typed.example/ignored', [
        { url: 'https://embedded.example/kept' },
      ]),
    });

    expect(result.embeds.urls).toEqual([
      { type: 'url', openGraph: { url: 'https://embedded.example/kept' } },
    ]);
  });

  it('ignores text links when the message carries a quote embed', () => {
    const result = castEmbedsFromNode({
      body: body('https://typed.example/ignored', [
        { castId: { fid: 3, hash: '0xabc' } },
      ]),
    });

    expect(result.embeds.urls).toEqual([]);
    expect(result.quoteTargets).toEqual([{ fid: 3, hash: '0xabc' }]);
  });

  it('recovers nothing when the embeds are blank objects', () => {
    const result = castEmbedsFromNode({
      body: body('https://typed.example/ignored', [{ url: '' }]),
    });

    expect(result.embeds.urls).toEqual([]);
  });
});

describe('the safety rule', () => {
  it('never recovers a javascript: string', () => {
    const result = castEmbedsFromNode({
      body: body('click javascript:alert(1) now'),
    });

    expect(result.embeds.urls).toEqual([]);
  });

  it('never recovers a protocol-relative or unparseable string', () => {
    expect(
      castEmbedsFromNode({ body: body('see //example.com/x') }).embeds.urls,
    ).toEqual([]);
    expect(
      castEmbedsFromNode({ body: body('see https://') }).embeds.urls,
    ).toEqual([]);
  });

  it('never recovers a link that points at a local or private host', () => {
    expect(
      castEmbedsFromNode({ body: body('see http://192.168.0.1/admin') }).embeds
        .urls,
    ).toEqual([]);
    expect(
      castEmbedsFromNode({ body: body('see https://localhost:8080/x') }).embeds
        .urls,
    ).toEqual([]);
  });

  it('never recovers a link carrying credentials', () => {
    expect(
      castEmbedsFromNode({ body: body('see https://user:pass@example.com/x') })
        .embeds.urls,
    ).toEqual([]);
  });
});

describe('the ported helpers', () => {
  it('publicHttpUrlOf keeps only a public http(s) URL, normalized', () => {
    expect(publicHttpUrlOf('https://example.com')).toBe('https://example.com/');
    expect(publicHttpUrlOf('http://example.com/a?b=c#d')).toBe(
      'http://example.com/a?b=c#d',
    );
    expect(publicHttpUrlOf('ftp://example.com/x')).toBeUndefined();
    expect(publicHttpUrlOf('javascript:alert(1)')).toBeUndefined();
    expect(publicHttpUrlOf('https://user@example.com/')).toBeUndefined();
    expect(publicHttpUrlOf('https://10.0.0.4/')).toBeUndefined();
    expect(publicHttpUrlOf('not a url')).toBeUndefined();
    expect(publicHttpUrlOf(undefined)).toBeUndefined();
  });

  it('firstTypedLinkOf skips a schemed candidate the safety rule refuses', () => {
    expect(
      firstTypedLinkOf('https://localhost/x then https://example.com/y'),
    ).toBe('https://example.com/y');
  });

  it('recoveredTextLinkOf answers only for a body with no embeds', () => {
    expect(recoveredTextLinkOf(undefined)).toBeUndefined();
    expect(
      recoveredTextLinkOf(body('https://example.com/x', [{ url: '' }])),
    ).toBeUndefined();
    expect(recoveredTextLinkOf(body('https://example.com/x'))).toBe(
      'https://example.com/x',
    );
  });
});
