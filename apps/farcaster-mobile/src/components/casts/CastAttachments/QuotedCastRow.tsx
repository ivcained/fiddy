import { Ionicons } from '@expo/vector-icons';
import { ApiQuotedCastEmbed } from 'farcaster-client-data';
import { CastClickType, useTrackCastClick } from 'farcaster-client-hooks';
import React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '~/components/Text';
import { useTheme } from '~/contexts/ThemeProvider';
import { usePush } from '~/hooks/navigation/usePush';

/**
 * The copy for a quoted cast that has no words and no media of its own — a quote
 * of a quote, which the card used to answer with "Show more..." and nothing
 * behind it.
 *
 * The words are ours (ELI5, not a translation of upstream's locale file). "Quoted
 * a cast" is what the card says; the second line is only used when the card
 * cannot name the inner cast and has to fall back to "this one taps through".
 */
export const QUOTED_CAST_COPY = {
  headline: 'Quoted a cast',
  detail: 'This cast quotes another one, tap to read it',
} as const;

/** "Quoted a cast by @x" — the inner cast named by whoever wrote it. */
export const quotedCastByline = (username: string | undefined): string =>
  username ? `Quoted a cast by @${username}` : QUOTED_CAST_COPY.headline;

interface QuotedCastRowProps {
  /** The cast the quoted cast quotes. */
  cast: ApiQuotedCastEmbed;
  inversedTextColors?: boolean;
}

/**
 * A small row for the cast inside a quote of a quote, so the card can be opened
 * one level deeper instead of only showing the outer cast.
 *
 * Rendered as a sibling of the card's own Pressable (never inside it), for the
 * same reason the snap card is: two overlapping tap targets make one gesture
 * ambiguous, and the inner one has to be the one that wins.
 */
const QuotedCastRow: React.FC<QuotedCastRowProps> = ({
  cast,
  inversedTextColors = false,
}) => {
  const t = useTheme();
  const push = usePush();
  const trackCastClick = useTrackCastClick();

  const byline = React.useMemo(
    () => quotedCastByline(cast.author?.username),
    [cast.author?.username],
  );

  const preview = React.useMemo(() => {
    const text = (cast.text ?? '').replace(/\s+/g, ' ').trim();
    return text === '' ? undefined : text;
  }, [cast.text]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={byline}
      accessibilityHint="Opens the cast this one quotes"
      onPress={() => {
        trackCastClick({ type: CastClickType.QuotedCast });
        push('Cast', { castHash: cast.hash });
      }}
      style={[
        t.flex,
        t.flexRow,
        t.itemsCenter,
        t.mT2,
        t.p2,
        t.roundedSm,
        t.borderDefault,
        t.borderHairline,
      ]}
    >
      <Ionicons
        name="chatbubble-outline"
        size={14}
        style={[inversedTextColors ? t.texts.light : t.texts.tertiary]}
      />
      <View style={[t.flex1, t.mL2]}>
        <Text
          numberOfLines={1}
          style={[
            t.textSm,
            t.fontNormal,
            inversedTextColors ? t.texts.light : t.texts.primary,
          ]}
        >
          {byline}
        </Text>
        {preview && (
          <Text
            numberOfLines={1}
            style={[
              t.textSm,
              t.mT1,
              inversedTextColors ? t.texts.light : t.texts.tertiary,
            ]}
          >
            {preview}
          </Text>
        )}
      </View>
      <Ionicons
        name="chevron-forward"
        size={14}
        style={[inversedTextColors ? t.texts.light : t.texts.tertiary]}
      />
    </Pressable>
  );
};

export { QuotedCastRow };
