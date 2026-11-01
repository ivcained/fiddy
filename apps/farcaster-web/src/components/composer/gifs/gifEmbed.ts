// Adapted from quilcast (MIT), https://github.com/backmeupplz/quilcast
// (src/compose.tsx `gif` + src/shared.ts `withGif` at 2abe184cc734) —
// concept-level: theirs attaches the GIF to a post's file list; ours goes
// through the canonical embed store's `addEmbed` as a direct `.gif` URL embed
// (medium/full/tiny fallback is chosen server-side in
// server/instance/gifs.mjs — nothing is uploaded).

import type { ApiCastEmbeds, ApiCastUrlEmbed } from 'farcaster-client-data';

import type { GifSearchResult } from './gifSearch';

/**
 * The staged card a picked GIF gets in the composer. We already know
 * everything about this URL — the search answered with it — so rather than
 * make the embed pipeline crawl the GIF's own URL for open-graph metadata, the
 * picker seeds the cast-attachment preview cache with this synthesised embed.
 * `title` and `description` are non-empty on purpose: an embed without both
 * reads as "the crawl couldn't answer" and the pipeline would crawl it anyway
 * (castComposerMetadataEnrichment.isUrlEmbedIncomplete).
 */
export const buildGifUrlEmbed = (gif: GifSearchResult): ApiCastUrlEmbed => {
  let domain: string | undefined;
  try {
    domain = new URL(gif.cast).hostname || undefined;
  } catch {
    domain = undefined;
  }
  return {
    type: 'url',
    openGraph: {
      url: gif.cast,
      title: gif.title || 'GIF',
      description: gif.title ? `GIF: ${gif.title}` : 'A GIF',
      image: gif.preview,
      ...(domain ? { domain } : {}),
    },
  };
};

/** The preview-cache value for one picked GIF: just the one URL embed. */
export const buildGifPreviewCacheEmbeds = (
  gif: GifSearchResult,
): ApiCastEmbeds => ({
  urls: [buildGifUrlEmbed(gif)],
  images: [],
  videos: [],
  unknowns: [],
});
