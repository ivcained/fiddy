import type { NodeMessage } from 'farcaster-node-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { CastCard } from '~/components/CastCard';
import { FidSheet } from '~/components/FidSheet';
import { GlassCard } from '~/components/GlassCard';
import { NewPostsPill } from '~/components/NewPostsPill';
import { entryKey, mergeNew } from '~/feed/newPosts';
import { useAppActive, useNewPosts } from '~/feed/useNewPosts';
import { useHomeFeed, useNodeSession } from '~/node/nodeSession';
import { useProfiles } from '~/node/profiles';
import { colors, fonts, spacing } from '~/theme';
import { useReduceMotion } from '~/utils/useReduceMotion';

const AUTHORS_CAP = 24;

/** Distance from the top that still counts as "at the top of the feed". */
const TOP_SLOP = 4;

/** The Feed tab: your follow graph, their casts, read through your own node. */
export const FeedScreen = () => {
  const session = useNodeSession();
  const feed = useHomeFeed(session);
  const [fidSheetOpen, setFidSheetOpen] = useState(false);

  // The list on screen is what the poll diffs against, plus whatever a tap on
  // the pill put on top of it.
  const listRef = useRef<FlatList<NodeMessage>>(null);
  const [inserted, setInserted] = useState<NodeMessage[]>([]);
  const [atTop, setAtTop] = useState(true);
  const atTopRef = useRef(true);
  const reduceMotion = useReduceMotion();

  const casts = useMemo(
    () => mergeNew(inserted, feed.casts),
    [inserted, feed.casts],
  );
  const haveRef = useRef<NodeMessage[]>(casts);
  haveRef.current = casts;

  // A re-read of the feed replaces the list, so anything a tap put on top of
  // the old one goes with it.
  useEffect(() => {
    if (feed.status === 'loading') {
      setInserted([]);
    }
  }, [feed.status]);

  const appActive = useAppActive();
  const { found, clear: clearFound } = useNewPosts({
    session,
    following: feed.following,
    have: haveRef,
    // Nothing is polled while the node is known to be down: the health pill is
    // already saying so, and a poll would only add failed requests.
    enabled: appActive && session.status !== 'down' && feed.status === 'ready',
  });

  const reload = useRef(feed.reload);
  reload.current = feed.reload;

  const show = useCallback(() => {
    if (!found) {
      return;
    }
    clearFound();
    if (found.replace) {
      // The page could not be anchored to the list (more is new than one page
      // holds), so merging would leave a hole: re-read the feed instead.
      reload.current();
      return;
    }
    setInserted((previous) => mergeNew(previous, found.items));
    if (!atTopRef.current) {
      listRef.current?.scrollToOffset({
        offset: 0,
        animated: !reduceMotion,
      });
    }
  }, [clearFound, found, reduceMotion]);

  // Already at the top: new casts go straight on, no pill. (Upstream #640 does
  // the same; the pill is only for a reader who is scrolled away.)
  useEffect(() => {
    if (found && atTopRef.current) {
      show();
    }
  }, [found, show]);

  const onScroll = useCallback((offsetY: number) => {
    const top = offsetY <= TOP_SLOP;
    atTopRef.current = top;
    setAtTop((current) => (current === top ? current : top));
  }, []);

  const authorFids = useMemo(() => {
    const unique = new Set<number>();
    for (const cast of casts) {
      unique.add(cast.fid);
      if (unique.size >= AUTHORS_CAP) {
        break;
      }
    }
    // The pill's faces may not be in the list yet: they are the whole point.
    for (const fid of found?.authors ?? []) {
      unique.add(fid);
    }
    return [...unique];
  }, [casts, found]);

  const profiles = useProfiles(session.client, authorFids);
  const pill = found && found.news.length > 0 && !atTop ? found : null;

  return (
    <View style={styles.screen}>
      <FlatList
        ref={listRef}
        data={casts}
        keyExtractor={(item) => entryKey(item)}
        onScroll={(event) => onScroll(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        renderItem={({ item }) => (
          <CastCard cast={item} profile={profiles.get(item.fid)} />
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={feed.status === 'loading'}
            onRefresh={() => {
              clearFound();
              feed.reload();
              void session.refreshHealth();
            }}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <GlassCard accent>
              <View style={styles.headerRow}>
                <Text style={styles.headerLabel}>
                  {feed.status === 'loading' && feed.following.length > 0
                    ? 'reading your follow graph'
                    : feed.status === 'loading'
                      ? 'reading your node'
                      : feed.status === 'error'
                        ? 'read failed'
                        : 'your feed'}
                </Text>
                <Pressable
                  onPress={() => setFidSheetOpen(true)}
                  accessibilityRole="button"
                  style={styles.fidButton}
                >
                  <Text style={styles.fidButtonText}>
                    {session.fid ? `fid ${session.fid}` : 'choose FID'}
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.headerMeta}>
                {session.status === 'down'
                  ? `${session.host} is not answering — nothing below is cached`
                  : feed.status === 'loading' && feed.following.length > 0
                    ? `${feed.following.length} follows read from ${session.host}`
                    : `${feed.casts.length} casts from ${session.host}`}
              </Text>
            </GlassCard>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {feed.status === 'loading' ? (
              <>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.emptyTitle}>Asking your node…</Text>
                <Text style={styles.emptyBody}>
                  No indexer is involved: the app reads your follow graph and
                  merges each account’s casts on the Farcaster timestamp. On a
                  cold start that is a few hundred reads.
                </Text>
              </>
            ) : feed.status === 'error' ? (
              <>
                <Text style={styles.emptyTitle}>Your node did not answer</Text>
                <Text style={styles.emptyBody}>{feed.error}</Text>
                <Text style={styles.emptyBody}>
                  Tap the pill at the top for the node the app is pointed at, or
                  pull down to retry.
                </Text>
              </>
            ) : !session.fid ? (
              <>
                <Text style={styles.emptyTitle}>No FID chosen</Text>
                <Text style={styles.emptyBody}>
                  A read node has no home feed — it has your follow graph. Pick
                  the FID whose network you want to read.
                </Text>
                <Pressable
                  style={styles.cta}
                  onPress={() => setFidSheetOpen(true)}
                  accessibilityRole="button"
                >
                  <Text style={styles.ctaText}>Choose a FID</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.emptyTitle}>Nothing to show</Text>
                <Text style={styles.emptyBody}>
                  This FID follows nobody this node can see, or its follows have
                  not cast recently.
                </Text>
              </>
            )}
          </View>
        }
        ListFooterComponent={
          casts.length > 0 ? (
            <Text style={styles.footer}>
              read-only in v1 · posting with a gasless app key is v2 · no key of
              any kind is in this build
            </Text>
          ) : null
        }
      />
      {pill ? (
        <View style={styles.pillDock} pointerEvents="box-none">
          <NewPostsPill
            count={pill.count}
            authors={pill.authors}
            profiles={profiles}
            replace={pill.replace}
            onPress={show}
          />
        </View>
      ) : null}
      <FidSheet
        open={fidSheetOpen}
        fid={session.fid}
        onClose={() => setFidSheetOpen(false)}
        onSubmit={(fid) => {
          session.setFid(fid);
          setFidSheetOpen(false);
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  header: {
    paddingTop: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  headerLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  fidButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairlineAccent,
    backgroundColor: colors.accentSoft,
  },
  fidButtonText: {
    color: colors.accent,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  headerMeta: {
    color: colors.inkDim,
    fontSize: 12,
    marginTop: spacing.sm,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  empty: {
    paddingTop: spacing.xl,
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  emptyBody: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
  },
  cta: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderRadius: 999,
  },
  ctaText: {
    color: colors.onAccent,
    fontWeight: '700',
    fontSize: 14,
  },
  footer: {
    color: colors.inkFaint,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: spacing.lg,
  },
  /**
   * The pill floats at the bottom of the Feed tab: inside this screen it is
   * already clear of the tab bar above it, out of the header card's way, and
   * under a thumb. `box-none` so the list still scrolls around it.
   */
  pillDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.md,
    alignItems: 'center',
  },
});
