import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import {
  ApiQuoteCastEmbed,
  CastHashPrefix,
  getCastHashPrefix,
} from 'farcaster-client-data';
import { useMemo } from 'react';

import { useFarcasterApiClient } from '../../../../providers/FarcasterApiClientProvider';
import {
  carriesEmbeds,
  getSpaceUrlEmbeds,
  mergeHydratedEmbeds,
  mergeSpaceUrlEmbeds,
  quoteCastHasContent,
} from '../../../../utils/quotedCastHydration';
import {
  useGloballyCachedCastWithoutFallback,
  useMergeIntoGloballyCachedCast,
} from '../globallyCachedCast';
import { buildUserCastFetcher } from './buildUserCastFetcher';
import { buildUserCastKey } from './buildUserCastKey';

const useUserCast = ({
  username,
  hashPrefix,
}: {
  username: string;
  hashPrefix: CastHashPrefix;
}) => {
  const { apiClient } = useFarcasterApiClient();
  const mergeIntoGloballyCachedCast = useMergeIntoGloballyCachedCast();

  return useSuspenseQuery({
    queryKey: buildUserCastKey({ username, hashPrefix }),

    queryFn: buildUserCastFetcher({
      apiClient,
      hashPrefix,
      mergeIntoGloballyCachedCast,
      username,
    }),
  });
};

const useNonSuspenseUserCast = ({
  username,
  hashPrefix,
  enabled = true,
}: {
  username: string | undefined;
  hashPrefix: CastHashPrefix | undefined;
  enabled?: boolean;
}) => {
  const { apiClient } = useFarcasterApiClient();
  const mergeIntoGloballyCachedCast = useMergeIntoGloballyCachedCast();

  return useQuery({
    queryKey: buildUserCastKey({ username, hashPrefix }),
    queryFn: buildUserCastFetcher({
      apiClient,
      hashPrefix: hashPrefix!,
      mergeIntoGloballyCachedCast,
      username: username!,
    }),
    enabled: enabled && !!username && !!hashPrefix,
  });
};

const useHydratedQuoteCast = ({ cast }: { cast: ApiQuoteCastEmbed }) => {
  const cachedCast = useGloballyCachedCastWithoutFallback({
    hash: cast.hash,
    recast: false,
  });

  const needsHydration =
    !cast.deleted &&
    !quoteCastHasContent(cast) &&
    !quoteCastHasContent(cachedCast);
  const hashPrefix = getCastHashPrefix({ castHash: cast.hash });

  const { data } = useNonSuspenseUserCast({
    username: cast.author.username,
    hashPrefix,
    enabled: needsHydration,
  });

  const fetchedCast = data?.result.cast;

  /**
   * The full copy of this cast, when one is in hand.
   *
   * The fetch above runs only for a cast that arrived thin, and this is what it
   * replaces. Whichever copy carries something the thin payload does not is the
   * one to merge from: a space URL (the reason this was first written) or the
   * cast *it* quotes. Gating on space URLs alone meant a quote of a quote — whose
   * hydration carries `casts` and no space URL — was fetched and then dropped, so
   * the card could never name or open the inner cast.
   *
   * Cached first: it is a cast the reader already opened, so it costs no request.
   */
  const sourceCast = carriesEmbeds(cachedCast)
    ? cachedCast
    : carriesEmbeds(fetchedCast)
      ? fetchedCast
      : undefined;

  // The space-URL merge reads its own subject, so it keeps seeing the same cast
  // it always did.
  const spaceUrlSource =
    getSpaceUrlEmbeds(cachedCast).length > 0
      ? cachedCast
      : getSpaceUrlEmbeds(fetchedCast).length > 0
        ? fetchedCast
        : undefined;

  return useMemo(() => {
    const withSpaceUrls = mergeSpaceUrlEmbeds({
      cast,
      sourceCast: spaceUrlSource,
    });
    return mergeHydratedEmbeds({ cast: withSpaceUrls, sourceCast });
  }, [cast, sourceCast, spaceUrlSource]);
};

export { useHydratedQuoteCast, useUserCast };
