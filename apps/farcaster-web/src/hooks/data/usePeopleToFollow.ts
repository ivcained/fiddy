/**
 * People to follow — the data half of the surface at `/~/people`.
 *
 * The request is the client's own (`GET /v2/people-suggestions`), answered by
 * the node seam from the follow graph and channel casts — see
 * `~/snapchain/nodeApi/recommend.ts` for the ported engine and its MIT
 * attribution. The reason strings are built from the names this read
 * returns, never invented.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  type PeopleSuggestion,
  type PeopleSuggestionsResult,
  type ReasonName,
  suggestionReason,
} from '~/snapchain/nodeApi';
import { getSeamFetch } from '~/snapchain/seamFetchRef';

/** How many suggestions one page asks for. phunk's default. */
const LIMIT = 20;
/** The graph does not move fast enough for a shorter reuse to pay for 45
 * more node requests; the reader caches its own answer for the same minute. */
const STALE_TIME_MS = 60_000;

export interface PeopleToFollowError extends Error {
  /** The seam's own sentence, as written for the person to read. */
  message: string;
}

interface PeopleSuggestionsEnvelope {
  result?: PeopleSuggestionsResult;
  errors?: { message?: string }[];
}

const fetchPeopleSuggestions = async (): Promise<PeopleSuggestionsResult> => {
  const seamFetch = getSeamFetch();
  if (seamFetch === undefined) {
    throw new Error(
      'This build reads through its own node, and that reader is not switched on here.',
    );
  }
  const response = await seamFetch(`/v2/people-suggestions?limit=${LIMIT}`, {
    method: 'GET',
  });
  const body = (await response.json()) as PeopleSuggestionsEnvelope;
  if (!response.ok) {
    const message = body.errors?.[0]?.message;
    throw new Error(
      message ??
        `Your node did not answer the people-to-follow read (${response.status}).`,
    );
  }
  if (body.result === undefined) {
    throw new Error(
      'Your node answered the people-to-follow read with nothing readable.',
    );
  }
  return body.result;
};

export interface SuggestedPerson extends PeopleSuggestion {
  /** The one plain reason line, built from the read's own names. */
  reason: string;
}

const usePeopleToFollow = () => {
  const query = useQuery({
    queryKey: ['people-suggestions', LIMIT],
    queryFn: fetchPeopleSuggestions,
    staleTime: STALE_TIME_MS,
    retry: false,
  });

  const suggested = useMemo<SuggestedPerson[] | undefined>(() => {
    if (query.data === undefined) {
      return undefined;
    }
    return query.data.suggestions.map((suggestion) => {
      const names = new Map<number, ReasonName>();
      for (const name of suggestion.followedBy) {
        names.set(name.fid, name);
      }
      return { ...suggestion, reason: suggestionReason(suggestion, names) };
    });
  }, [query.data]);

  return {
    suggested,
    sampled: query.data?.sampled,
    channelsRead: query.data?.channelsRead,
    isLoading: query.isLoading,
    error: query.error as PeopleToFollowError | null,
    refetch: query.refetch,
  };
};

export { LIMIT as PEOPLE_SUGGESTIONS_LIMIT, usePeopleToFollow };
