/**
 * "↑ 3 new posts" over a scrolled feed, with the faces of up to three of who
 * posted them. A tap puts them on top and goes up.
 *
 * Adapted from quilcast's `NewPosts` (backmeupplz/quilcast, MIT, commit
 * `2e3437966c00`, PR #640 / mirror #270): the accent pill, the overlapping
 * faces, the arrow and the copy are theirs. Two changes for a phone: it sits at
 * the bottom of the Feed tab rather than under the header, so it is reachable
 * with a thumb and never covers the header card; and the count can be absent.
 *
 * The count is absent on purpose when it cannot be stood behind — the page
 * could not be anchored to the list, or some authors could not be read. Then the
 * pill says "New posts" and no number, instead of a wrong one.
 */

import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Avatar } from '~/components/Avatar';
import {
  allHandlesKnown,
  knownHandles,
  newPostsAccessibilityLabel,
  newPostsLabel,
} from '~/feed/pillLabel';
import type { Profile } from '~/node/profiles';
import { colors, fonts, radii, spacing } from '~/theme';

/**
 * How long the announcement waits for the new authors' handles to land.
 *
 * The authors of a new post are almost never in the profile cache yet:
 * `useProfiles` fills it after the pill mounts. Announcing on the first render
 * would speak FIDs (or nothing); waiting forever would mean no announcement at
 * all when a profile read fails. So: speak as soon as everyone can be named,
 * and anyway after this long, naming whoever has landed.
 */
const ANNOUNCE_WAIT_MS = 1_200;

export const NewPostsPill = ({
  count,
  authors,
  profiles,
  replace = false,
  onPress,
}: {
  count: number | null;
  authors: number[];
  profiles: Map<number, Profile>;
  /** The gap case: a tap re-reads the list rather than merging into it. */
  replace?: boolean;
  onPress: () => void;
}) => {
  const handles = knownHandles(authors, profiles);
  const label = newPostsAccessibilityLabel({
    count,
    handles,
    replace,
  });

  // One announcement when the pill appears, not one per poll: the ref survives
  // the re-renders that a later poll causes, and the pill unmounts when it is
  // dismissed, so the next appearance announces again. The sentence is read from
  // a ref so the deferred announcement speaks the *latest* label (handles that
  // landed while we waited), never the one captured on the first render.
  const announced = useRef(false);
  const labelRef = useRef(label);
  labelRef.current = label;
  const complete = allHandlesKnown(authors, profiles);

  useEffect(() => {
    const speak = () => {
      if (announced.current) {
        return;
      }
      announced.current = true;
      AccessibilityInfo.announceForAccessibility(labelRef.current);
    };
    if (complete) {
      speak();
      return undefined;
    }
    const timer = setTimeout(speak, ANNOUNCE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [complete]);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={
        replace
          ? 'Reloads the feed'
          : 'Puts the new posts on top and scrolls up'
      }
      style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
    >
      <Text style={styles.arrow}>↑</Text>
      {authors.length > 0 ? (
        <View
          style={styles.faces}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {authors.map((fid, index) => (
            <View key={fid} style={index === 0 ? undefined : styles.overlap}>
              <Avatar profile={profiles.get(fid)} ring />
            </View>
          ))}
        </View>
      ) : null}
      <Text style={styles.text} numberOfLines={1}>
        {newPostsLabel(count)}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // A 44 pt target even though the contents are 22 pt tall.
    minHeight: 44,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  pressed: {
    opacity: 0.85,
  },
  arrow: {
    color: colors.onAccent,
    fontSize: 16,
    fontWeight: '700',
  },
  faces: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  overlap: {
    marginLeft: -7,
  },
  text: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.2,
    fontFamily: fonts.mono,
  },
});
