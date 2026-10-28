/**
 * People to follow — `/~/people`.
 *
 * A ranked list of accounts the viewer might want to follow, each with one
 * plain reason and their latest casts, and Follow working from the list
 * through the same signed write path as the rest of the client.
 *
 * The ranking is COUNTS OFF THE NODE, nothing else: friends of friends and
 * shared channels, ported from phunk-client's recommend.py (MIT, Ramitphi —
 * see `~/snapchain/nodeApi/recommend.ts`). No model, no AI, no embedding
 * anywhere in this surface, and the page says so because it is true.
 */

import { FC, memo, Suspense, useCallback } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { Cast } from '~/components/casts/Cast';
import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { DefaultEmptyListView } from '~/components/lists/DefaultEmptyListView';
import { FullScreenLoadingIndicator } from '~/components/loaders/FullScreenLoadingIndicator';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { User } from '~/components/users/User';
import {
  type SuggestedPerson,
  usePeopleToFollow,
} from '~/hooks/data/usePeopleToFollow';
import { buildCastsWithContext } from '~/utils/castUtils';

const PeopleToFollowPage: FC = memo(() => {
  return (
    <Page meta={{ title: 'Fiddy / People to follow' }}>
      <BorderedMainContent>
        <PageHeader hideCastButton>
          <PageTitle>People to follow</PageTitle>
        </PageHeader>
        <div
          className="px-4 pb-2 text-sm text-muted"
          data-fiddy="people-to-follow-note"
        >
          Ranked by counts from your node: who your follows follow, and the
          channels you read. No AI involved.
        </div>
        <Suspense fallback={<FullScreenLoadingIndicator />}>
          <PeopleToFollowContent />
        </Suspense>
      </BorderedMainContent>
    </Page>
  );
});

const PeopleToFollowContent: FC = memo(() => {
  const { suggested, isLoading, error, refetch, sampled } = usePeopleToFollow();

  const onTryAgain = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (isLoading) {
    return <FullScreenLoadingIndicator />;
  }

  if (error) {
    return (
      <div className="p-4" data-fiddy="people-to-follow-error">
        <DefaultEmptyListView message={error.message} />
        <div className="mt-2 flex justify-center">
          <DefaultButton onClick={onTryAgain}>Try again</DefaultButton>
        </div>
      </div>
    );
  }

  if (!suggested || suggested.length === 0) {
    return (
      <DefaultEmptyListView
        message={
          sampled === 0
            ? 'Follow a few people first — then this list fills itself from who they follow.'
            : 'No suggestions right now: not enough of the people you follow share follows or channels yet.'
        }
      />
    );
  }

  return (
    <div data-fiddy="people-to-follow-list">
      {suggested.map((person) => (
        <PersonSuggestion key={person.user.fid} person={person} />
      ))}
    </div>
  );
});

const PersonSuggestion: FC<{ person: SuggestedPerson }> = memo(({ person }) => {
  // The latest casts, drawn with the same component the feed uses. Channel
  // tags show for top-level casts; a suggestion's casts are theirs, newest
  // first, and their thread/reply shape is kept as read.
  const castsWithContext = buildCastsWithContext(
    person.latestCasts.map((cast) => ({ cast })),
    { showChannelTag: () => true },
  );

  return (
    <div
      className="border-b py-2 border-default"
      data-fiddy="person-suggestion"
      data-fid={person.user.fid}
    >
      <User
        user={person.user}
        followStyle="inverted"
        showFollowButtonOnlyIfUnfollowed={true}
      />
      <div
        className="px-2 pb-1 pt-0.5 text-sm text-muted"
        data-fiddy="person-reason"
      >
        {person.reason}
      </div>
      {castsWithContext.length > 0 && (
        <div className="pl-2" data-fiddy="person-casts">
          {castsWithContext.map((castWithContext) => (
            <Cast
              key={castWithContext.cast.hash}
              castWithContext={castWithContext}
            />
          ))}
        </div>
      )}
    </div>
  );
});

PeopleToFollowPage.displayName = 'PeopleToFollowPage';
PeopleToFollowContent.displayName = 'PeopleToFollowContent';
PersonSuggestion.displayName = 'PersonSuggestion';

export { PeopleToFollowPage };
