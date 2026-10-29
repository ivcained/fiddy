/**
 * Intrinsic video dimensions learned by the embed renderer.
 *
 * Protocol/provider dimensions remain authoritative. A poster can answer while
 * the attachment is at rest, and loaded media metadata replaces that answer.
 * Every answer is keyed by the video URL, never by the reused player instance.
 *
 * The poster-before-play / metadata-after-load idea is adapted from
 * backmeupplz/quilcast (MIT), commit f049e59f25e327c8f842b150ca468434ae3167a3.
 */

import type { ApiCastEmbeds } from 'farcaster-client-data';

export interface VideoShape {
  width: number;
  height: number;
}

export interface VideoShapeStore {
  learn: (url: string, width: number, height: number) => void;
  read: (url: string) => VideoShape | null;
  revision: () => number;
  subscribe: (listener: () => void) => () => void;
  loadPoster: (
    videoUrl: string,
    posterUrl: string,
  ) => Promise<VideoShape | null>;
}

interface PosterImage {
  naturalWidth: number;
  naturalHeight: number;
  onload: null | (() => void);
  onerror: null | (() => void);
  src: string;
}

export interface VideoShapeStoreOptions {
  imageFactory?: () => PosterImage;
  posterTimeoutMs?: number;
  maxEntries?: number;
}

const realShape = (
  width: number | undefined,
  height: number | undefined,
): VideoShape | null =>
  typeof width === 'number' &&
  Number.isFinite(width) &&
  width > 0 &&
  typeof height === 'number' &&
  Number.isFinite(height) &&
  height > 0
    ? { width, height }
    : null;

export const createVideoShapeStore = (
  options: VideoShapeStoreOptions = {},
): VideoShapeStore => {
  const shapes = new Map<string, VideoShape>();
  const listeners = new Set<() => void>();
  const postersInFlight = new Map<string, Promise<VideoShape | null>>();
  const posterTimeoutMs = options.posterTimeoutMs ?? 4_000;
  const maxEntries = Math.max(1, options.maxEntries ?? 400);
  let revision = 0;
  const imageFactory =
    options.imageFactory ?? (() => new Image() as unknown as PosterImage);
  const learn = (url: string, width: number, height: number): void => {
    const shape = realShape(width, height);
    if (shape === null) {
      return;
    }
    const previous = shapes.get(url);
    shapes.delete(url);
    shapes.set(url, shape);
    while (shapes.size > maxEntries) {
      const oldest = shapes.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      shapes.delete(oldest);
    }
    if (previous?.width !== shape.width || previous.height !== shape.height) {
      revision += 1;
      for (const listener of listeners) {
        listener();
      }
    }
  };
  return {
    learn,
    read: (url) => shapes.get(url) ?? null,
    revision: () => revision,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadPoster: (videoUrl, posterUrl) => {
      const known = shapes.get(videoUrl);
      if (known !== undefined) {
        return Promise.resolve(known);
      }
      const key = `${videoUrl}\n${posterUrl}`;
      const running = postersInFlight.get(key);
      if (running !== undefined) {
        return running;
      }
      const loading = new Promise<VideoShape | null>((resolve) => {
        let image: PosterImage;
        try {
          image = imageFactory();
        } catch {
          resolve(null);
          return;
        }
        let settled = false;
        const finish = (shape: VideoShape | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          if (shape !== null) {
            learn(videoUrl, shape.width, shape.height);
          }
          resolve(shape);
        };
        const timer = setTimeout(() => finish(null), posterTimeoutMs);
        image.onload = () =>
          finish(realShape(image.naturalWidth, image.naturalHeight));
        image.onerror = () => finish(null);
        image.src = posterUrl;
      }).finally(() => postersInFlight.delete(key));
      postersInFlight.set(key, loading);
      return loading;
    },
  };
};

export const defaultVideoShapeStore = createVideoShapeStore();

export const resolveVideoShape = (
  { url, width, height }: { url: string; width?: number; height?: number },
  store: VideoShapeStore = defaultVideoShapeStore,
): VideoShape | null => realShape(width, height) ?? store.read(url);

/** The embed view the existing layout algorithm reads, enriched in place. */
export const withLearnedVideoShapes = (
  embeds: ApiCastEmbeds,
  store: VideoShapeStore = defaultVideoShapeStore,
): ApiCastEmbeds => {
  if (
    !embeds.videos?.some(
      (video) =>
        realShape(video.width, video.height) === null &&
        store.read(video.url) !== null,
    )
  ) {
    return embeds;
  }
  return {
    ...embeds,
    videos: embeds.videos.map((video) => {
      if (realShape(video.width, video.height) !== null) {
        return video;
      }
      const learned = store.read(video.url);
      return learned === null ? video : { ...video, ...learned };
    }),
  };
};
