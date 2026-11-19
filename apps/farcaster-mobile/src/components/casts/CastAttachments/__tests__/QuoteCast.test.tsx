/**
 * The quote card itself: what a quote of a quote says.
 *
 * MEASURED before this (the hosted API, 2026-11-14): a cast handed back inside
 * another cast's quote embed carries `embeds: {}`. The card treated "no text, no
 * images, no videos, no space, no snap" as "there is more to show" and printed
 * "Show more...", so a quote of a quote promised content that did not exist and
 * had nothing to open.
 *
 * These tests render the real component with the card's providers stubbed: the
 * card must say "Quoted a cast", must offer the inner cast as a row when it can
 * name it, and must still open the quoted cast when it cannot.
 */

import { fireEvent, render } from '@testing-library/react-native';
import { ApiQuoteCastEmbed } from 'farcaster-client-data';
import React from 'react';

import { QuoteCast } from '../QuoteCast';

const INNER_HASH = '0xd59f6618f8af7f77242fe48b1f9b87401c23054f';

const QUOTED_HASH = '0x7fdee7f9dc6b9d6d709ca5fa1602c9899b4102c0';

const asCast = (cast: Record<string, unknown>) =>
  cast as unknown as ApiQuoteCastEmbed;

/** The wordless quote — a cast that quotes another cast and says nothing. */
const wordlessQuote = asCast({
  hash: QUOTED_HASH,
  threadHash: QUOTED_HASH,
  author: { fid: 1, username: 'pk' },
  text: '',
  embeds: {},
  timestamp: 1_700_000_000_000,
});

/** The same quote, hydrated: now it says which cast it quotes. */
const hydratedQuote = asCast({
  ...wordlessQuote,
  embeds: {
    images: [],
    urls: [],
    unknowns: [],
    casts: [
      {
        hash: INNER_HASH,
        threadHash: INNER_HASH,
        author: { fid: 602, username: 'farcaster' },
        text: 'Introducing Farcaster Articles!',
        timestamp: 1_700_000_000_000,
      },
    ],
  },
});

const mockPush = jest.fn();
const mockHydrated: { cast: ApiQuoteCastEmbed } = { cast: wordlessQuote };

jest.mock('@datadog/mobile-react-native', () => ({
  DdRum: {
    addAction: jest.fn(),
    startAction: jest.fn(),
    stopAction: jest.fn(),
  },
  RumActionType: { CUSTOM: 'custom' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('expo-image', () => {
  const { View } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  return { Image: View };
});

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  return {
    __esModule: true,
    default: { View },
    measure: () => null,
    runOnJS: (fn: () => void) => fn,
    runOnUI: (fn: () => void) => fn,
    useAnimatedRef: () => null,
    useAnimatedStyle: () => ({}),
    withTiming: (value: unknown) => value,
  };
});

jest.mock('farcaster-expo', () => {
  const { View } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  return { RemoteImage: View };
});

jest.mock('~/components/Text', () => {
  const { Text } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  return { Text };
});

jest.mock('~/components/casts/CastAvatar', () => ({
  CastAvatar: () => null,
}));

jest.mock('~/components/casts/CastUsernameAndTimestamp', () => ({
  CastUsernameAndTimestamp: () => null,
}));

jest.mock('~/components/ScrollViewWithBackGesture', () => {
  const { View } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  return { ScrollViewWithBackGesture: View };
});

jest.mock('~/components/Snap/SnapEmbedAttachment', () => ({
  SnapEmbedAttachment: () => null,
}));

jest.mock('~/components/Snap/snapLiftState', () => ({
  consumeRecentSnapLiftDismissal: () => false,
}));

jest.mock('~/components/spaces/SpaceEmbedAttachment', () => ({
  SpaceEmbedAttachment: () => null,
  matchSpaceUrl: () => undefined,
}));

jest.mock('~/constants/Cast', () => ({
  useCastBodyTextStyle: () => [],
}));

jest.mock('~/constants/Images', () => ({
  imageRequestHeaders: {},
}));

jest.mock('~/contexts/DataSaverProvider', () => ({
  useDataSaver: () => ({ shouldLoadLowerQualityImages: false }),
}));

jest.mock('~/contexts/LightboxProvider', () => ({
  useLightbox: () => ({
    openLightbox: jest.fn(),
    activeLightboxRef: { value: '' },
  }),
}));

jest.mock('~/contexts/ThemeProvider', () => {
  const baseStyle = {};
  const theme = new Proxy(baseStyle, {
    get: (_target, prop: string) =>
      prop === 'colors'
        ? { feed: { threadLine: '#eee' } }
        : prop === 'directCasts'
          ? { bgImagePreview: 'rgba(0,0,0,0.6)' }
          : baseStyle,
  });

  return { useTheme: () => theme };
});

jest.mock('~/contexts/UserAppContextProvider', () => ({
  useUserAppContext: () => ({ regularCastByteLimit: 320 }),
}));

jest.mock('~/contexts/VideoFeedViewablilityProvider', () => ({
  useAnimatedImageFeedViewability: () => false,
}));

jest.mock('~/hooks/data/useUserLevel', () => ({
  useUserLevel: () => 'free',
}));

jest.mock('~/hooks/navigation/usePush', () => ({
  usePush: () => mockPush,
}));

// The hooks package's barrel pulls in the wallet/crypto stack (ESM packages this
// jest config does not transform), so the four things this card uses are stood in
// for. `peekOf`/`quotedOf` have their own suite where they really live
// (`packages/farcaster-client-hooks/src/utils/__tests__/quotedCastPeek.test.ts`);
// these stubs answer the one question the card asks them.
jest.mock('farcaster-client-hooks', () => {
  const firstInner = (cast: ApiQuoteCastEmbed) => cast.embeds?.casts?.[0];

  return {
    CastClickType: { QuotedCast: 'QuotedCast' },
    useTrackCastClick: () => jest.fn(),
    getCastSnap: () => undefined,
    processMediasForRendering: ({ medias }: { medias: unknown[] }) =>
      medias.map((media) => ({ original: media, thumbnail: media })),
    useHydratedQuoteCast: ({ cast }: { cast: ApiQuoteCastEmbed }) => ({
      ...cast,
      ...mockHydrated.cast,
    }),
    peekOf: (cast: ApiQuoteCastEmbed) =>
      firstInner(cast)
        ? { kind: 'quote', quote: firstInner(cast) }
        : { kind: 'none' },
    quotedOf: (cast: ApiQuoteCastEmbed) => {
      const inner = firstInner(cast);
      return inner
        ? {
            hash: inner.hash,
            ...(inner.author?.fid ? { fid: inner.author.fid } : {}),
            ...(inner.author?.username
              ? { username: inner.author.username }
              : {}),
          }
        : undefined;
    },
  };
});

describe('a quote of a quote, as a card', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('says "Quoted a cast" instead of promising "Show more..."', () => {
    mockHydrated.cast = wordlessQuote;

    const { getByText, queryByText } = render(
      <QuoteCast cast={wordlessQuote} />,
    );

    expect(getByText('Quoted a cast')).toBeTruthy();
    expect(queryByText('Show more...')).toBeNull();
    // Nothing to name, so the card says how to get through instead of leaving a
    // headline with nothing under it.
    expect(
      getByText('This cast quotes another one, tap to read it'),
    ).toBeTruthy();
  });

  it('offers the inner cast as a row, and opens the quoted cast from the card', () => {
    mockHydrated.cast = hydratedQuote;

    const { getByLabelText, getByText, queryByText } = render(
      <QuoteCast cast={hydratedQuote} />,
    );

    expect(getByText('Quoted a cast')).toBeTruthy();
    expect(queryByText('Show more...')).toBeNull();
    // Named, because the hydrated payload says which cast it is.
    expect(getByText('Quoted a cast by @farcaster')).toBeTruthy();
    // …and the "tap to read it" line is not needed when the row can be named.
    expect(
      queryByText('This cast quotes another one, tap to read it'),
    ).toBeNull();

    fireEvent.press(getByLabelText('Quoted a cast by @farcaster'));

    expect(mockPush).toHaveBeenCalledWith('Cast', { castHash: INNER_HASH });
  });

  it('keeps the words when the quoted cast has words of its own', () => {
    mockHydrated.cast = asCast({
      ...wordlessQuote,
      hash: QUOTED_HASH,
      text: 'Articles shipped this morning and I have not stopped reading.',
    });

    const { getByText, queryByText } = render(
      <QuoteCast cast={mockHydrated.cast} />,
    );

    expect(
      getByText(
        'Articles shipped this morning and I have not stopped reading.',
      ),
    ).toBeTruthy();
    expect(queryByText('Quoted a cast')).toBeNull();
    expect(queryByText('Show more...')).toBeNull();
  });
});
