import { act, renderHook } from '@testing-library/react-native';

import { useSubmitCastsInQueue } from '../useSubmitCastsInQueue';

// A thread whose publish fails partway (quilcast 0.80.0, MIT: src/write.ts
// `postThread` + src/compose.tsx `cont`). What went out stays out: nothing is
// deleted, and the queue keeps only the posts that never went out, replying to
// the last cast that did, so "Try again" continues the thread instead of
// forking it from the original parent.

const mockStoreDraftCaststorm = jest.fn();
const mockCreateCast = jest.fn();
const mockDiscardDraftCast = jest.fn();
const mockDeleteCast = jest.fn();
const mockTrackCastReaction = jest.fn();
const mockPrefetchThread = jest.fn();
const mockOptimisticallyAddNewCastToThread = jest.fn();
const mockToastShow = jest.fn();
const mockDispatch = jest.fn();
const mockRequestReview = jest.fn();
const mockTrackEvent = jest.fn();
const mockSetLocalDraft = jest.fn();

const mockQueueState: Record<string, unknown> = {};

jest.mock('farcaster-analytics', () => ({
  AnalyticsEvent: { CastMessage: 'cast_message' },
}));

jest.mock('farcaster-client-data', () => ({
  getCastHashPrefix: () => 'prefix',
  getTokenEmbedUrl: () => 'token-url',
  parseCAIP19Token: () => null,
}));

jest.mock('farcaster-client-hooks', () => ({
  CastReactionType: { Quote: 'quote', Reply: 'reply' },
  sleep: () => Promise.resolve(),
  useCreateCast: () => mockCreateCast,
  useDeleteCast: () => mockDeleteCast,
  useDiscardDraftCast: () => mockDiscardDraftCast,
  useFetchOpenGraphMetadata: () => ({
    getCachedOpenGraphMetadataSnapshot: () => new Map(),
  }),
  useOptimisticallyAddNewCastToThread: () =>
    mockOptimisticallyAddNewCastToThread,
  usePrefetchUserThreadCasts: () => mockPrefetchThread,
  useStoreDraftCaststorm: () => mockStoreDraftCaststorm,
  useTrackCastReaction: () => mockTrackCastReaction,
}));

jest.mock('farcaster-expo', () => ({
  useRootToast: () => ({ show: mockToastShow }),
}));

jest.mock('~/contexts/AnalyticsProvider', () => ({
  useAnalytics: () => ({ trackEvent: mockTrackEvent }),
}));

jest.mock('~/contexts/AppStoreReviewProvider', () => ({
  useAppStoreReview: () => ({ requestReview: mockRequestReview }),
}));

jest.mock('~/contexts/CastQueueProvider', () => ({
  useCastQueue: () => ({ reducer: [mockQueueState, mockDispatch] }),
}));

jest.mock('~/contexts/UserAppContextProvider', () => ({
  useUserAppContext: () => ({ regularCastByteLimit: 320 }),
}));

jest.mock('~/hooks/data/useCurrentUser', () => ({
  useCurrentUser_UNSAFE: () => ({ fid: 123 }),
}));

jest.mock('~/utils/CastUtils', () => ({
  buildApiCastUrlEmbedFromMetadata: jest.fn(),
}));

jest.mock('~/utils/ErrorUtils', () => ({
  trackError: jest.fn(),
}));

jest.mock('../dedupeEmbedReferences', () => ({
  dedupeEmbedReferences: (embeds: string[]) => embeds,
}));

jest.mock('../getDedupedEmbedsArrayFromOptimisticEmbeds', () => ({
  getDedupedEmbedsArrayFromOptimisticEmbeds: jest.fn(),
}));

jest.mock('../LocalDrafts', () => ({
  setLocalDraft: (...args: unknown[]) => mockSetLocalDraft(...args),
}));

jest.mock('../OptimisticMediaEmbedsProvider', () => ({
  getOptimisticMediaLookupKey: () => ({ lookupKey: 'lookup' }),
  useOptimisticMediaEmbeds: () => [{}],
}));

function castResponse(hash: string, username = 'alice') {
  return { result: { cast: { hash, author: { username } } } };
}

function makePayload({
  texts,
  parentCastHash,
  activeDraftId,
  quoteReactions = [],
}: {
  texts: string[];
  parentCastHash?: string;
  activeDraftId?: string;
  quoteReactions?: { castHash: string; castFid: number }[];
}) {
  return {
    params: {
      casts: texts.map((text, index) => ({
        localKey: index,
        text,
        embeds: [],
        userMentions: [],
        channelMentions: [],
        tokenMentions: [],
      })),
      activeDraftId,
      scheduledAt: undefined,
      channelKey: undefined,
      feed: undefined,
      includeReason: undefined,
      quoteReactions,
      tokenKey: undefined,
      parentCastHash,
      localDraftKey: 'draft-key',
      queueIdOverrideForEmbeds: undefined,
      onSuccess: undefined,
      onError: undefined,
    },
    queueState: { queueId: 'queue-A', status: 'in-progress' as const },
    castTarget: undefined,
  };
}

// What the errored toast does: the same params object, queued again under a new
// queueId that points its optimistic-media lookups back at the first attempt.
function retryQueueState(params: unknown) {
  return {
    params,
    queueState: { queueId: 'queue-A-retry', status: 'in-progress' as const },
    castTarget: undefined,
  };
}

function erroredMessages(): (string | undefined)[] {
  return mockDispatch.mock.calls
    .filter(([action]) => action.type === 'MarkAsErrored')
    .map(([action]) => action.errorMessage);
}

describe('useSubmitCastsInQueue: a thread that fails partway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockQueueState)) {
      delete mockQueueState[key];
    }
    mockStoreDraftCaststorm.mockResolvedValue({
      result: { draft: { draftId: 'draft-A' } },
    });
  });

  it('keeps what went out, resumes from it, and sends only the rest on retry', async () => {
    mockCreateCast
      .mockResolvedValueOnce(castResponse('0xcast1'))
      .mockRejectedValueOnce(new Error('network'));

    const payload = makePayload({
      texts: ['one', 'two', 'three'],
      parentCastHash: '0xparent',
    });
    mockQueueState['queue-A'] = payload;

    const { result } = renderHook(() => useSubmitCastsInQueue());

    await act(async () => {
      await result.current({ queueId: 'queue-A' });
    });

    // Nothing already public is deleted: a delete is visible to the network and
    // cannot un-notify the parent's author.
    expect(mockDeleteCast).not.toHaveBeenCalled();
    // The toast says what is live and what follows, in plain words.
    expect(erroredMessages()).toEqual([
      '1 of 3 already posted. The rest will go out as replies.',
    ]);
    // The queue keeps only the posts that never went out, replying to the last
    // one that did.
    expect(payload.params.casts.map((cast) => cast.text)).toEqual([
      'two',
      'three',
    ]);
    expect(payload.params.parentCastHash).toBe('0xcast1');
    expect((payload.params as { resume?: unknown }).resume).toMatchObject({
      rootCastHash: '0xcast1',
      rootParentCastHash: '0xparent',
      postedCount: 1,
      totalCount: 3,
    });
    // The recovery draft follows what is left, so reopening it cannot repost
    // what is already public.
    const lastDraftStore =
      mockStoreDraftCaststorm.mock.calls[
        mockStoreDraftCaststorm.mock.calls.length - 1
      ][0];
    expect(
      lastDraftStore.caststorm.casts.map((cast: { text: string }) => cast.text),
    ).toEqual(['two', 'three']);
    expect(lastDraftStore.caststorm.parent).toEqual({ hash: '0xcast1' });
    // The on-device copy of the whole thread goes too.
    expect(mockSetLocalDraft).toHaveBeenCalledWith(undefined, 'draft-key');
    // The reply that landed is in the thread now that publishing is over.
    expect(mockOptimisticallyAddNewCastToThread).toHaveBeenCalledWith({
      parentCastHash: '0xparent',
      cast: { hash: '0xcast1', author: { username: 'alice' } },
    });

    // Try again, exactly as the errored toast re-queues it.
    mockCreateCast
      .mockResolvedValueOnce(castResponse('0xcast2'))
      .mockResolvedValueOnce(castResponse('0xcast3', 'alice'));
    mockQueueState['queue-A-retry'] = retryQueueState(payload.params);

    await act(async () => {
      await result.current({ queueId: 'queue-A-retry' });
    });

    expect(mockCreateCast).toHaveBeenCalledTimes(4);
    expect(mockCreateCast.mock.calls[0][0].parentCastHash).toBe('0xparent');
    // The retry continues the thread instead of forking from its parent:
    // 'two' replies to the cast that went out, 'three' to 'two'.
    expect(mockCreateCast.mock.calls[2][0].castText).toBe('two');
    expect(mockCreateCast.mock.calls[2][0].parentCastHash).toBe('0xcast1');
    expect(mockCreateCast.mock.calls[3][0].castText).toBe('three');
    expect(mockCreateCast.mock.calls[3][0].parentCastHash).toBe('0xcast2');
    // The thread reads as posted: the first cast is what a success reports, so
    // a mini app hears it and the sent toast opens the thread's start.
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'MarkAsPublished',
      queueId: 'queue-A-retry',
      castAuthorUsername: 'alice',
      castHash: '0xcast1',
    });
    expect(mockDeleteCast).not.toHaveBeenCalled();
  });

  it('credits the reply and quote reactions once, not again on the retry', async () => {
    mockCreateCast
      .mockResolvedValueOnce(castResponse('0xcast1'))
      .mockRejectedValueOnce(new Error('network'));

    const payload = makePayload({
      texts: ['one', 'two'],
      parentCastHash: '0xparent',
      quoteReactions: [{ castHash: '0xquoted', castFid: 9 }],
    });
    mockQueueState['queue-A'] = payload;

    const { result } = renderHook(() => useSubmitCastsInQueue());

    await act(async () => {
      await result.current({ queueId: 'queue-A' });
    });

    expect(mockTrackCastReaction).toHaveBeenCalledTimes(2);
    // The retry must not credit them a second time.
    expect(payload.params.quoteReactions).toEqual([]);

    mockCreateCast.mockResolvedValueOnce(castResponse('0xcast2'));
    mockQueueState['queue-A-retry'] = retryQueueState(payload.params);

    await act(async () => {
      await result.current({ queueId: 'queue-A-retry' });
    });

    expect(mockTrackCastReaction).toHaveBeenCalledTimes(2);
  });

  it('a retry that fails again keeps counting from where it was', async () => {
    mockCreateCast
      .mockResolvedValueOnce(castResponse('0xcast1'))
      .mockRejectedValueOnce(new Error('network'));

    const payload = makePayload({ texts: ['one', 'two', 'three', 'four'] });
    mockQueueState['queue-A'] = payload;

    const { result } = renderHook(() => useSubmitCastsInQueue());

    await act(async () => {
      await result.current({ queueId: 'queue-A' });
    });
    expect(erroredMessages()).toEqual([
      '1 of 4 already posted. The rest will go out as replies.',
    ]);

    // The retry lands one more and fails again.
    mockCreateCast
      .mockResolvedValueOnce(castResponse('0xcast2'))
      .mockRejectedValueOnce(new Error('still offline'));
    mockQueueState['queue-A-retry'] = retryQueueState(payload.params);

    await act(async () => {
      await result.current({ queueId: 'queue-A-retry' });
    });

    expect(erroredMessages()).toEqual([
      '1 of 4 already posted. The rest will go out as replies.',
      '2 of 4 already posted. The rest will go out as replies.',
    ]);
    expect(payload.params.casts.map((cast) => cast.text)).toEqual([
      'three',
      'four',
    ]);
    expect(payload.params.parentCastHash).toBe('0xcast2');
    expect(
      (payload.params as { resume?: { postedCount: number } }).resume,
    ).toMatchObject({ rootCastHash: '0xcast1', postedCount: 2, totalCount: 4 });
  });

  it('a thread that never sent anything reports a plain failure and keeps all of it', async () => {
    mockCreateCast.mockRejectedValue(new Error('network'));

    const payload = makePayload({ texts: ['one', 'two'] });
    mockQueueState['queue-A'] = payload;

    const { result } = renderHook(() => useSubmitCastsInQueue());

    await act(async () => {
      await result.current({ queueId: 'queue-A' });
    });

    expect(erroredMessages()).toEqual(['network']);
    expect(payload.params.casts.map((cast) => cast.text)).toEqual([
      'one',
      'two',
    ]);
    expect(payload.params.parentCastHash).toBeUndefined();
    expect((payload.params as { resume?: unknown }).resume).toBeUndefined();
    expect(mockSetLocalDraft).not.toHaveBeenCalled();
  });

  it('discards the opened draft once part of the thread is public', async () => {
    mockStoreDraftCaststorm
      .mockResolvedValueOnce({ result: { draft: { draftId: 'other-draft' } } })
      .mockResolvedValueOnce({ result: { draft: { draftId: 'other-draft' } } });
    mockCreateCast
      .mockResolvedValueOnce(castResponse('0xcast1'))
      .mockRejectedValueOnce(new Error('network'));

    const payload = makePayload({
      texts: ['one', 'two'],
      activeDraftId: 'opened-draft',
    });
    // The draft this publish was opened from still holds the whole thread.
    mockQueueState['queue-A'] = payload;

    const { result } = renderHook(() => useSubmitCastsInQueue());

    await act(async () => {
      await result.current({ queueId: 'queue-A' });
    });

    expect(mockDiscardDraftCast).toHaveBeenCalledWith({
      draftId: 'opened-draft',
      castChannelKey: undefined,
    });
  });
});
