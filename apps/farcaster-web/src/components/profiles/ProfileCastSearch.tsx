import { ApiCast } from 'farcaster-client-data';
import { useFarcasterApiClient } from 'farcaster-client-hooks';
import {
  FC,
  memo,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Cast } from '~/components/casts/Cast';
import { SearchInput } from '~/components/forms/SearchInput';
import { EmptySearchResultsListView } from '~/components/lists/EmptySearchResultsListView';
import { FlatList } from '~/components/lists/FlatList';
import { LoadingIndicator } from '~/components/loaders/LoadingIndicator';
import { useCastsWithContext } from '~/hooks/casts/useCastsWithContext';
import { ApiCastWithContext } from '~/types';
import { castWithContextKeyExtractor } from '~/utils/keyExtractorUtils';

/**
 * Searching one person's casts from their profile (quilcast 0.77.0, MIT —
 * the search itself is read from the node's own route, `/v2/user-cast-search`,
 * assembled in `~/snapchain/nodeApi/castSearch.ts`).
 *
 * The words a person's casts are searched by are matched against the node's
 * own text, so the two limits the reader knows are said here in plain words,
 * never left as a silent empty page:
 *   - a cast's stored text has its @mentions cut out of it, so a mentioned
 *     name is not a searchable word;
 *   - one load reads at most 50,000 casts before it hands back what it found,
 *     so a word only in a very busy account's older casts is honestly missed.
 */

interface UserCastSearchAnswer {
  result: { casts: ApiCast[] };
  next: { cursor: string | null };
  capped?: boolean;
  most?: number;
}

type SearchBoxProps = {
  name: string;
  value: string;
  onChange: (value: string) => void;
};

const ProfileCastSearchBox: FC<SearchBoxProps> = memo(
  ({ name, value, onChange }) => (
    <div className="px-2 py-2">
      <SearchInput
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onClear={() => onChange('')}
        placeholder={`Search ${name}'s casts`}
        aria-label={`Search ${name}'s casts`}
        showFilterIcon={false}
      />
    </div>
  ),
);
ProfileCastSearchBox.displayName = 'ProfileCastSearchBox';

type SearchResultsProps = {
  fid: number;
  term: string;
  name: string;
};

const ProfileCastSearchResults: FC<SearchResultsProps> = memo(
  ({ fid, term, name }) => {
    const { apiClient, baseUrl } = useFarcasterApiClient();

    // The client class is the fork's generated snapshot and stays untouched;
    // the fetch it is configured with IS the seam every other request flows
    // through, so this read goes through it too (provider-aware, node-backed).
    const readSearch = useCallback(
      async (q: string, cursor?: string): Promise<UserCastSearchAnswer> => {
        const wrappedFetch =
          apiClient.options.getFetch?.() ?? fetch.bind(globalThis);
        const params = new URLSearchParams({ fid: String(fid), q });
        if (cursor) {
          params.set('cursor', cursor);
        }
        const response = await wrappedFetch(
          `${baseUrl}/v2/user-cast-search?${params.toString()}`,
        );
        if (!response.ok) {
          throw new Error(
            `The search did not answer (${response.status}). Try again in a moment.`,
          );
        }
        return (await response.json()) as UserCastSearchAnswer;
      },
      [apiClient, baseUrl, fid],
    );

    // The search on screen right now: a load for an older term reads no more
    // results into this list once the term has changed.
    const currentTerm = useRef('');
    const [casts, setCasts] = useState<ApiCast[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [cap, setCap] = useState<number | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);

    useEffect(() => {
      const askedTerm = term;
      currentTerm.current = askedTerm;
      const stillWanted = () => currentTerm.current === askedTerm;

      setCasts([]);
      setCursor(null);
      setCap(undefined);
      setError(undefined);
      setLoading(true);

      readSearch(askedTerm)
        .then((answer) => {
          if (!stillWanted()) {
            return;
          }
          setCasts(answer.result.casts);
          setCursor(answer.next.cursor);
          setCap(answer.capped ? answer.most : undefined);
        })
        .catch((reason: unknown) => {
          if (stillWanted()) {
            setError(
              reason instanceof Error
                ? reason.message
                : 'The search did not answer. Try again in a moment.',
            );
          }
        })
        .finally(() => {
          if (stillWanted()) {
            setLoading(false);
          }
        });

      return () => {
        // A term that is no longer on screen stops owning the list.
        currentTerm.current = '';
      };
    }, [readSearch, term]);

    const onEndReached = useCallback(() => {
      if (cursor === null || loading || loadingMore) {
        return;
      }
      const askedTerm = term;
      const stillWanted = () => currentTerm.current === askedTerm;
      setLoadingMore(true);
      readSearch(askedTerm, cursor)
        .then((answer) => {
          if (!stillWanted()) {
            return;
          }
          // The next page starts after what the list already shows, so the
          // pages are appended, not merged.
          setCasts((shown) => [...shown, ...answer.result.casts]);
          setCursor(answer.next.cursor);
        })
        .catch((reason: unknown) => {
          if (stillWanted()) {
            setError(
              reason instanceof Error
                ? reason.message
                : 'The next page did not answer. Try again in a moment.',
            );
          }
        })
        .finally(() => {
          if (stillWanted()) {
            setLoadingMore(false);
          }
        });
    }, [cursor, loading, loadingMore, readSearch, term]);

    const castsWithContext = useCastsWithContext(casts, {
      forceThreadPosition: 'start_and_end',
    });

    const renderItem = useCallback(
      ({ item }: { item: ApiCastWithContext }) => (
        <Cast castWithContext={item} />
      ),
      [],
    );

    const emptyView = useMemo(() => {
      if (error !== undefined) {
        return <p className="p-4 text-center text-muted">{error}</p>;
      }
      if (loading) {
        return (
          <div className="flex justify-center p-4">
            <LoadingIndicator size="sm" />
          </div>
        );
      }
      return cap !== undefined ? (
        <EmptySearchResultsListView
          message={`None of ${name}'s newest ${cap.toLocaleString()} casts match "${term}".`}
          subMessage="Older casts weren't searched. @names inside casts aren't searched either."
        />
      ) : (
        <EmptySearchResultsListView
          message={`No casts by ${name} match "${term}".`}
          subMessage="@names inside casts aren't searched."
        />
      );
    }, [cap, error, loading, name, term]);

    return (
      <FlatList
        data={castsWithContext}
        renderItem={renderItem}
        keyExtractor={castWithContextKeyExtractor}
        onEndReached={onEndReached}
        isFetchingNextPage={loadingMore}
        emptyView={emptyView}
      />
    );
  },
);
ProfileCastSearchResults.displayName = 'ProfileCastSearchResults';

type ProfileCastSearchProps = {
  name: string;
  fid: number;
  /** The profile's own casts list, shown whenever no search is on. */
  children: ReactNode;
};

/**
 * The search box, and the results that take the casts list's place while a
 * search is on (the same swap quilcast makes on its profile).
 */
const ProfileCastSearch: FC<ProfileCastSearchProps> = ({
  name,
  fid,
  children,
}) => {
  const [term, setTerm] = useState('');
  // Settled typing, not every keystroke: a search load reads the account's
  // casts page by page, so a load per keystroke would cost a read a letter.
  const [asked, setAsked] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setAsked(term), 350);
    return () => clearTimeout(timer);
  }, [term]);

  const searching = asked.trim().length > 0;

  return (
    <>
      <ProfileCastSearchBox name={name} value={term} onChange={setTerm} />
      {searching ? (
        <ProfileCastSearchResults fid={fid} term={asked.trim()} name={name} />
      ) : (
        children
      )}
    </>
  );
};

ProfileCastSearch.displayName = 'ProfileCastSearch';

export { ProfileCastSearch };
