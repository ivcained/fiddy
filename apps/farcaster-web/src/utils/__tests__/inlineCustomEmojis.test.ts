/**
 * The inline-custom-emoji resolver (FIP draft "Inline Custom Emoji"): which
 * labelled embeds a cast draws in its text, at what size, and the FIP's
 * fallback — a :label: no labelled embed carries stays text, and a labelled
 * embed that isn't a picture keeps its card.
 */

import { describe, expect, it } from 'vitest';

import {
  castLabelledEmbeds,
  EMOJI_LABEL,
  emojiPic,
  emojisOf,
} from '~/utils/inlineCustomEmojis';

describe('EMOJI_LABEL', () => {
  it('accepts the labels the FIP allows', () => {
    expect(EMOJI_LABEL.test('wave')).toBe(true);
    expect(EMOJI_LABEL.test('a1_b-c')).toBe(true);
    expect(EMOJI_LABEL.test('_leading_underscore')).toBe(true);
    expect(EMOJI_LABEL.test('0')).toBe(true);
  });

  it('rejects too-long, upper-case, and symbol labels', () => {
    expect(EMOJI_LABEL.test('-leading_hyphen')).toBe(false);
    expect(EMOJI_LABEL.test('UPPER')).toBe(false);
    expect(EMOJI_LABEL.test('with space')).toBe(false);
    expect(EMOJI_LABEL.test('x'.repeat(33))).toBe(false);
  });
});

describe('emojiPic', () => {
  it('accepts a picture by extension', () => {
    expect(emojiPic('https://host.com/a.png')).toBe(true);
    expect(emojiPic('https://host.com/a.webp?x=1')).toBe(true);
  });

  it('accepts a picture host without an extension', () => {
    expect(emojiPic('https://imagedelivery.net/a/b/original')).toBe(true);
    expect(emojiPic('https://i.imgur.com/abc')).toBe(true);
  });

  it('refuses a video, a page, and a site front page', () => {
    expect(emojiPic('https://host.com/a.mp4')).toBe(false);
    expect(emojiPic('https://host.com/a.html')).toBe(false);
    expect(emojiPic('https://host.com/')).toBe(false);
    expect(emojiPic('https://warpcast.com/~/a')).toBe(false);
  });
});

describe('emojisOf', () => {
  const picture = 'https://host.com/emoji.webp';

  it('maps a labelled picture whose :label: the text says', () => {
    const out = emojisOf([{ emojiLabel: 'wave', url: picture }], 'gm :wave:');
    expect([...out]).toEqual([['wave', picture]]);
  });

  it('ignores a labelled embed whose :label: the text does not say', () => {
    expect(
      emojisOf([{ emojiLabel: 'wave', url: picture }], 'gm :nope:').size,
    ).toBe(0);
  });

  it('keeps a :label: with no labelled embed as text (the FIP fallback)', () => {
    expect(emojisOf([], 'gm :wave:').size).toBe(0);
  });

  it('keeps a non-picture labelled embed out (its card stays, label stays)', () => {
    expect(
      emojisOf(
        [{ emojiLabel: 'wave', url: 'https://host.com/page.html' }],
        'gm :wave:',
      ).size,
    ).toBe(0);
  });

  it('lets the first embed with a label win', () => {
    const out = emojisOf(
      [
        { emojiLabel: 'wave', url: 'https://a.com/1.webp' },
        { emojiLabel: 'wave', url: 'https://b.com/2.webp' },
      ],
      'gm :wave:',
    );
    expect(out.get('wave')).toBe('https://a.com/1.webp');
  });

  it('keeps a label that fell out of translation out (shown as a picture)', () => {
    // The shown text no longer says :wave: — the picture shows beneath instead.
    expect(emojisOf([{ emojiLabel: 'wave', url: picture }], 'hello').size).toBe(
      0,
    );
  });
});

describe('castLabelledEmbeds', () => {
  it('gathers labelled embeds from both the image and url buckets', () => {
    const embeds = {
      images: [{ emojiLabel: 'wave', url: 'https://a.com/1.webp' }],
      urls: [
        { openGraph: { url: 'https://b.com/2.webp' }, emojiLabel: 'fire' },
        { openGraph: { url: 'https://c.com/plain' } },
      ],
    };
    expect(castLabelledEmbeds(embeds)).toEqual([
      { emojiLabel: 'wave', url: 'https://a.com/1.webp' },
      { emojiLabel: 'fire', url: 'https://b.com/2.webp' },
    ]);
  });

  it('returns an empty list with no embeds', () => {
    expect(castLabelledEmbeds(undefined)).toEqual([]);
  });
});
