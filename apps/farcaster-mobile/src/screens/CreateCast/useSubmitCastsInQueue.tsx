import { AnalyticsEvent } from 'farcaster-analytics';
import {
  ApiCast,
  ApiCreateCast201Response,
  ApiOpenGraphMetadata,
  getCastHashPrefix,
  getTokenEmbedUrl,
  parseCAIP19Token,
} from 'farcaster-client-data';
import {
  CastReactionType,
  sleep,
  useCreateCast,
  useDiscardDraftCast,
  useFetchOpenGraphMetadata,
  useOptimisticallyAddNewCastToThread,
  usePrefetchUserThreadCasts,
  useStoreDraftCaststorm,
  useTrackCastReaction,
} from 'farcaster-client-hooks';
import { useRootToast } from 'farcaster-expo';
import { useCallback, useRef } from 'react';

import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useAppStoreReview } from '~/contexts/AppStoreReviewProvider';
import {
  type CastQueueResume,
  useCastQueue,
} from '~/contexts/CastQueueProvider';
import { useUserAppContext } from '~/contexts/UserAppContextProvider';
import { useCurrentUser_UNSAFE } from '~/hooks/data/useCurrentUser';
import type { QueuedCastInfoWithEmbeds } from '~/types';
import { buildApiCastUrlEmbedFromMetadata } from '~/utils/CastUtils';
import { trackError } from '~/utils/ErrorUtils';

import { dedupeEmbedReferences } from './dedupeEmbedReferences';
import { getDedupedEmbedsArrayFromOptimisticEmbeds } from './getDedupedEmbedsArrayFromOptimisticEmbeds';
import { setLocalDraft } from './LocalDrafts';
import {
  getOptimisticMediaLookupKey,
  useOptimisticMediaEmbeds,
} from './OptimisticMediaEmbedsProvider';

function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}

const GENERIC_CAST_ERROR_MESSAGE = 'Failed to cast';

/**
 * What a thread that failed partway says in its toast: what is already public,
 * and that the rest follows as replies. Plain words, no hashes (the product
 * voice never names protocol internals).
 */
function getPartialThreadMessage({
  posted,
  total,
}: {
  posted: number;
  total: number;
}): string {
  return `${posted} of ${total} already posted. The rest will go out as replies.`;
}

function useSubmitCastsInQueue() {
  const { fid: currentUserFid } = useCurrentUser_UNSAFE();
  const { regularCastByteLimit } = useUserAppContext();
  const { trackEvent } = useAnalytics();
  const { requestReview } = useAppStoreReview();
  const toast = useRootToast();

  const onAfterSuccessfulCast = useCallback(() => {
    requestReview({ when: 'after-cast' });
  }, [requestReview]);

  const createCast = useCreateCast();
  const optimisticallyAddNewCastToThread =
    useOptimisticallyAddNewCastToThread('bottom');
  const trackCastReaction = useTrackCastReaction();
  const discardDraftCast = useDiscardDraftCast();
  const storeDraftCaststorm = useStoreDraftCaststorm();
  const prefetchThread = usePrefetchUserThreadCasts();

  const { reducer } = useCastQueue();
  const [state, dispatch] = reducer;
  const [optimisticMediaEmbedsState] = useOptimisticMediaEmbeds();
  const { getCachedOpenGraphMetadataSnapshot } = useFetchOpenGraphMetadata();

  const markCastAsErrored = useCallback(
    ({
      queueId,
      error,
      message,
    }: {
      queueId: string;
      error?: unknown;
      message?: string;
    }) => {
      const errorMessage =
        message ?? getErrorMessage(error) ?? GENERIC_CAST_ERROR_MESSAGE;
      const payload = state[queueId];

      payload?.params.onError?.(errorMessage);
      toast.show(errorMessage, {
        type: 'danger',
        duration: 5_000,
      });

      dispatch({
        type: 'MarkAsErrored',
        queueId,
        errorMessage,
      });
    },
    [dispatch, state, toast],
  );

  // Tracks the pre-publish auto-saved draftId per cast identity
  // (`castQueueId`, which is stable across retries of the same cast). If the
  // user retries a failed cast, we reuse that cast's draftId so the recovery
  // auto-save upserts in place instead of piling up near-identical drafts.
  // Keying by `castQueueId` (rather than a single shared ref) ensures an
  // unrelated later publish never reuses a previous failed cast's draftId and
  // clobbers its recovery draft. This is the queue-runner counterpart to the
  // composer-level `autoSavedDraftIdRef` used by the background/
  // visibilitychange auto-save path.
  const prePublishAutoSavedDraftIdsRef = useRef<Map<string, string>>(new Map());

  const sendCast = useCallback(
    async ({ queueId }: { queueId: string }) => {
      const payload = state[queueId];
      const cachedMetadataSnapshot = getCachedOpenGraphMetadataSnapshot();

      const queuedCasts = payload.params.casts;
      const activeDraftId = payload.params.activeDraftId;
      const scheduledAt = payload.params.scheduledAt;
      const channelKey = payload.params.channelKey;
      const feed = payload.params.feed;
      const includeReason = payload.params.includeReason;
      const quoteReactions = payload.params.quoteReactions ?? [];
      const tokenKey = payload.params.tokenKey;
      const parentCastHash = payload.params.parentCastHash;
      const localDraftKey = payload.params.localDraftKey;
      const queueIdOverrideForEmbeds = payload.params.queueIdOverrideForEmbeds;
      const isReplyFlow = typeof parentCastHash !== 'undefined';
      const parsedToken = tokenKey ? parseCAIP19Token(tokenKey) : null;
      const tokenEmbedUrlForReply =
        isReplyFlow && parsedToken !== null
          ? getTokenEmbedUrl({ chain: parsedToken.chain, ca: parsedToken.ca })
          : undefined;

      const castQueueId =
        typeof queueIdOverrideForEmbeds !== 'undefined'
          ? queueIdOverrideForEmbeds
          : queueId;

      // A publish that failed partway leaves only the posts that never went out
      // in `casts`, with `parentCastHash` pointing at the last cast that did and
      // this remembering where the thread began (see CastQueueResume).
      const resume: CastQueueResume | undefined = payload.params.resume;
      const postedBefore = resume?.postedCount ?? 0;
      const threadLength = resume?.totalCount ?? queuedCasts.length;
      // The cast the whole thread replies to. After a partial failure
      // `parentCastHash` is the last cast that went out instead, so the original
      // target is read from the resume record.
      const threadParentCastHash: string | undefined =
        resume?.rootParentCastHash ?? parentCastHash;

      const storeRecoveryDraft = async ({
        draftId,
        casts,
        replyParentCastHash,
      }: {
        draftId: string | undefined;
        /**
         * The posts this draft holds. Usually the whole queue, but after a
         * thread failed partway it holds only what never went out, so reopening
         * the draft cannot post what is already public again.
         */
        casts: QueuedCastInfoWithEmbeds[];
        replyParentCastHash: string | undefined;
      }): Promise<string | undefined> => {
        try {
          const autoSaveResponse = await storeDraftCaststorm({
            caststorm: {
              casts: casts.map((queuedCast) => ({
                text: queuedCast.text.trim(),
                embeds: dedupeEmbedReferences([
                  ...(queuedCast.embeds ?? []),
                  ...(typeof tokenEmbedUrlForReply !== 'undefined'
                    ? [tokenEmbedUrlForReply]
                    : []),
                ]),
              })),
              parent:
                typeof replyParentCastHash !== 'undefined'
                  ? { hash: replyParentCastHash }
                  : undefined,
              channelKey,
              draftId,
            },
            // Re-send the opened draft's schedule. The backend treats
            // `scheduledAt` as authoritative on every store, so upserting a
            // scheduled draft without it would silently unschedule it.
            scheduledAt,
          });
          const storedDraftId = autoSaveResponse.result.draft.draftId;
          prePublishAutoSavedDraftIdsRef.current.set(
            castQueueId,
            storedDraftId,
          );

          if (typeof draftId !== 'undefined' && draftId !== storedDraftId) {
            // Fallback for an older backend that ignored `draftId` and created
            // a new draft instead of upserting.
            try {
              await discardDraftCast({
                draftId,
                castChannelKey: undefined,
              });
            } catch (error) {
              trackError(JSON.stringify(error));
            }
          }

          return storedDraftId;
        } catch (error) {
          trackError(JSON.stringify(error));
          return draftId;
        }
      };

      // Save text and already-resolved embeds before awaiting optimistic media.
      // This guarantees upload failures still leave a server recovery draft.
      const previousAutoSavedDraftId =
        prePublishAutoSavedDraftIdsRef.current.get(castQueueId) ??
        activeDraftId;
      let autoSavedDraftId = await storeRecoveryDraft({
        draftId: previousAutoSavedDraftId,
        casts: queuedCasts,
        replyParentCastHash: parentCastHash,
      });
      let shouldRefreshRecoveryDraft = false;

      let firstQueuedCastString: string | undefined = undefined;
      let firstQueuedCastEmbeds: string[] | undefined = undefined;

      for (const queuedCast of queuedCasts) {
        const { lookupKey } = getOptimisticMediaLookupKey({
          castQueueId: castQueueId,
          castLocalKey: queuedCast.localKey,
        });

        const embedStateLookups = optimisticMediaEmbedsState[lookupKey];

        if (typeof embedStateLookups === 'undefined') {
          const mergedEmbeds = [...(queuedCast.embeds ?? [])];
          if (typeof tokenEmbedUrlForReply !== 'undefined') {
            // Preserve any pre-existing embeds on the queued cast (e.g. from
            // intent/draft hydration) and append the token URL while deduping.
            mergedEmbeds.push(tokenEmbedUrlForReply);
          }
          queuedCast.embeds = dedupeEmbedReferences(mergedEmbeds);

          if (typeof firstQueuedCastEmbeds === 'undefined') {
            firstQueuedCastEmbeds = queuedCast.embeds;
          }

          continue;
        }

        try {
          shouldRefreshRecoveryDraft = true;
          const { dedupedEmbeds } =
            await getDedupedEmbedsArrayFromOptimisticEmbeds({
              optimisticVideos: embedStateLookups.optimisticVideos,
              optimisticImages: embedStateLookups.optimisticImages,
              urls: embedStateLookups.urls,
            });

          // Keep the embeds captured at enqueue time as source-of-truth for
          // ordering/prioritization, then merge in any freshly resolved upload
          // URLs from optimistic state. This prevents valid link embeds from
          // being dropped when optimistic URL extraction diverges. When the
          // composer picked a token in a reply flow, also ensure the canonical
          // token embed URL is present.
          const queuedEmbeds = queuedCast.embeds ?? [];
          const mergedEmbeds = [...queuedEmbeds, ...dedupedEmbeds];
          if (typeof tokenEmbedUrlForReply !== 'undefined') {
            mergedEmbeds.push(tokenEmbedUrlForReply);
          }
          queuedCast.embeds = dedupeEmbedReferences(mergedEmbeds);

          const matchingClientProcessedEmbeds = new Map<
            string,
            ApiOpenGraphMetadata
          >();
          for (const embedReference of queuedCast.embeds) {
            const trimmedUrl = embedReference.trim();

            const cachedResult = cachedMetadataSnapshot.get(trimmedUrl);
            if (!cachedResult || cachedResult.status !== 'card_found') {
              continue;
            }

            const castUrlEmbed = buildApiCastUrlEmbedFromMetadata({
              requestedUrl: trimmedUrl,
              result: cachedResult,
            });

            matchingClientProcessedEmbeds.set(
              castUrlEmbed.openGraph.url,
              castUrlEmbed.openGraph,
            );
          }

          if (matchingClientProcessedEmbeds.size > 0) {
            queuedCast.clientProcessedOpenGraphMetadata = Array.from(
              matchingClientProcessedEmbeds.values(),
            );
          }

          if (typeof firstQueuedCastEmbeds === 'undefined') {
            firstQueuedCastEmbeds = queuedCast.embeds;
          }
        } catch (error) {
          markCastAsErrored({ queueId, error });

          return;
        }
      }

      if (shouldRefreshRecoveryDraft) {
        const refreshedDraftId = await storeRecoveryDraft({
          draftId: autoSavedDraftId ?? previousAutoSavedDraftId,
          casts: queuedCasts,
          replyParentCastHash: parentCastHash,
        });
        autoSavedDraftId = refreshedDraftId ?? autoSavedDraftId;
      }

      const postedCasts: { hash: string }[] = [];
      /**
       * The quote and reply reactions belong to the thread's first post going
       * out -- true whether or not the rest of the thread lands -- so they are
       * credited exactly once, by the run that posted it.
       */
      const creditThreadStartReactions = () => {
        for (const quoteReaction of quoteReactions) {
          trackCastReaction({
            castHash: quoteReaction.castHash,
            type: CastReactionType.Quote,
            undo: false,
            castFid: quoteReaction.castFid,
            ...(feed ? { feed } : {}),
            ...(includeReason ? { includeReason } : {}),
          });
        }

        if (typeof parentCastHash !== 'undefined') {
          trackCastReaction({
            castHash: parentCastHash,
            type: CastReactionType.Reply,
            undo: false,
            ...(includeReason ? { includeReason } : {}),
          });
        }
      };
      // Hoisted out of the try so a failure partway can report what already went
      // out: the thread's first cast and the replies that landed.
      let firstData: ApiCreateCast201Response | undefined = undefined;
      const publishedReplies: {
        parentCastHash: string;
        cast: ApiCast;
      }[] = [];

      try {
        let nextParentCastHash = parentCastHash;

        for (let i = 0; i < queuedCasts.length; i++) {
          const queuedCast = queuedCasts[i];
          const castParentHash = nextParentCastHash;

          const queuedCastText = queuedCast.text.trim();

          if (typeof firstQueuedCastString === 'undefined') {
            firstQueuedCastString = queuedCastText;
          }

          const isLongCast =
            Buffer.byteLength(queuedCastText, 'utf-8') > regularCastByteLimit;

          trackEvent(AnalyticsEvent.CastMessage, {
            'is reply': typeof parentCastHash !== 'undefined' || i !== 0,
            'is channel': !!channelKey,
            'channel name': channelKey ?? '',
            'is long cast': isLongCast,
            'is caststorm': queuedCasts.length,
            'embed count': queuedCast.embeds.length,
            'char count': queuedCast.text.length,
          });

          const data = await createCast({
            fid: currentUserFid,
            castText: queuedCastText,
            parentCastHash: castParentHash,
            channelKey,
            tokenKey,
            embeds: queuedCast.embeds,
            clientProcessedOpenGraphMetadata:
              queuedCast.clientProcessedOpenGraphMetadata,
          });

          if (data === null) {
            trackError('Received empty response after casting');

            // Let the catch decide what to do with whatever already went out:
            // a thread that failed partway resumes from its last post.
            throw new Error(GENERIC_CAST_ERROR_MESSAGE);
          }

          if (typeof castParentHash !== 'undefined') {
            // Reconcile after the queue leaves its publishing state so the
            // reply does not appear underneath an in-progress toast.
            publishedReplies.push({
              parentCastHash: castParentHash,
              cast: data.result.cast,
            });
          }

          if (!firstData) {
            firstData = data;
          }

          postedCasts.push({
            hash: data.result.cast.hash,
          });

          nextParentCastHash = data.result.cast.hash;
        }

        if (typeof autoSavedDraftId !== 'undefined') {
          try {
            await discardDraftCast({
              draftId: autoSavedDraftId,
              castChannelKey: undefined,
            });
          } catch (error) {
            trackError(JSON.stringify(error));
          }
          prePublishAutoSavedDraftIdsRef.current.delete(castQueueId);
        }

        if (
          typeof activeDraftId !== 'undefined' &&
          activeDraftId !== autoSavedDraftId
        ) {
          // The user published a draft they had opened for editing; remove the
          // original so it doesn't linger as a duplicate of the published cast.
          // Awaited + caught (was fire-and-forget) so a failed delete surfaces
          // instead of silently leaving the stale draft behind.
          try {
            await discardDraftCast({
              draftId: activeDraftId,
              castChannelKey: undefined,
            });
          } catch (error) {
            trackError(error);
          }
        }

        await setLocalDraft(undefined, localDraftKey);

        if (typeof firstData !== 'undefined' || typeof resume !== 'undefined') {
          // The thread's first cast: on a retry that cast went out on an earlier
          // run, so the resume record supplies it and this run reports the
          // thread as a whole (mini apps hear the first cast, not the last).
          const rootCastHash =
            resume?.rootCastHash ?? firstData?.result.cast.hash;

          if (typeof rootCastHash !== 'undefined') {
            // Quote and reply reactions belong to the first post going out; a
            // retry only posts the rest and must not credit them twice.
            if (typeof resume === 'undefined') {
              creditThreadStartReactions();
            }

            return {
              castAuthorUsername:
                resume?.rootCastAuthorUsername ??
                firstData?.result.cast.author.username,
              castHash: rootCastHash,
              castText: resume?.rootCastText ?? firstQueuedCastString,
              castChannelKey: channelKey,
              castEmbeds: resume?.rootCastEmbeds ?? firstQueuedCastEmbeds,
              castParent:
                typeof threadParentCastHash !== 'undefined'
                  ? { type: 'cast' as const, hash: threadParentCastHash }
                  : undefined,
              publishedReplies,
            };
          }
        }
      } catch (error) {
        trackError(JSON.stringify(error));

        const sentThisRun = postedCasts.length;

        if (sentThisRun > 0) {
          // A thread that failed partway. Nothing already public is deleted:
          // a delete is visible to the network, cannot un-notify the parent's
          // author, and a failed delete turns the retry into duplicates. What
          // is left stays queued, replying to the last cast that went out, and
          // the queue record remembers where the thread began so "Try again"
          // continues it instead of forking from the original parent.
          const leftCasts = queuedCasts.slice(sentThisRun);
          const lastSentCastHash = postedCasts[sentThisRun - 1].hash;

          payload.params.casts = leftCasts;
          payload.params.parentCastHash = lastSentCastHash;
          // Credited when the first post went out; a retry posts the rest only.
          payload.params.quoteReactions = [];
          payload.params.resume = {
            rootCastHash: resume?.rootCastHash ?? postedCasts[0].hash,
            rootCastAuthorUsername:
              resume?.rootCastAuthorUsername ??
              firstData?.result.cast.author.username,
            rootCastText: resume?.rootCastText ?? firstQueuedCastString,
            rootCastEmbeds: resume?.rootCastEmbeds ?? firstQueuedCastEmbeds,
            rootParentCastHash: threadParentCastHash,
            postedCount: postedBefore + sentThisRun,
            totalCount: threadLength,
          };

          // The recovery draft follows what is left, so reopening it cannot
          // repost what is already public.
          autoSavedDraftId =
            (await storeRecoveryDraft({
              draftId: autoSavedDraftId ?? previousAutoSavedDraftId,
              casts: leftCasts,
              replyParentCastHash: lastSentCastHash,
            })) ?? autoSavedDraftId;

          // The draft this publish was opened from still holds the whole
          // thread; once part of it is public, reopening that draft and sending
          // it would post the rest of the thread twice.
          if (
            typeof activeDraftId !== 'undefined' &&
            activeDraftId !== autoSavedDraftId
          ) {
            try {
              await discardDraftCast({
                draftId: activeDraftId,
                castChannelKey: undefined,
              });
            } catch (discardError) {
              trackError(discardError);
            }
          }

          // The replies that landed are public, and the queue is about to leave
          // its publishing state, so reconcile them into the thread now.
          for (const publishedReply of publishedReplies) {
            optimisticallyAddNewCastToThread(publishedReply);
          }

          // The thread's first post is out, so the reply and quote it carried
          // are true even though the rest did not land. Credited here, once:
          // the retry that finishes the thread does not credit them again.
          if (typeof resume === 'undefined') {
            creditThreadStartReactions();
          }

          // The on-device copy holds the whole thread too: restoring it would
          // repost what is already public. The server recovery draft above is
          // what keeps the rest.
          await setLocalDraft(undefined, localDraftKey);
        }

        markCastAsErrored({
          queueId,
          error,
          message:
            sentThisRun > 0
              ? getPartialThreadMessage({
                  posted: postedBefore + sentThisRun,
                  total: threadLength,
                })
              : undefined,
        });
      }
    },
    [
      createCast,
      currentUserFid,
      discardDraftCast,
      getCachedOpenGraphMetadataSnapshot,
      markCastAsErrored,
      optimisticallyAddNewCastToThread,
      optimisticMediaEmbedsState,
      regularCastByteLimit,
      state,
      storeDraftCaststorm,
      trackCastReaction,
      trackEvent,
    ],
  );

  return useCallback(
    async ({ queueId }: { queueId: string }) => {
      const payload = state[queueId];

      const onSuccess = payload.params.onSuccess;

      const [, result] = await Promise.all([
        // Always await at least 2.5 seconds for the queued casts toast animations. Otherwise too jarring.
        sleep(2_500),
        sendCast({ queueId }),
      ]);

      if (typeof result !== 'undefined') {
        try {
          if (typeof result.castAuthorUsername !== 'undefined') {
            prefetchThread({
              castHashPrefix: getCastHashPrefix({ castHash: result.castHash }),
              username: result.castAuthorUsername,
            });
          }
        } catch {
          // No-op: we don't care if prefetching fails above - continue to mark as published.
        }

        dispatch({
          type: 'MarkAsPublished',
          queueId,
          castAuthorUsername: result.castAuthorUsername,
          castHash: result.castHash,
        });
        for (const publishedReply of result.publishedReplies) {
          optimisticallyAddNewCastToThread(publishedReply);
        }

        if (typeof onSuccess === 'undefined') {
          // Potentially request App Store review after a successful cast
          onAfterSuccessfulCast();
        }

        if (typeof onSuccess !== 'undefined') {
          onSuccess({
            hash: result.castHash,
            text: result.castText,
            channelKey: payload.params.channelKey,
            parent: result.castParent,
            // @ts-expect-error-next-line The embed array typing here is a bit odd
            embeds: result.castEmbeds,
          });
        }
      }
    },
    [
      dispatch,
      onAfterSuccessfulCast,
      optimisticallyAddNewCastToThread,
      prefetchThread,
      sendCast,
      state,
    ],
  );
}

export { getDedupedEmbedsArrayFromOptimisticEmbeds, useSubmitCastsInQueue };
