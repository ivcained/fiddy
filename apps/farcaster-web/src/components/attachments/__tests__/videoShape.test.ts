import { describe, expect, it, vi } from 'vitest';

import {
  createVideoShapeStore,
  resolveVideoShape,
  withLearnedVideoShapes,
} from '~/components/attachments/videoShape';

describe('video embed shapes', () => {
  it('keeps protocol dimensions authoritative over a learned shape', () => {
    const store = createVideoShapeStore();
    store.learn('https://media.test/tall.mp4', 404, 720);

    expect(
      resolveVideoShape(
        {
          url: 'https://media.test/tall.mp4',
          width: 1920,
          height: 1080,
        },
        store,
      ),
    ).toEqual({ width: 1920, height: 1080 });
  });

  it("learns a poster's natural dimensions before playback", async () => {
    const poster = {
      naturalWidth: 0,
      naturalHeight: 0,
      onload: null as null | (() => void),
      onerror: null as null | (() => void),
      src: '',
    };
    const store = createVideoShapeStore({ imageFactory: () => poster });

    const loading = store.loadPoster(
      'https://media.test/tall.mp4',
      'https://media.test/tall.jpg',
    );
    expect(poster.src).toBe('https://media.test/tall.jpg');
    poster.naturalWidth = 404;
    poster.naturalHeight = 720;
    poster.onload?.();

    await expect(loading).resolves.toEqual({ width: 404, height: 720 });
    expect(store.read('https://media.test/tall.mp4')).toEqual({
      width: 404,
      height: 720,
    });
  });

  it('notifies the cast layout when media metadata replaces the poster shape', () => {
    const store = createVideoShapeStore();
    const listener = vi.fn();
    store.learn('https://media.test/tall.mp4', 404, 720);
    const revision = store.revision();
    const unsubscribe = store.subscribe(listener);

    store.learn('https://media.test/tall.mp4', 1080, 1920);

    expect(store.read('https://media.test/tall.mp4')).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(store.revision()).toBeGreaterThan(revision);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("keeps a reused player from carrying one URL's shape to another", () => {
    const store = createVideoShapeStore();
    store.learn('https://media.test/a.mp4', 1080, 1920);

    expect(
      resolveVideoShape({ url: 'https://media.test/b.mp4' }, store),
    ).toBeNull();
    store.learn('https://media.test/b.mp4', 0, 0);
    expect(store.read('https://media.test/b.mp4')).toBeNull();
  });

  it('enriches only videos whose provider omitted usable dimensions', () => {
    const store = createVideoShapeStore();
    store.learn('https://media.test/tall.mp4', 1080, 1920);
    store.learn('https://media.test/wide.mp4', 1920, 1080);
    const embeds = {
      images: [],
      urls: [],
      unknowns: [],
      videos: [
        {
          type: 'video' as const,
          url: 'https://media.test/tall.mp4',
          sourceUrl: 'https://media.test/tall.mp4',
        },
        {
          type: 'video' as const,
          url: 'https://media.test/wide.mp4',
          sourceUrl: 'https://media.test/wide.mp4',
          width: 1280,
          height: 720,
        },
      ],
    };

    const enriched = withLearnedVideoShapes(embeds, store);

    expect(enriched.videos?.[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(enriched.videos?.[1]).toMatchObject({ width: 1280, height: 720 });
  });

  it('keeps the honest fallback when a poster never answers', async () => {
    const store = createVideoShapeStore({
      imageFactory: () => ({
        naturalWidth: 0,
        naturalHeight: 0,
        onload: null,
        onerror: null,
        src: '',
      }),
      posterTimeoutMs: 1,
    });

    await expect(
      store.loadPoster(
        'https://media.test/missing.mp4',
        'https://media.test/missing.jpg',
      ),
    ).resolves.toBeNull();
    expect(store.read('https://media.test/missing.mp4')).toBeNull();
  });
});
