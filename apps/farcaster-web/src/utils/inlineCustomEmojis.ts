/**
 * Inline custom emojis, per the FIP draft "Inline Custom Emoji"
 * (farcasterorg/protocol discussion #28; the field as a node serves it):
 * a url embed carrying `emoji_label` is drawn in the cast's text wherever the
 * text says :label:, at the text's height, and not shown again beneath.
 *
 * This is an adaptation of the render-side logic from backmeupplz/quilcast
 * (0.110.x, commits 095e9ef8eb0b / 3968448fbc32, MIT), ported onto Fiddy's own
 * embed shapes and text renderer rather than merged upstream. The pure helpers
 * below mirror upstream's `EMOJI_LABEL` / `emojiPic` / `emojisOf`; the way the
 * drawn :label: tokens are turned into <img> elements is Fiddy's own, because
 * Fiddy linkifies cast text instead of rendering Markdown.
 *
 * FIP fallback kept: text whose :label: no labelled embed carries — or a
 * labelled embed that is not a picture (a video, a page, a mini app) — keeps
 * the :label: as text, and places without pictures (notifications, cards,
 * meta) keep the :label: text too. A labelled embed whose label got lost in
 * translation (the reader sees different text) shows as a picture under the
 * cast rather than being drawn inline.
 */

/**
 * A label the FIP allows: 1–32 of a-z, 0-9, `_`, `-`, not starting with a
 * hyphen. `:label:` in the text names the embed that carries it.
 */
export const EMOJI_LABEL = /^[a-z0-9_][a-z0-9_-]{0,31}$/;

const isImgUrl = (u: string) =>
  /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u) ||
  /imagedelivery\.net|i\.imgur\.com/.test(u);

const isVidUrl = (u: string) => /\.(mp4|m4v|mov|webm|ogv)(\?|$)/i.test(u);

/** A site's front page, a .html/.php page, or a Farcaster/Quilcast page — a
 *  link card keeps its card, so none of these can be an emoji's picture. */
const isPageLikeUrl =
  /^https?:\/\/[^/?#]+\/?(?:[?#]|$)|^[^?#]*\.(?:html?|php)(?:[?#]|$)|^https?:\/\/(?:[^/?#]*\.)?(?:farcaster\.xyz|warpcast\.com|quilcast\.com)(?:[/?#:]|$)/i;

/** Whether a labelled embed could be an emoji's picture: a picture host (an
 *  extension, or a host that serves images with no extension) that is not a
 *  video and not a page that keeps its card. */
export const emojiPic = (u: string): boolean =>
  isImgUrl(u) || (!isVidUrl(u) && !isPageLikeUrl.test(u));

/** An embed that may carry a label, as Fiddy shapes it. */
export type LabelledEmbed = { emojiLabel?: string; url: string };

/**
 * The labelled embeds of a cast (image and url buckets — a labelled emoji
 * picture lands in whichever bucket the node classified it into), each as a
 * `{ label, url }` pair ready for `emojisOf`.
 */
export const castLabelledEmbeds = (
  embeds:
    | {
        images?: { emojiLabel?: string; url: string }[];
        urls?: { openGraph: { url: string }; emojiLabel?: string }[];
      }
    | undefined,
): LabelledEmbed[] => {
  if (!embeds) {
    return [];
  }
  const out: LabelledEmbed[] = [];
  for (const image of embeds.images ?? []) {
    if (image.emojiLabel) {
      out.push({ emojiLabel: image.emojiLabel, url: image.url });
    }
  }
  for (const url of embeds.urls ?? []) {
    if (url.emojiLabel) {
      out.push({ emojiLabel: url.emojiLabel, url: url.openGraph.url });
    }
  }
  return out;
};

/**
 * A cast's inline custom emojis, label → picture url: each labelled embed
 * whose label the *shown* text (`text`, a translation if one is shown) really
 * says, the first embed with a label winning. `emojiPic` keeps non-picture
 * labelled embeds (video/page/mini app) out, so their cards render as always
 * and their :label: stays text.
 */
export const emojisOf = (
  embeds: LabelledEmbed[] | undefined,
  text: string,
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const embed of embeds ?? []) {
    const label = embed.emojiLabel;
    const url = embed.url;
    if (
      url &&
      emojiPic(url) &&
      typeof label === 'string' &&
      EMOJI_LABEL.test(label) &&
      !out.has(label) &&
      text.includes(`:${label}:`)
    ) {
      out.set(label, url);
    }
  }
  return out;
};

/** Whether a drawn inline emoji is a label Fiddy's text renderer will draw. */
export const isDrawnEmojiLabel = (
  label: string | undefined,
  emojis: Map<string, string>,
): boolean => typeof label === 'string' && label !== '' && emojis.has(label);
