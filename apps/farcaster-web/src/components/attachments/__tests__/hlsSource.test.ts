/**
 * The rule that decides how an embed URL reaches the player.
 *
 * Ported intent from backmeupplz/quilcast (MIT) 0.65.1 `ca9aa6d02704`:
 * capability on `MediaSource`, never `canPlayType` (Chrome answers `"maybe"`
 * for an m3u8 it cannot play), and native only where `MediaSource` is absent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  browserHasMediaSource,
  HLS_MEDIA_TYPE,
  hlsLibrary,
  isHlsPlaylistUrl,
  playerSourceOf,
} from '~/components/attachments/hlsSource';

const PLAYLIST = 'https://stream.farcaster.xyz/v1/video/01a02c7e.m3u8';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what counts as a playlist', () => {
  it('reads the extension, with a query and a fragment', () => {
    expect(isHlsPlaylistUrl(PLAYLIST)).toBe(true);
    expect(isHlsPlaylistUrl(`${PLAYLIST}?token=1`)).toBe(true);
    expect(isHlsPlaylistUrl('https://a.test/clip.m3u8#t=1')).toBe(true);
    expect(isHlsPlaylistUrl('https://a.test/clip.M3U8')).toBe(true);
  });

  it('does not answer for other media, or for the letters somewhere else', () => {
    expect(isHlsPlaylistUrl('https://a.test/clip.mp4')).toBe(false);
    expect(isHlsPlaylistUrl('https://a.test/clip.m3u8/notes')).toBe(false);
    expect(isHlsPlaylistUrl('https://a.test/post/1?next=a.m3u8')).toBe(false);
    expect(isHlsPlaylistUrl('https://a.test/m3u8')).toBe(false);
  });
});

describe('which source the player is handed', () => {
  it('routes a playlist through hls.js when the browser can demux', () => {
    expect(playerSourceOf(PLAYLIST, true)).toEqual({
      src: PLAYLIST,
      type: HLS_MEDIA_TYPE,
    });
  });

  it('hands the URL over untouched when there is no MediaSource', () => {
    // iPhone Safari: nothing can be demuxed in JS, and the element's own HLS
    // plays it. A typed `{ src }` here would select the HLS provider, which
    // would then fail to load a library it cannot use.
    expect(playerSourceOf(PLAYLIST, false)).toBe(PLAYLIST);
  });

  it('leaves a plain video file alone in either case', () => {
    for (const hasMediaSource of [true, false]) {
      expect(playerSourceOf('https://a.test/clip.mp4', hasMediaSource)).toBe(
        'https://a.test/clip.mp4',
      );
    }
  });

  it('ignores what canPlayType claims', () => {
    // The bug this port exists for: Chrome says `"maybe"` to an m3u8 and then
    // plays nothing, so a player gated on it attaches to a dead stream.
    const canPlayType = vi.fn(() => 'maybe');
    vi.stubGlobal(
      'document',
      Object.assign(globalThis.document ?? {}, {
        createElement: () => ({ canPlayType }),
      }),
    );
    expect(playerSourceOf(PLAYLIST, true)).toEqual({
      src: PLAYLIST,
      type: HLS_MEDIA_TYPE,
    });
    expect(canPlayType).not.toHaveBeenCalled();
  });
});

describe('the capability check itself', () => {
  it('reads MediaSource at call time, not at import time', () => {
    vi.stubGlobal('MediaSource', undefined);
    expect(browserHasMediaSource()).toBe(false);
    vi.stubGlobal('MediaSource', class {});
    expect(browserHasMediaSource()).toBe(true);
  });

  it('follows the browser it is asked in', () => {
    vi.stubGlobal('MediaSource', undefined);
    expect(playerSourceOf(PLAYLIST)).toBe(PLAYLIST);
    vi.stubGlobal('MediaSource', class {});
    expect(playerSourceOf(PLAYLIST)).toEqual({
      src: PLAYLIST,
      type: HLS_MEDIA_TYPE,
    });
  });
});

describe('where Vidstack gets hls.js', () => {
  it('is our own lazy import, never a CDN script', async () => {
    // A function makes the provider dynamic-import the library, so it lands in
    // its own chunk and is fetched on first playlist only. A string would be a
    // `<script src>` — the default is a jsDelivr CDN URL, which our
    // `script-src 'self'` CSP blocks and `verify-no-off-site-reads.mjs` refuses.
    expect(typeof hlsLibrary).toBe('function');
    const module = await hlsLibrary();
    expect(typeof module.default).toBe('function');
  });
});
