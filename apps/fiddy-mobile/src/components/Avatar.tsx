/**
 * A 22 pt face for the "N new posts" pill.
 *
 * The pill's own portrait stack, not a feed avatar: the app still has no image
 * cache and no profile page, so this is the smallest thing that reads as a face
 * — the author's picture when their node profile has one, and their initial on a
 * dark disc when it does not (or when the picture fails to load).
 */

import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import type { Profile } from '~/node/profiles';
import { colors, fonts } from '~/theme';

export const Avatar = ({
  profile,
  size = 22,
  ring = false,
}: {
  profile?: Profile;
  size?: number;
  ring?: boolean;
}) => {
  const [failed, setFailed] = useState(false);
  const name = profile?.display ?? profile?.username ?? '';
  const initial = name.trim().slice(0, 1).toUpperCase();
  const picture = profile?.pfp ?? null;
  const disc = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  return (
    <View style={[styles.disc, disc, ring && styles.ring]}>
      {picture && !failed ? (
        <Image
          key={picture}
          source={{ uri: picture }}
          style={disc}
          onError={() => setFailed(true)}
          accessible={false}
        />
      ) : (
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.46) }]}>
          {initial || '·'}
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(22, 23, 21, 0.32)',
    overflow: 'hidden',
  },
  // The ring is the pill's own background, so overlapping faces stay separate.
  ring: {
    borderWidth: 2,
    borderColor: colors.accent,
  },
  initial: {
    color: colors.onAccent,
    fontFamily: fonts.mono,
    fontWeight: '700',
  },
});
