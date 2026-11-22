/**
 * The inner-cast row of a quote of a quote.
 *
 * The bug this covers: a quoted cast with no words and no media answered "Show
 * more..." and had nothing behind it, because a quote of a quote is one
 * `cast_id` embed this renderer had no card for. The card now names the inner
 * cast and lets the reader open it one level deeper.
 */

import { fireEvent, render } from '@testing-library/react-native';
import { ApiQuotedCastEmbed } from 'farcaster-client-data';
import React from 'react';

import {
  QUOTED_CAST_COPY,
  quotedCastByline,
  QuotedCastRow,
} from '../QuotedCastRow';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

// `~/components/Text` re-exports `farcaster-expo`, whose barrel pulls in the Solana
// wallet (an ESM package this jest config does not transform). The row only needs
// a text element, so the test renders RN's own.
jest.mock('~/components/Text', () => {
  const { Text } = jest.requireActual(
    'react-native',
  ) as typeof import('react-native');
  return { Text };
});

jest.mock('farcaster-client-hooks', () => ({
  CastClickType: { QuotedCast: 'QuotedCast' },
  useTrackCastClick: () => mockTrackCastClick,
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

const mockTrackCastClick = jest.fn();
const mockPush = jest.fn();

jest.mock('~/hooks/navigation/usePush', () => ({
  usePush: () => mockPush,
}));

const INNER_HASH = '0xd59f6618f8af7f77242fe48b1f9b87401c23054f';

// The cast shapes here are the fields the row reads; the rest of `ApiUser` is not
// part of what this component renders, so the fixture states only what it uses.
const innerCast = {
  hash: INNER_HASH,
  threadHash: INNER_HASH,
  author: { fid: 602, username: 'farcaster' },
  text: 'Introducing Farcaster Articles!',
  timestamp: 1_700_000_000_000,
} as unknown as ApiQuotedCastEmbed;

describe('QuotedCastRow', () => {
  beforeEach(() => {
    mockTrackCastClick.mockClear();
    mockPush.mockClear();
  });

  it('names the cast it quotes and opens it', () => {
    const { getByText, getByLabelText } = render(
      <QuotedCastRow cast={innerCast} />,
    );

    expect(getByText('Quoted a cast by @farcaster')).toBeTruthy();
    expect(getByText('Introducing Farcaster Articles!')).toBeTruthy();

    fireEvent.press(getByLabelText('Quoted a cast by @farcaster'));

    expect(mockTrackCastClick).toHaveBeenCalledWith({ type: 'QuotedCast' });
    expect(mockPush).toHaveBeenCalledWith('Cast', { castHash: INNER_HASH });
  });

  it('falls back to "Quoted a cast" when the handle is not in the payload', () => {
    const { getByText, queryByText } = render(
      <QuotedCastRow
        cast={{ ...innerCast, author: { fid: 602 } } as ApiQuotedCastEmbed}
      />,
    );

    expect(getByText(QUOTED_CAST_COPY.headline)).toBeTruthy();
    expect(queryByText(/Quoted a cast by/)).toBeNull();
  });

  it('draws no preview line for an inner cast with no words of its own', () => {
    const { queryByText } = render(
      <QuotedCastRow
        cast={{ ...innerCast, text: '   ' } as ApiQuotedCastEmbed}
      />,
    );

    expect(queryByText('Introducing Farcaster Articles!')).toBeNull();
  });

  it('says the same thing in the copy a card shows when it cannot name the cast', () => {
    expect(quotedCastByline(undefined)).toBe(QUOTED_CAST_COPY.headline);
    expect(QUOTED_CAST_COPY.detail).toBe(
      'This cast quotes another one, tap to read it',
    );
  });
});
