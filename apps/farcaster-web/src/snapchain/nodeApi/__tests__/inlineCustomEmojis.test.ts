/**
 * The node adapter keeps a url embed's FIP "Inline Custom Emoji" label
 * (`emoji_label`) when it turns a node cast into Fiddy's ApiCast embeds, on
 * whichever bucket the picture lands in — the image bucket when the node
 * classifies it a picture, the url bucket when nothing could.
 */

import { NodeCastAddBody } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { castEmbedsFromNode } from '~/snapchain/nodeApi/fromNode';

const bodyWithEmbed = (
  emojiLabel: string,
  url = 'https://host.com/emoji.webp',
): NodeCastAddBody => ({
  text: `gm :${emojiLabel}:`,
  castType: 'CAST',
  embeds: [{ url, emoji_label: emojiLabel }],
  embedsDeprecated: [],
  mentions: [],
  mentionsPositions: [],
});

describe('inline custom emojis (emoji_label) through the node adapter', () => {
  it('carries emoji_label onto an image embed', () => {
    const { embeds } = castEmbedsFromNode({ body: bodyWithEmbed('wave') });
    expect(embeds.images).toHaveLength(1);
    expect(embeds.images[0].emojiLabel).toBe('wave');
    expect(embeds.urls).toHaveLength(0);
  });

  it('carries emoji_label onto a url embed when the picture is not classified', () => {
    // A picture host with no extension and no probe answer stays a link card,
    // but keeps its label so the renderer can still draw it inline.
    const { embeds } = castEmbedsFromNode({
      body: bodyWithEmbed('wave', 'https://imagedelivery.net/a/b/original'),
      embedKind: () => undefined,
    });
    expect(embeds.urls).toHaveLength(1);
    expect(embeds.urls[0].emojiLabel).toBe('wave');
  });

  it('drops an empty label', () => {
    const { embeds } = castEmbedsFromNode({
      body: {
        ...bodyWithEmbed('wave'),
        embeds: [{ url: 'https://host.com/emoji.webp', emoji_label: '' }],
      },
    });
    expect(embeds.images[0].emojiLabel).toBeUndefined();
  });

  it('leaves a plain embed unlabelled', () => {
    const { embeds } = castEmbedsFromNode({
      body: {
        ...bodyWithEmbed('wave'),
        embeds: [{ url: 'https://host.com/photo.png' }],
      },
    });
    expect(embeds.images[0].emojiLabel).toBeUndefined();
  });
});
