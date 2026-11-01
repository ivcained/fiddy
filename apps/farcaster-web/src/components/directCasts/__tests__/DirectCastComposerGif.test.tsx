// @vitest-environment jsdom

/**
 * The direct cast composer's GIF path: a picked GIF waits as the preview
 * modal's thumbnail and only joins the message as its `.gif` URL on send —
 * no upload, ever. The picker popover itself is stubbed (its own surface is
 * covered by the search-state tests and the browser probe); what is measured
 * here is the DC composer's half of the bargain.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { EditorState } from 'draft-js';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GifSearchResult } from '~/components/composer/gifs/gifSearch';

const GIF: GifSearchResult = {
  url: 'https://media.tenor.com/x.webp',
  preview: 'https://media.tenor.com/tiny-x.webp',
  w: 480,
  h: 360,
  title: 'a dancing test gif',
  cast: 'https://media.tenor.com/medium-x.gif',
};

const sendDirectCast = vi.fn();
const uploadImageToCloudflare = vi.fn();

vi.mock('farcaster-client-hooks', async () => {
  const actual = await vi.importActual('farcaster-client-hooks');
  return {
    ...actual,
    useSendDirectCast: () => sendDirectCast,
    useTrackEvent: () => ({ trackEvent: vi.fn() }),
  };
});

vi.mock('~/contexts/AnalyticsProvider', () => ({
  useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock('~/contexts/DirectCastsDraftsProvider', () => ({
  useDirectCastsDrafts: () => ({
    getExistingDraft: () => undefined,
    discardDraft: vi.fn(),
    saveDraft: vi.fn(),
  }),
}));

vi.mock('~/contexts/GlobalKeyPressProvider', () => ({
  useGlobalKeyPress: () => ({
    addKeyPressListener: () => () => {},
  }),
}));

vi.mock('~/hooks/data/useCurrentUser', () => ({
  useCurrentUser: () => ({
    fid: 1,
    username: 'sender',
    displayName: 'Sender',
    pfp: 'https://example.com/p.png',
  }),
}));

vi.mock('~/hooks/data/useUploadCloudflareImage', () => ({
  useUploadCloudflareImage: () => uploadImageToCloudflare,
}));

vi.mock('~/hooks/navigation/useNavigateToDirectCastsInbox', () => ({
  useNavigateToDirectCastsInbox: () => vi.fn(),
}));

vi.mock('~/hooks/navigation/useSearchParams', () => ({
  useSearchParams: () => ({}),
}));

// The embed-previews row crawls link metadata over the network; the GIF path
// never touches it.
vi.mock('~/components/directCasts/DirectCastComposerEmbedPreviews', () => ({
  DirectCastsComposerEmbedPreviews: () => null,
}));

vi.mock(
  '~/components/composer/plugins/DirectCastsMentionsComposerPlugin',
  () => ({
    useDirectCastsMentionsComposerPlugin: () => ({
      isOpen: false,
      plugin: {},
      renderPlugin: () => null,
    }),
  }),
);

vi.mock(
  '~/components/composer/plugins/DirectCastsLinkifyComposerPlugin',
  () => ({
    useDirectCastsLinkifyComposerPlugin: () => ({
      plugin: {},
      debouncedSetOpenGraphLink: vi.fn(),
      shouldCheckMetadata: { current: false },
    }),
  }),
);

// The stub stands in for the popover on both sides of the door: this test is
// about the DC composer, not the picker's chunk loading.
vi.mock('~/components/composer/pickers/GifComposerPicker', () => ({
  GifComposerPicker: ({
    onGifPick,
  }: {
    onGifPick: (gif: GifSearchResult) => void;
  }) => (
    <button type="button" onClick={() => onGifPick(GIF)}>
      Pick test GIF
    </button>
  ),
}));

import { DirectCastComposer } from '~/components/directCasts/DirectCastComposer';
import { modalRootId } from '~/constants/modals';

// The image preview Modal portals to the app's modal root; give jsdom one.
const modalRoot = document.createElement('div');
modalRoot.id = modalRootId;
document.body.appendChild(modalRoot);

const conversation = {
  conversationId: 'conv-1',
  viewerContext: { category: 'default' },
  participants: [{ fid: 2 }],
} as never;

const renderComposer = () => {
  const setEditorState = vi.fn();
  render(
    <DirectCastComposer
      conversation={conversation}
      replyTo={undefined}
      setReplyTo={vi.fn()}
      onNewDirectCast={vi.fn()}
      composerRef={React.createRef()}
      editorState={EditorState.createEmpty()}
      setEditorState={setEditorState}
      setOptimisticMessage={vi.fn()}
    />,
  );
  return { setEditorState };
};

describe('DirectCastComposer GIF staging', () => {
  beforeEach(() => {
    sendDirectCast.mockReset();
    sendDirectCast.mockResolvedValue({ error: undefined });
    uploadImageToCloudflare.mockReset();
  });

  it('stages a picked GIF as the preview modal thumbnail and sends its .gif URL with no upload', async () => {
    renderComposer();

    fireEvent.click(screen.getByText('Pick test GIF'));

    // staged: the preview modal shows the picker's own preview image
    const staged = await screen.findByRole('img');
    expect(staged.getAttribute('src')).toBe(GIF.preview);

    // send from the modal (the portal's own buttons: close, then the paper
    // plane — the composer's own send is outside the modal root)
    const modalButtons = within(modalRoot).getAllByRole('button');
    fireEvent.click(modalButtons[modalButtons.length - 1]);

    await vi.waitFor(() => expect(sendDirectCast).toHaveBeenCalledTimes(1));
    const [{ data }] = sendDirectCast.mock.calls[0];
    // the message text IS the gif URL (quilcast's pattern: it joins on send)
    expect(data.message).toBe(GIF.cast);
    // and the medias metadata is what the search answered with
    expect(data.optimisticMetadata).toEqual({
      medias: [
        {
          staticRaster: GIF.cast,
          height: GIF.h,
          width: GIF.w,
          version: '2',
        },
      ],
    });
    expect(data.type).toBe('text');
    // never uploaded
    expect(uploadImageToCloudflare).not.toHaveBeenCalled();
  });

  it('appends the message after the GIF URL, like an uploaded photo does', async () => {
    renderComposer();

    fireEvent.click(screen.getByText('Pick test GIF'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'look at this' } });

    const modalButtons = within(modalRoot).getAllByRole('button');
    fireEvent.click(modalButtons[modalButtons.length - 1]);

    await vi.waitFor(() => expect(sendDirectCast).toHaveBeenCalledTimes(1));
    const [{ data }] = sendDirectCast.mock.calls[0];
    expect(data.message).toBe(`${GIF.cast} look at this`);
  });
});
