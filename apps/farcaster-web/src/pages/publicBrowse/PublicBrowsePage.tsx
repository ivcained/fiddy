/**
 * The public browse surface: `/feed` and `/explore`.
 *
 * WHAT IT IS FOR
 *
 * A signed-out visitor had no way to read anything on fiddy.fun. The front door
 * asks for a name and a brain before it shows a single cast, and the only two
 * URLs that looked like a feed (`/feed`, `/explore`) resolved as usernames and
 * drew a stranger's months-old profile. So this is the other half of that fix:
 * real routes, real content, read with no account at all, reachable in one
 * press from the landing (`FiddyOnboardingPage`'s "Look around first").
 *
 * WHAT IT READS, AND FROM WHERE
 *
 * `usePublicWindow` posts the client's own feed request with the public feed
 * key; the node adapter answers it from real protocol messages through
 * whichever server the provider chain has live (`publicFeedWindow.ts` says
 * exactly which reads, and why). Nothing on this surface needs a session, a
 * cookie or a key.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No composer, no reaction, no follow: every one of those needs an account, so
 * a cast here draws its counts as plain text and Share (`Cast readOnly`), and
 * the surface says once, at the top, what signing in would add. There is no
 * auth wall - the casts are the page - and nothing here can render a private
 * cast: a node serves public protocol messages, which is all this reads.
 */

import { EventingProvider } from 'farcaster-client-hooks';
import { FC, memo, useCallback, useState } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { Cast } from '~/components/casts/Cast';
import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { FlatList } from '~/components/lists/FlatList';
import { LoginModal } from '~/components/modals/LoginModal';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import {
  type PublicBrowseVariant,
  type PublicWindow,
  usePublicWindow,
} from '~/hooks/data/usePublicWindow';
import { useSearchParams } from '~/hooks/navigation/useSearchParams';
import {
  hostAt,
  type MiniAppHostAccount,
  retryHostSignIn,
  useHost,
} from '~/lib/miniAppHost';
import { hostFidOf } from '~/snapchain/nodeApi/publicFeedWindow';
import { type ApiCastWithContext } from '~/types';
import { castWithContextKeyExtractor } from '~/utils/keyExtractorUtils';

/** How many cast-shaped placeholders a first read paints. */
const SKELETON_ROWS = 4;

const PublicCastSkeleton: FC = memo(() => (
  <div className="fiddy-public-skeleton" aria-hidden="true">
    <div className="fiddy-public-skeleton-avatar" />
    <div className="fiddy-public-skeleton-body">
      <div className="fiddy-public-skeleton-line fiddy-public-skeleton-line-short" />
      <div className="fiddy-public-skeleton-line fiddy-public-skeleton-line-full" />
      <div className="fiddy-public-skeleton-line fiddy-public-skeleton-line-mid" />
    </div>
  </div>
));

PublicCastSkeleton.displayName = 'PublicCastSkeleton';

const PublicWindowSkeletons: FC = memo(() => (
  <div
    className="fiddy-public-skeletons"
    data-fiddy="public-loading"
    role="status"
    aria-live="polite"
  >
    <span className="fiddy-public-loading-copy">
      Fiddy is looking for fresh casts…
    </span>
    {Array.from({ length: SKELETON_ROWS }, (_, index) => (
      <PublicCastSkeleton key={index} />
    ))}
  </div>
));

PublicWindowSkeletons.displayName = 'PublicWindowSkeletons';

/**
 * What a visitor with no account is told, once, at the top of the column.
 *
 * It says what reading costs (nothing) and what signing in buys (posting), and
 * it is a note rather than a wall: the casts are on the page below it.
 */
/**
 * What a person is told when the feed is ONE ACCOUNT'S Following feed.
 *
 * This is the continue-as surface: a Farcaster client named them and then would
 * not sign them in (a declined approval, an unanswerable request, a tab that
 * already tried). So the note says two things and nothing else — who this is,
 * and that reading costs no account — and the way to post is a real press
 * rather than a QR code aimed at the phone already holding the app.
 *
 * No technical reason is printed here. "The host did not answer the sign-in
 * request in time" is a sentence for a log, not for a person who wanted to read
 * their feed.
 */
const ContinueAsNote: FC<{
  host: MiniAppHostAccount | null;
  onSignIn: () => void;
}> = memo(({ host, onSignIn }) => (
  <div className="fiddy-public-note" data-fiddy="public-continue-as">
    <span>
      <b>
        {host
          ? `Carrying on as ${hostAt(host)}.`
          : 'Reading that account’s Following feed.'}
      </b>{' '}
      Reading only: nothing here posts, likes or follows until you say so.
    </span>
    <DefaultButton
      className="fiddy-public-note-btn"
      data-fiddy="continue-as-sign-in"
      onClick={onSignIn}
    >
      Sign in to post
    </DefaultButton>
  </div>
));

ContinueAsNote.displayName = 'ContinueAsNote';

const PublicReadingNote: FC<{
  onSignIn: () => void;
  variant: PublicBrowseVariant;
}> = memo(({ onSignIn, variant }) => (
  <div className="fiddy-public-note" data-fiddy="public-sign-in-prompt">
    <span>
      <b>Take a look around. No account needed.</b> These are{' '}
      {variant === 'explore'
        ? 'the casts getting attention on Farcaster right now'
        : 'the newest casts from people on Farcaster'}
      . When you want to reply, like or post, signing in is the next step.
    </span>
    <DefaultButton className="fiddy-public-note-btn" onClick={onSignIn}>
      Sign in to join in
    </DefaultButton>
  </div>
));

PublicReadingNote.displayName = 'PublicReadingNote';

/**
 * The two shapes of the same window, on `/feed`.
 *
 * `recent` is what is new, `trending` is what is getting attention. Both are
 * one read with a different feed type, so this is a switch and not a page.
 */
const PublicWindowTabs: FC<{ window: PublicWindow }> = memo(({ window }) => (
  <div className="fiddy-public-tabs" data-fiddy="public-tabs">
    <button
      type="button"
      className="fiddy-public-tab"
      data-fiddy="public-tab-recent"
      aria-current={window.kind === 'recent' ? 'page' : undefined}
      onClick={() => window.selectKind('recent')}
    >
      Newest
    </button>
    <button
      type="button"
      className="fiddy-public-tab"
      data-fiddy="public-tab-trending"
      aria-current={window.kind === 'trending' ? 'page' : undefined}
      onClick={() => window.selectKind('trending')}
    >
      Getting attention
    </button>
  </div>
));

PublicWindowTabs.displayName = 'PublicWindowTabs';

/**
 * The topic row, on `/explore`.
 *
 * The chips are the channels the window itself came from, with how many of its
 * casts are in each. Selecting one narrows the read to that channel's casts;
 * `← All of it` comes back. No channel directory is involved, because a page
 * cannot read one.
 */
const PublicTopicRow: FC<{ window: PublicWindow }> = memo(({ window }) => (
  <div className="fiddy-public-topics" data-fiddy="public-topics">
    {window.topic !== null && (
      <button
        type="button"
        className="fiddy-public-chip"
        data-fiddy="public-topic-all"
        onClick={() => window.selectTopic(null)}
      >
        &#8592; All of it
      </button>
    )}
    {window.topics.slice(0, 8).map((topic) => (
      <button
        key={topic.key}
        type="button"
        className="fiddy-public-chip"
        data-fiddy="public-topic"
        data-topic={topic.key}
        aria-pressed={window.topic === topic.key}
        onClick={() =>
          window.selectTopic(window.topic === topic.key ? null : topic.key)
        }
      >
        #{topic.key} <span className="opacity-60">{topic.count}</span>
      </button>
    ))}
  </div>
));

PublicTopicRow.displayName = 'PublicTopicRow';

const PublicBrowseColumn: FC<{
  variant: PublicBrowseVariant;
  asFid?: number;
  onSignIn: () => void;
}> = memo(({ variant, asFid, onSignIn }) => {
  const isSignedIn = useIsSignedIn();
  const window = usePublicWindow(
    variant,
    asFid !== undefined ? { as: asFid } : {},
  );
  // The account the Farcaster client named, when this surface was reached from
  // inside one. Null for a hand-typed `?as=<fid>` in a plain browser, where the
  // read still works and the note simply does not claim to know them.
  const host = useHost();
  const namedHost = host && host.fid === asFid ? host : null;

  const renderItem = useCallback(
    ({ item }: { item: ApiCastWithContext }) => (
      // readOnly: the counts and Share, and no button that needs an account.
      <Cast castWithContext={item} readOnly={!isSignedIn} />
    ),
    [isSignedIn],
  );

  return (
    <div
      className="fiddy-public"
      data-fiddy="public-browse"
      data-variant={variant}
      data-as={asFid !== undefined ? String(asFid) : undefined}
    >
      {!isSignedIn &&
        (asFid !== undefined ? (
          <ContinueAsNote host={namedHost} onSignIn={onSignIn} />
        ) : (
          <PublicReadingNote onSignIn={onSignIn} variant={variant} />
        ))}

      {/* Somebody's Following feed has one shape: there is no ranked view of it
          and its channels are not what the surface is about. */}
      {asFid !== undefined ? null : variant === 'feed' ? (
        <PublicWindowTabs window={window} />
      ) : (
        <PublicTopicRow window={window} />
      )}

      {window.isLoading ? (
        <PublicWindowSkeletons />
      ) : window.isError ? (
        <div className="fiddy-public-state" data-fiddy="public-error">
          <h2 className="fiddy-public-state-title">
            This could not be read just now.
          </h2>
          <p className="fiddy-public-state-body">{window.errorMessage}</p>
          <div className="fiddy-public-state-actions">
            <button
              type="button"
              className="fiddy-public-state-btn"
              data-fiddy="public-retry"
              onClick={window.retry}
            >
              Try again
            </button>
            {!isSignedIn && (
              <button
                type="button"
                className="fiddy-public-state-btn fiddy-public-state-btn-quiet"
                onClick={onSignIn}
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      ) : window.isEmpty ? (
        <div className="fiddy-public-state" data-fiddy="public-empty">
          <h2 className="fiddy-public-state-title">
            No fresh casts in this corner yet.
          </h2>
          <p className="fiddy-public-state-body">
            {window.topic !== null
              ? `Fiddy looked in #${window.topic}, but nothing came back this time. See everything, or look again in a minute.`
              : 'Fiddy looked, but the server had nothing to share this time. The network is not empty, so it is worth another look.'}
          </p>
          <div className="fiddy-public-state-actions">
            <button
              type="button"
              className="fiddy-public-state-btn"
              data-fiddy="public-retry"
              onClick={window.retry}
            >
              Look again
            </button>
            {window.topic !== null && (
              <button
                type="button"
                className="fiddy-public-state-btn fiddy-public-state-btn-quiet"
                onClick={() => window.selectTopic(null)}
              >
                See everything
              </button>
            )}
          </div>
        </div>
      ) : (
        <FlatList
          data={window.castsWithContext}
          emptyView={<PublicWindowSkeletons />}
          renderItem={renderItem}
          keyExtractor={castWithContextKeyExtractor}
          onEndReached={window.onEndReached}
          isFetchingNextPage={window.isFetchingNextPage}
        />
      )}

      <p className="fiddy-public-source" data-fiddy="public-source">
        {asFid !== undefined
          ? `This is the newest from the accounts ${
              namedHost ? hostAt(namedHost) : 'this account'
            } follows, read from the network itself. Nothing here acts as them, and no account of yours is involved.`
          : `This window is assembled from the network itself: the newest casts from the accounts a few long-standing public Farcaster accounts follow, read from the server this app is pointed at.${
              window.kind === 'trending'
                ? ' It is ordered by the likes and recasts the network really holds for those casts, not by a recommendation service.'
                : ''
            } No account of yours is involved, and signing in changes nothing about what is shown here.`}
      </p>
    </div>
  );
});

PublicBrowseColumn.displayName = 'PublicBrowseColumn';

const PublicBrowsePage: FC<{
  variant: PublicBrowseVariant;
  asFid?: number;
}> = memo(({ variant, asFid }) => {
  const [isSigningIn, setIsSigningIn] = useState(false);
  const host = useHost();
  const inHost = host !== null;

  /**
   * What "Sign in to post" does.
   *
   * Inside a Farcaster client the QR sheet is the exact dead end this surface
   * exists to avoid (the code cannot be scanned by the phone displaying it), so
   * the press asks the HOST again — the same, proven sign-in the automatic path
   * runs, cleared of its one-shot mark so one deliberate press is enough
   * (`retryHostSignIn`). In a plain browser the ordinary sign-in sheet is
   * right.
   */
  const onSignIn = useCallback(() => {
    if (asFid !== undefined && inHost) {
      retryHostSignIn();
      return;
    }

    setIsSigningIn(true);
  }, [asFid, inHost]);

  const title =
    asFid !== undefined
      ? 'Following'
      : variant === 'explore'
        ? 'Explore'
        : 'Feed';

  return (
    <Page
      meta={{
        title:
          asFid !== undefined
            ? 'Fiddy / Following'
            : variant === 'explore'
              ? 'Fiddy / Explore'
              : 'Fiddy / Feed',
        description:
          asFid !== undefined
            ? 'Read an account’s Following feed on Farcaster, with nothing signed.'
            : 'Read what Farcaster is saying right now, with no account needed.',
      }}
    >
      <BorderedMainContent>
        <PageHeader footer={undefined}>
          <PageTitle>{title}</PageTitle>
        </PageHeader>
        {/* The column's own reads report through the eventing provider, the
            same way the home feed's do. */}
        <EventingProvider on="explore" feed={variant}>
          <PublicBrowseColumn
            variant={variant}
            asFid={asFid}
            onSignIn={onSignIn}
          />
        </EventingProvider>
      </BorderedMainContent>
      {isSigningIn && <LoginModal onClose={() => setIsSigningIn(false)} />}
    </Page>
  );
});

PublicBrowsePage.displayName = 'PublicBrowsePage';

/**
 * `/feed`: the public window, newest first, with the ranked view beside it.
 *
 * `?as=<fid>` is the continue-as read: that account's Following feed instead of
 * the anchored window (`~/lib/miniAppHost`). The FID is validated here so a URL
 * someone typed can only ever ask for a real account number, and an invalid one
 * falls back to the ordinary public window rather than an error page.
 */
const PublicFeedPage: FC = memo(() => {
  const { as } = useSearchParams('publicFeed');
  const asFid = hostFidOf(typeof as === 'string' ? as : null);

  return (
    <PublicBrowsePage variant="feed" {...(asFid !== null ? { asFid } : {})} />
  );
});
PublicFeedPage.displayName = 'PublicFeedPage';

/** `/explore`: the same window by topic, ranked by real engagement. */
const PublicExplorePage: FC = memo(() => (
  <PublicBrowsePage variant="explore" />
));
PublicExplorePage.displayName = 'PublicExplorePage';

export { PublicExplorePage, PublicFeedPage };
