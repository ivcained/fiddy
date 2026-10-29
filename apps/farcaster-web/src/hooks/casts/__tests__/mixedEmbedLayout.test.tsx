// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import type {
  ApiCast,
  ApiCastEmbeds,
  ApiCastUrlEmbed,
  ApiMediaV2,
  ApiOpenGraphMetadata,
} from 'farcaster-client-data';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CastAttachmentsSection } from '~/components/casts/CastAttachmentsSection';
import { useCastAttachmentDebug } from '~/hooks/casts/useCastBody';

vi.mock('farcaster-client-hooks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('farcaster-client-hooks')>();
  return {
    ...actual,
    processMediasForRendering: ({ medias }: { medias: ApiMediaV2[] }) =>
      medias.map((media) => ({ original: media.staticRaster })),
    useTelemetry: () => ({ maybeAddFrameDroppingAction: vi.fn() }),
  };
});

vi.mock('~/components/attachments/ImageAttachments', () => ({
  ImageAttachments: ({
    images,
    height,
    carouselIndex,
    noShrink,
  }: {
    images: ApiCastEmbeds['images'];
    height?: number;
    carouselIndex?: number;
    noShrink?: boolean;
  }) =>
    React.createElement('div', {
      'data-carousel-index': carouselIndex,
      'data-height': height,
      'data-no-shrink': noShrink,
      'data-testid': 'image-attachment',
      'data-url': images[0].url,
    }),
}));

vi.mock('~/components/attachments/VideoAttachment', () => ({
  VideoAttachment: ({
    url,
    tileHeight,
  }: {
    url: string;
    tileHeight?: number;
  }) =>
    React.createElement('div', {
      'data-testid': 'video-attachment',
      'data-tile-height': tileHeight,
      'data-url': url,
    }),
}));

vi.mock('~/components/attachments/OpenGraphAttachment', () => ({
  OpenGraphAttachment: ({
    attachment,
    height,
    width,
  }: {
    attachment: ApiOpenGraphMetadata;
    height?: number;
    width?: number;
  }) =>
    React.createElement(
      'article',
      {
        'data-height': height,
        'data-testid': 'og-card',
        'data-url': attachment.url,
        'data-width': width,
      },
      React.createElement('img', { alt: '', 'data-testid': 'og-card-media' }),
    ),
}));

vi.mock('~/components/attachments/FrameEmbedAttachment', () => ({
  FrameEmbedAttachment: () =>
    React.createElement('div', { 'data-testid': 'miniapp-card' }),
}));
vi.mock('~/components/attachments/LookEmbedAttachment', () => ({
  LookEmbedAttachment: () =>
    React.createElement('div', { 'data-testid': 'look-card' }),
}));
vi.mock('~/components/attachments/SnapEmbedAttachment', () => ({
  SnapEmbedAttachment: () =>
    React.createElement('div', { 'data-testid': 'snap-card' }),
}));
vi.mock('~/components/attachments/SpaceEmbedAttachment', () => ({
  SpaceEmbedAttachment: () =>
    React.createElement('div', { 'data-testid': 'space-card' }),
  extractSpaceUrl: () => undefined,
  matchSpaceUrl: (url: string) =>
    url.includes('/~/spaces/') ? { roomId: 'room' } : null,
}));
vi.mock('~/components/attachments/QuoteCast', () => ({
  QuoteCast: () => React.createElement('div', { 'data-testid': 'quote-card' }),
}));
vi.mock('~/components/attachments/RichOpenGraphAttachment', () => ({
  RichOpenGraphCastAttachment: () =>
    React.createElement('div', { 'data-testid': 'rich-og-card' }),
}));
vi.mock('~/components/attachments/UnsupportedEmbed', () => ({
  UnsupportedEmbed: () =>
    React.createElement('div', { 'data-testid': 'unsupported-card' }),
}));
vi.mock('~/components/attachments/GroupInviteAttachment', () => ({
  GroupInviteAttachment: () =>
    React.createElement('div', { 'data-testid': 'group-invite-card' }),
}));
vi.mock('~/components/modals/ImageLightboxModal', () => ({
  ImageLightboxModal: ({
    initialIndex,
    imageUrls,
  }: {
    initialIndex: number;
    imageUrls: string[];
  }) =>
    React.createElement('div', {
      'data-image-urls': imageUrls.join(','),
      'data-initial-index': initialIndex,
      'data-testid': 'lightbox',
    }),
}));

const baseCast: ApiCast = {
  author: {
    fid: 3,
    username: 'fiddy',
    displayName: 'Fiddy',
    profile: { bio: { text: '', mentions: [] } },
    followerCount: 0,
    followingCount: 0,
  },
  hash: '0xcast',
  threadHash: '0xcast',
  timestamp: 1,
  text: '',
  replies: { count: 0 },
  reactions: { count: 0 },
  recasts: { count: 0 },
  watches: { count: 0 },
};

const emptyEmbeds = (): ApiCastEmbeds => ({
  images: [],
  urls: [],
  videos: [],
  unknowns: [],
});

const image = (url: string) => ({
  type: 'image' as const,
  url,
  sourceUrl: url,
  alt: '',
  media: {
    version: '2' as const,
    staticRaster: url,
    width: 1200,
    height: 800,
  },
});

const video = (url: string) => ({
  type: 'video' as const,
  url,
  sourceUrl: url,
  width: 1280,
  height: 720,
});

const urlEmbed = (
  url: string,
  extra: Record<string, unknown> = {},
): ApiCastUrlEmbed =>
  ({
    type: 'url',
    openGraph: {
      url,
      sourceUrl: url,
      domain: new URL(url).hostname,
      title: url,
      ...extra,
    },
  }) as ApiCastUrlEmbed;

function Attachments({ embeds }: { embeds: ApiCastEmbeds }) {
  const draggingRef = React.useRef(false);
  const cast = { ...baseCast, embeds };
  const body = useCastAttachmentDebug({
    cast,
    text: '',
    embeds,
    isFocusedCast: false,
    draggingRef,
  });
  return (
    <CastAttachmentsSection
      cast={cast}
      variant="feed"
      castAttachment={body.castAttachment}
      nonCarouselAttachments={body.nonCarouselAttachments}
      hasAttachments={body.hasAttachments}
      hasNonCarouselAttachments={body.hasNonCarouselAttachments}
      needsCarousel={body.needsCarousel}
      carouselMaxHeight={body.carouselMaxHeight}
    />
  );
}

const renderEmbeds = (embeds: ApiCastEmbeds) =>
  render(<Attachments embeds={embeds} />);
const strip = (container: HTMLElement) =>
  container.querySelector('.scrollbar-hide');

afterEach(cleanup);

describe('link cards and media have separate homes', () => {
  it('still renders an OG-only cast, without a media strip', () => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      urls: [urlEmbed('https://example.com/story')],
    });

    expect(container.querySelectorAll('[data-testid="og-card"]')).toHaveLength(
      1,
    );
    expect(strip(container)).toBeNull();
  });

  it('keeps media-only casts in the strip', () => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      images: [image('https://media.test/one')],
    });

    expect(
      strip(container)?.querySelectorAll('[data-testid="image-attachment"]'),
    ).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="og-card"]')).toHaveLength(
      0,
    );
  });

  it('puts an image before a full-width OG card below the strip', () => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      images: [image('https://media.test/one')],
      urls: [urlEmbed('https://example.com/story')],
    });

    const mediaStrip = strip(container);
    const card = container.querySelector('[data-testid="og-card"]')!;
    expect(mediaStrip?.contains(card)).toBe(false);
    expect(card.closest('.flex-col.w-full, .w-full.flex-col')).not.toBeNull();
    expect(card.getAttribute('data-height')).toBeNull();
    expect(card.getAttribute('data-width')).toBeNull();
    expect(
      mediaStrip!.compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('puts a video before an OG card below the strip', () => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      videos: [video('https://media.test/movie')],
      urls: [urlEmbed('https://example.com/story')],
    });

    const mediaStrip = strip(container);
    const card = container.querySelector('[data-testid="og-card"]')!;
    expect(
      mediaStrip?.querySelectorAll('[data-testid="video-attachment"]'),
    ).toHaveLength(1);
    expect(mediaStrip?.contains(card)).toBe(false);
  });

  it('stacks multiple cards in cast order below the media', () => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      images: [image('https://media.test/one')],
      urls: [
        urlEmbed('https://example.com/first'),
        urlEmbed('https://example.com/second'),
      ],
    });

    const cards = [...container.querySelectorAll('[data-testid="og-card"]')];
    expect(cards.map((card) => card.getAttribute('data-url'))).toEqual([
      'https://example.com/first',
      'https://example.com/second',
    ]);
    expect(cards[0].parentElement).toBe(cards[1].parentElement);
    expect(cards[0].parentElement?.className).toContain('flex-col');
    expect(strip(container)?.contains(cards[0])).toBe(false);
  });
});

describe('special renderers stay intact outside the media strip', () => {
  it.each([
    [
      'Snap',
      urlEmbed('https://example.com/snap', {
        snap: { url: 'https://example.com/snap' },
      }),
      'snap-card',
    ],
    ['Look', urlEmbed('https://fiddy.fun/look/abcdef'), 'look-card'],
    ['Space', urlEmbed('https://farcaster.xyz/~/spaces/room'), 'space-card'],
    [
      'mini-app',
      urlEmbed('https://example.com/app', {
        frameEmbedNext: { frameEmbed: {}, frameUrl: 'https://example.com/app' },
      }),
      'miniapp-card',
    ],
  ])('%s keeps its own renderer', (_name, embed, testId) => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      images: [image('https://media.test/one')],
      urls: [embed],
    });

    const special = container.querySelector(`[data-testid="${testId}"]`)!;
    expect(special).not.toBeNull();
    expect(strip(container)?.contains(special)).toBe(false);
  });

  it('keeps quotes out of the media strip', () => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      images: [image('https://media.test/one')],
      casts: [{ ...baseCast, hash: '0xquote', threadHash: '0xquote' }],
    });

    const quote = container.querySelector('[data-testid="quote-card"]')!;
    expect(strip(container)?.contains(quote)).toBe(false);
  });
});

describe('media measurements and lightbox indexes are preserved', () => {
  it('keeps image indexes contiguous and shares the media tile height', () => {
    const { container } = renderEmbeds({
      ...emptyEmbeds(),
      images: [
        image('https://media.test/one'),
        image('https://media.test/two'),
      ],
      urls: [urlEmbed('https://example.com/story')],
    });

    const images = [
      ...container.querySelectorAll('[data-testid="image-attachment"]'),
    ];
    expect(
      images.map((item) => item.getAttribute('data-carousel-index')),
    ).toEqual(['0', '1']);
    const heights = images.map((item) => item.getAttribute('data-height'));
    expect(heights[0]).not.toBeNull();
    expect(heights[1]).toBe(heights[0]);
    expect(
      strip(container)?.querySelectorAll('[data-testid="og-card"]'),
    ).toHaveLength(0);
  });
});
