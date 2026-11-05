/**
 * An HLS playlist is a video, and this client can now play one.
 *
 * WHY THIS FILE EXISTS
 *
 * `embedKinds.ts` deliberately classified `…m3u8` as a *link* rather than a
 * video, because the web client had no HLS player: calling it a video would
 * have rendered a broken player instead of an honest link. That cost real
 * casts — Farcaster's own video host (`stream.farcaster.xyz/…m3u8`) serves
 * exactly that, so a Farcaster-native video cast drew as a bare link card in
 * this feed.
 *
 * The player is Vidstack (the one player implementation in this tree,
 * `VideoAttachment.tsx`), and Vidstack has an HLS provider built on `hls.js`.
 * This module is the single place that decides *how* a source is handed to it,
 * so the rule can be tested without a browser.
 *
 * THE RULE, AND WHY IT IS NOT `canPlayType`
 *
 * `document.createElement('video').canPlayType('application/vnd.apple.mpegurl')`
 * is the wrong question: Chrome answers `"maybe"` and then plays nothing, so a
 * player gated on it attaches to a stream it cannot decode and shows a dead
 * poster. The honest gate is capability, not opinion:
 *
 *   - `MediaSource` defined  → `hls.js` can demux the playlist (Chrome, Edge,
 *     Firefox, desktop Safari). Vidstack loads `hls.js` lazily on first play.
 *   - `MediaSource` undefined → nothing can be demuxed in JS, so the source is
 *     handed over untouched and the element's own native HLS plays it. That is
 *     iPhone Safari, which is the only browser in our support matrix without
 *     `MediaSource` and the only one where native HLS works.
 *
 * A browser with neither (an old Android WebView, say) gets the plain `<video>`
 * too — it fails in the media element, in place, rather than in a player
 * skeleton that never resolves.
 *
 * Adapted from backmeupplz/quilcast (MIT) 0.65.1 `ca9aa6d02704`: its `Video`
 * gated HLS on `typeof MediaSource !== 'undefined'` for exactly this reason.
 * Its `<video>` + `new Hls()` body is NOT copied — Vidstack owns the media
 * element here, so the provider is configured instead (`hlsLibrary`,
 * `onProviderChange` in `VideoAttachment.tsx`).
 */

/** The media type Vidstack's HLS provider is selected by, and serves. */
export const HLS_MEDIA_TYPE = 'application/x-mpegurl' as const;

/**
 * A playlist's own file name. Asked of the URL's PATH only — never of the
 * network — so this stays synchronous and free, exactly like
 * `embedKindFromExtension`. The query is excluded for the same reason it is
 * there: `https://a.test/post/1?next=a.m3u8` is a page about a playlist, not a
 * playlist, and handing that to the player draws a dead one.
 */
const HLS_PLAYLIST_PATTERN = /\.m3u8$/i;

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** Whether a URL names an HLS playlist. */
export const isHlsPlaylistUrl = (url: string): boolean =>
  HLS_PLAYLIST_PATTERN.test(pathOf(url));

/**
 * Whether this browser can demux HLS in JavaScript.
 *
 * Read at call time, never at module load: the check is about the browser the
 * player will run in, and a module-level constant would be frozen at import —
 * wrong in a test, and wrong in any SSR/prerender pass that imports this file
 * before a `window` exists.
 */
export const browserHasMediaSource = (): boolean =>
  typeof MediaSource !== 'undefined';

/** An HLS playlist as `<MediaPlayer src>` takes it: a source plus its type. */
export type HlsPlayerSource = { src: string; type: typeof HLS_MEDIA_TYPE };

/**
 * The source to hand the player for one embed URL: an explicit HLS source when
 * the playlist has to go through `hls.js`, and the bare URL otherwise (a plain
 * video file, or an HLS playlist this browser plays natively).
 *
 * The string case is a string, not `{ src }`: Vidstack's `MediaSrc` only takes
 * an object when it carries a `type`, and a typeless object is not a source.
 *
 * `type` is what makes the choice explicit rather than inferred from the file
 * name — Vidstack picks its provider from the source it is given, and a
 * playlist served from a URL with no extension (`…/v1/video/<id>/playlist`)
 * would otherwise fall through to the plain video provider and fail.
 */
export const playerSourceOf = (
  url: string,
  hasMediaSource: boolean = browserHasMediaSource(),
): string | HlsPlayerSource =>
  isHlsPlaylistUrl(url) && hasMediaSource
    ? { src: url, type: HLS_MEDIA_TYPE }
    : url;

/**
 * Where Vidstack's HLS provider gets `hls.js` from.
 *
 * It must be this: the provider's own default is
 * `https://cdn.jsdelivr.net/npm/hls.js@^1.5.0/dist/hls.min.js`, which is a
 * third-party script load on a page whose CSP is `script-src 'self'` — it would
 * be blocked, and `verify-no-off-site-reads.mjs` exists to refuse exactly that
 * kind of origin. A function (rather than a URL) makes the provider use a
 * dynamic import, so `hls.js` lands in its own lazy chunk and is fetched only
 * when a playlist is actually played. Never a file, never a CDN.
 */
export const hlsLibrary = () => import('hls.js');
