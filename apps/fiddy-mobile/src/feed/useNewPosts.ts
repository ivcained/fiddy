/**
 * "N new posts" above the feed, wired to a poll.
 *
 * The rules live in `newPosts.ts` (what counts as new, what the pill may say) and
 * `headPoller.ts` (when to read); this hook only supplies the two things that
 * need React and the platform: the list on screen, and whether anyone is looking.
 *
 * Cost is the design constraint. `fetchFollowingFeed` re-reads the follow graph
 * and then `castsPerAccount` casts per follow — right once, wrong every minute.
 * So the poll reuses the graph the feed already read and takes the head only
 * (`fetchFeedHead`: one small page per author). It does not run while the app is
 * backgrounded, while another tab is showing, or while the node is known to be
 * down; it never runs two reads at once; and it backs off when a read fails.
 *
 * The app has one reader, `SnapchainNodeClient`, and the poll goes through it —
 * the same reader the feed uses. A failed author makes the number unverified
 * rather than short: the pill then says "New posts" with no count, which is the
 * only honest thing to say when part of the graph could not be read.
 */

import { fetchFeedHead, type NodeMessage } from 'farcaster-node-client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { AppState } from 'react-native';

import { createHeadPoller, type HeadPoller } from './headPoller';
import { newPostsFor, type NewPostsFound } from './newPosts';
import type { NodeSession } from '~/node/nodeSession';

/**
 * How often a feed that is on screen looks for new posts.
 *
 * Not upstream's 60 s, and that is a measurement, not a preference. One head
 * poll is `follows + 1` requests — 80 for the starter FID 3, whose graph this
 * machine measured at 79 follows. Against a live read node
 * (`scripts/measure-feed-head.mjs https://crackle.farcaster.xyz:3381 3`):
 * 79 requests, 3.4-3.7 s wall clock at concurrency 6, and ~131 KB (30 sampled
 * `castsByFid?pageSize=2&reverse=true` bodies at ~1.6 KB each). Every 60 s that
 * is ~7.9 MB and ~5,000 requests per hour of screen time on the reader's own
 * node — the same order as re-running the whole feed read every minute, which
 * is the thing the card says not to do.
 *
 * So this is the card's cheaper release, plus a safety net: the poller keeps
 * running (paused in the background) and `resume()` reads at once when an
 * interval went by, so coming back to the app is immediate; and while a reader
 * stays on the feed it still refreshes every five minutes, which is ~1.6 MB and
 * ~1,000 requests per hour.
 */
export const POLL_INTERVAL_MS = (() => {
  // Verification (and a demo build) can shorten the cadence without editing
  // code: `EXPO_PUBLIC_FIDDY_POLL_MS=20000`. Anything under five seconds is
  // ignored, so a typo cannot turn the app into a node hammer.
  const override = Number.parseInt(
    String(process.env.EXPO_PUBLIC_FIDDY_POLL_MS ?? ''),
    10,
  );
  return Number.isFinite(override) && override >= 5_000 ? override : 5 * 60_000;
})();

/** Newest casts kept per author: enough that a remove or a gap does not hide the news. */
const PER_AUTHOR = 2;

export interface NewPostsOptions {
  session: NodeSession;
  /** The follow graph the feed already read; the poll never re-reads it. */
  following: number[];
  /** The list on screen right now, by ref so the poller is built once. */
  have: RefObject<NodeMessage[]>;
  /** Whether to poll right now: the output of `shouldPoll` in `pollGate.ts`. */
  enabled: boolean;
  /** Casts the feed would not show (silenced, hidden, a skipped pinned cast). */
  keep?: (cast: NodeMessage) => boolean;
}

export interface NewPostsState {
  /** What the pill may offer, or null when there is nothing above the list. */
  found: NewPostsFound<NodeMessage> | null;
  /** Drop the held news (it was shown, or the list was re-read). */
  clear: () => void;
}

/**
 * The live `AppState.currentState`, defaulting to `'unknown'` for the moment
 * before the first change notification arrives.
 *
 * The gate in `pollGate.ts` wants the raw state, not a boolean: `'inactive'`
 * (a notification shade, a system sheet) and `'background'` are different
 * reasons to stop reading.
 */
export const useAppStateName = (): string => {
  const [state, setState] = useState<string>(
    () => AppState.currentState ?? 'unknown',
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setState(next);
    });
    return () => subscription.remove();
  }, []);

  return state;
};

/** True while the app is in the foreground. */
export const useAppActive = (): boolean => useAppStateName() === 'active';

export const useNewPosts = ({
  session,
  following,
  have,
  enabled,
  keep,
}: NewPostsOptions): NewPostsState => {
  const [found, setFound] = useState<NewPostsFound<NodeMessage> | null>(null);
  const keepRef = useRef(keep);
  keepRef.current = keep;

  const viewerFid = session.fid;
  const graph = following.join(',');
  // The poller exists whenever there is a graph to read; whether it is *running*
  // is the gate's business (see below). Keeping the instance alive across a
  // background/foreground round trip is what makes `resume` a catch-up: if more
  // than one interval went by, the next read is immediate.
  const canPoll = viewerFid > 0 && graph !== '';

  const pollerRef = useRef<HeadPoller | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!canPoll) {
      setFound(null);
      return undefined;
    }

    // The viewer is read too: the home feed shows their own casts, and an entry
    // the list already has is what the diff anchors on.
    const fids = [viewerFid, ...following];

    const poller = createHeadPoller({
      intervalMs: POLL_INTERVAL_MS,
      poll: async (token) => {
        const shown = have.current ?? [];
        if (shown.length === 0) {
          // The first page is not in yet: there is nothing to anchor to, and the
          // full read that is already running will fill the list.
          return;
        }
        const started = Date.now();
        const head = await fetchFeedHead({
          node: session.client,
          fids,
          perAuthor: PER_AUTHOR,
          // Six at a time: the same fan-out the feed read uses, so a poll is a
          // short burst rather than a hundred open sockets.
          concurrency: 6,
          isCancelled: () => token.cancelled,
        });
        if (token.cancelled) {
          return;
        }
        if (head.casts.length === 0 && head.unread.length > 0) {
          // Nothing at all came back: treat it as the node being unwell, not as
          // "no new posts", so the poller backs off.
          throw new Error(
            `the feed head could not be read (${head.unread.length} of ${fids.length} authors)`,
          );
        }
        const next = newPostsFor({
          have: shown,
          page: head.casts,
          viewerFid,
          ...(keepRef.current ? { keep: keepRef.current } : {}),
          unread: head.unread.length,
        });
        if (__DEV__) {
          // The measured cost of one poll, in the Metro log, as a number rather
          // than a claim: requests == authors read, one page each.
          // eslint-disable-next-line no-console
          console.log(
            `[fiddy new-posts] poll: ${head.requests} requests for ${head.casts.length} casts in ${Date.now() - started}ms`,
          );
        }
        setFound(next);
      },
      onError: (error) => {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log(
            `[fiddy new-posts] poll failed, backing off: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });

    pollerRef.current = poller;
    poller.start();
    if (!enabledRef.current) {
      poller.pause();
    }
    return () => {
      poller.stop();
      pollerRef.current = null;
    };
    // `graph` stands in for `following`: the array identity changes every read
    // of the feed, the FIDs it holds do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPoll, session.client, viewerFid, graph]);

  // The gate decides when the existing poller runs: paused in the background,
  // resumed (with an immediate read if an interval has gone by) on return.
  useEffect(() => {
    const poller = pollerRef.current;
    if (!poller) {
      return;
    }
    if (enabled) {
      poller.resume();
    } else {
      poller.pause();
    }
  }, [enabled]);

  const clear = useCallback(() => setFound(null), []);

  return { found, clear };
};
