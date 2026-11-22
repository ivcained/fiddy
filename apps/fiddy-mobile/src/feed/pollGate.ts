/**
 * Whether the Feed tab should be polling for new posts at all.
 *
 * This is a separate decision from *how* to poll (`headPoller.ts`, which
 * schedules and backs off) and from *what counts as new* (`newPosts.ts`). It is
 * the cheap one and the easiest to get wrong: a poller that exists while the app
 * is in the background, while another tab is showing, while the node is known to
 * be down, or before the first page has landed spends a reader's node on
 * nothing.
 *
 * Pure on purpose: the card asks for this matrix to be tested, and it is the one
 * piece of the feature that a fake clock and a fake AppState cannot cover.
 */

/** The subset of `AppState.currentState` this gate cares about. */
export type AppStateName = 'active' | 'background' | 'inactive' | 'unknown';

/** The node health the session reports (`NodeHealthStatus`). */
export type SessionStatus = 'checking' | 'ok' | 'down';

/** The home feed's own status (`HomeFeedState['status']`). */
export type FeedStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PollGateInput {
  /** `AppState.currentState`. */
  appState: string;
  /** `session.status`: 'down' means the health probe already failed. */
  sessionStatus: SessionStatus;
  /** `feed.status`: 'ready' is the only state with a list to diff against. */
  feedStatus: FeedStatus;
  /** The Feed tab is the one on screen. */
  tabFocused: boolean;
}

/**
 * True only when all four hold: the tab is showing, the app is in the
 * foreground, the node is not known to be down, and there is a list on screen
 * to anchor a diff to.
 *
 * `'unknown'` is deliberately not treated as active: on iOS the first
 * `AppState.currentState` read can be `'unknown'` before the notification
 * arrives, and polling a moment later costs nothing.
 */
export const shouldPoll = ({
  appState,
  sessionStatus,
  feedStatus,
  tabFocused,
}: PollGateInput): boolean =>
  tabFocused &&
  appState === 'active' &&
  sessionStatus !== 'down' &&
  feedStatus === 'ready';