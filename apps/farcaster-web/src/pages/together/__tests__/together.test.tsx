// @vitest-environment jsdom

/**
 * Together, pinned where a browser probe cannot pin it.
 *
 * What matters here is not that the screen looks right (the probe measures
 * that) but that the boring, easy-to-break contract holds: the session token
 * travels as a bearer and nowhere else, a dead service becomes a sentence
 * rather than a stack trace, a spent invite says so, and moving a card is one
 * PATCH with the version it read.
 */

import { HelmetProvider } from '@dr.pogodin/react-helmet';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import {
  togetherBaseUrl,
  TogetherError,
  togetherRequest,
  togetherStreamUrl,
} from '~/lib/together';
// A test renders the page component itself: the lazy wrapper in ~/lazy/pages
// exists to keep the production bundle split, and awaiting it here would test
// the wrapper, not the surface.
// eslint-disable-next-line no-restricted-imports
import { TogetherJoinPage } from '~/pages/together/TogetherJoinPage';
// eslint-disable-next-line no-restricted-imports
import { TogetherPage } from '~/pages/together/TogetherPage';

/**
 * The pages read and write the stored session through `storageUtils`, which is
 * localforage: real in a browser, "no available storage method" in jsdom. The
 * tests want the value, not the driver, so this stands in for it.
 */
const stored = vi.hoisted(() => new Map<string, unknown>());

vi.mock('~/utils/storageUtils', () => ({
  getItem: async ({ key, fallback }: { key: string; fallback: unknown }) =>
    stored.has(key) ? stored.get(key) : fallback,
  setItem: async ({ key, value }: { key: string; value: unknown }) => {
    stored.set(key, value);
  },
  deleteItem: async (key: string) => {
    stored.delete(key);
  },
}));

vi.mock('~/lazy/components', () => ({
  LoginQRCode: ({ url }: { url: string }) => <div data-testid="qr">{url}</div>,
}));

/**
 * The brand-ground hook paints the document and dispatches a StorageEvent with
 * a real Storage. jsdom cannot construct one from the fake storage the other
 * Fiddy tests install, so it is stubbed here; what it does to the document is
 * measured in the browser probe instead, which is the only place it matters.
 */
vi.mock('~/components/fiddy/useFiddyBrand', () => ({
  useFiddyBrandGround: () => undefined,
}));

const SESSION = {
  token: 'session-token',
  fid: 42,
  username: 'elena',
  pfp_url: null,
  space_id: 'space-1',
};

const SPACE = {
  id: 'space-1',
  name: 'Fiddy launch',
  channel: 'fiddy',
  owner_fid: 42,
  about: '',
  role: 'owner',
};

const MEMBER = {
  space_id: 'space-1',
  fid: 42,
  username: 'elena',
  pfp_url: null,
  role: 'owner',
  joined_at: 1,
};

const CARD = {
  id: 'card-1',
  space_id: 'space-1',
  title: 'Ship the Together surface',
  note: '',
  status: 'todo',
  assignee_fid: null,
  created_by_fid: 42,
  version: 1,
  created_at: 1,
  updated_at: 1,
};

/** Records what the page asked for, so the assertions can read the wire. */
type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * The real page shell: `Page` renders `PageMeta`, which is a Helmet — so a
 * render outside HelmetProvider throws, exactly as the app would.
 */
const Shell = ({
  children,
  entries,
}: {
  children: React.ReactNode;
  entries: string[];
}) => (
  <HelmetProvider>
    <MemoryRouter initialEntries={entries}>{children}</MemoryRouter>
  </HelmetProvider>
);

let calls: Call[] = [];

const respond = (
  routes: (url: string, call: Call) => Response | undefined,
): void => {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const answer = routes(url, call);

      if (!answer) {
        throw new TypeError('Failed to fetch');
      }

      return answer;
    },
  );
};

const statePayload = (cards: (typeof CARD)[] = [CARD]) => ({
  space: SPACE,
  me: { fid: 42, username: 'elena', pfp_url: null, role: 'owner' },
  members: [MEMBER],
  cards,
  cursor: 5,
  pending_announcements: 0,
});

beforeEach(() => {
  // jsdom in this repo exposes no window.localStorage, and Fiddy's surfaces
  // read it (the brand ground pins the client dark). Same helper the Fiddy
  // setup tests use.
  installFakeStorage();
  stored.clear();
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Together client', () => {
  it('reads the service origin from the build, and falls back to loopback', () => {
    // The fallback is what a self-hosted alpha needs: open the app and the
    // space service is on this machine, not on somebody's domain.
    expect(togetherBaseUrl()).toContain('127.0.0.1:8766');
  });

  it('sends the session token as a bearer header and nothing else', async () => {
    respond(() => json(200, { ok: true }));
    await togetherRequest('/state', { token: 'session-token' });
    expect(calls[0].url).toContain('/spaces/state');
    expect(calls[0].headers.authorization).toBe('Bearer session-token');
    expect(JSON.stringify(calls[0])).not.toContain('session-token&');
  });

  it('turns an unreachable service into a sentence, not a stack trace', async () => {
    respond(() => undefined);
    await expect(togetherRequest('/state')).rejects.toThrow(TogetherError);
    await expect(togetherRequest('/state')).rejects.toThrow(
      /could not reach the space service/i,
    );
  });

  it('passes on what the service said when it refuses', async () => {
    respond(() =>
      json(409, { detail: 'Someone else moved this card — refresh' }),
    );
    await expect(togetherRequest('/cards/card-1', {})).rejects.toThrow(
      'Someone else moved this card — refresh',
    );
  });
});

describe('Together — the front door', () => {
  it('offers the Farcaster door and says what it will never hold', async () => {
    respond(() => json(200, { fid: 42, space_id: null, spaces: [] }));
    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );

    expect(
      await screen.findByRole('button', { name: 'Sign in with Farcaster' }),
    ).toBeTruthy();
    expect(screen.getByText(/never keys, never seed phrases/i)).toBeTruthy();
    expect(screen.getByText(/one project, one board/i)).toBeTruthy();
  });

  it('shows the QR the service minted when someone starts signing in', async () => {
    respond((url) =>
      url.endsWith('/spaces/auth')
        ? json(200, {
            request_id: 'req-1',
            url: 'https://farcaster.xyz/~/siwf?channel=1',
            expires_at: 1,
            verifier: 'relay',
          })
        : json(200, { state: 'pending' }),
    );

    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in with Farcaster' }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('qr').textContent).toContain(
        'https://farcaster.xyz/~/siwf?channel=1',
      ),
    );
    expect(calls[0].body).toContain('"domain"');
  });
});

describe('Together — the board', () => {
  const renderBoard = async () => {
    stored.set('together-space-session', SESSION);
    respond((url, _call) => {
      if (url.includes('/spaces/mine')) {
        return json(200, { fid: 42, space_id: 'space-1', spaces: [SPACE] });
      }

      if (url.includes('/spaces/state')) {
        return json(200, statePayload());
      }

      if (url.includes('/spaces/events')) {
        return json(200, { cursor: 5, latest: 5, events: [] });
      }

      if (url.includes('/spaces/cards/')) {
        return json(200, { ...CARD, status: 'doing', version: 2 });
      }

      return json(200, {});
    });

    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );
    await screen.findByText('Ship the Together surface');
  };

  it('renders the shared board with every member on it', async () => {
    await renderBoard();
    expect(screen.getByText('Fiddy launch')).toBeTruthy();
    expect(screen.getByText('#fiddy')).toBeTruthy();
    expect(screen.getByText(/@elena · owner/)).toBeTruthy();
    expect(screen.getByText('To do')).toBeTruthy();
    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(
      screen.getByText(/each card is worked by whoever picks it up/i),
    ).toBeTruthy();
  });

  it('moves a card with the version it read, so two people cannot clobber each other', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'PATCH' &&
            call.url.includes('/spaces/cards/card-1'),
        ),
      ).toBe(true),
    );
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({
      status: 'doing',
      version: 1,
    });
    expect(patch?.headers.authorization).toBe('Bearer session-token');
  });
});

describe('Together — the other end of an invite link', () => {
  const renderJoin = (token = 'invite-token') =>
    render(
      <Shell entries={[`/~/together/join/${token}`]}>
        <Routes>
          <Route
            element={<TogetherJoinPage />}
            path="/~/together/join/:token"
          />
          <Route element={<TogetherPage />} path="/~/together" />
        </Routes>
      </Shell>,
    );

  it('says whose space it is before asking for anything', async () => {
    respond(() =>
      json(200, {
        space: { id: 'space-1', name: 'Fiddy launch', channel: 'fiddy' },
        invited_by_fid: 42,
        invited_by_username: 'elena',
        expires_at: 9,
        uses_left: 1,
      }),
    );

    renderJoin();
    await screen.findByText('Fiddy launch');
    expect(screen.getByText(/@elena invited you/)).toBeTruthy();
    expect(screen.getByText(/1 use left/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Sign in with Farcaster and join/ }),
    ).toBeTruthy();
    expect(screen.getByText(/no email, no password, no keys/i)).toBeTruthy();
  });

  it('reads a spent link as a sentence', async () => {
    respond(() => json(410, { detail: 'This invite link has expired' }));
    renderJoin('spent');
    expect(
      await screen.findByText('That invite is spent or expired.'),
    ).toBeTruthy();
  });

  it('joins with the session the handshake produced', async () => {
    respond((url, _call) => {
      if (url.includes('/spaces/invites/invite-token/join')) {
        return json(200, {
          space: SPACE,
          already_member: false,
          session_token: 'session-token',
        });
      }

      if (url.includes('/spaces/invites/')) {
        return json(200, {
          space: { id: 'space-1', name: 'Fiddy launch', channel: 'fiddy' },
          invited_by_fid: 42,
          invited_by_username: 'elena',
          expires_at: 9,
          uses_left: 1,
        });
      }

      if (url.endsWith('/spaces/auth')) {
        return json(200, {
          request_id: 'req-1',
          url: 'https://farcaster.xyz/x',
        });
      }

      if (url.includes('/spaces/auth/')) {
        return json(200, {
          state: 'completed',
          session_token: 'session-token',
          fid: 42,
          username: 'elena',
          pfp_url: null,
          space_id: 'space-1',
        });
      }

      return json(200, {});
    });

    // A stored session skips the QR entirely: somebody already signed in on
    // this device, and asking them to scan twice would be a bug.
    stored.set('together-space-session', SESSION);

    renderJoin();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Sign in with Farcaster and join/,
      }),
    );

    expect(await screen.findByText('You joined the space.')).toBeTruthy();
    const join = calls.find((call) => call.url.includes('/join'));
    expect(join?.headers.authorization).toBe('Bearer session-token');
    expect(screen.getByRole('link', { name: 'Open the board' })).toBeTruthy();
  });
});

describe('Together — talking on a card', () => {
  const MEMBER_FROM_ELSEWHERE = {
    space_id: 'space-1',
    fid: 43,
    username: 'marcus',
    pfp_url: null,
    role: 'member',
    joined_at: 2,
  };

  const SAID = {
    id: 'm-1',
    space_id: 'space-1',
    card_id: 'card-1',
    author_fid: 43,
    author_name: 'marcus',
    body: 'the invite link is live',
    created_at: 2,
  };

  /**
   * The board as the OTHER member's actions leave it: one unread thing on the
   * card, one comment in its thread, and somebody typing.
   */
  const renderCardWith = ({
    unread = { 'card-1': 1 },
    messages = [SAID],
    typing = [] as { fid: number; username: string | null; expires: number }[],
  } = {}) => {
    let cardRead = false;

    stored.set('together-space-session', SESSION);
    respond((url, call) => {
      if (url.includes('/spaces/mine')) {
        return json(200, { fid: 42, space_id: 'space-1', spaces: [SPACE] });
      }

      if (url.includes('/spaces/state')) {
        // Typed, not inferred: `{} | { 'card-1': number }` widens the values to
        // `unknown` and `Object.values(...).reduce` then fails the typecheck
        // gate CI runs. Main carried that error; this line is the fix.
        const counts: Record<string, number> = cardRead ? {} : unread;
        return json(200, {
          ...statePayload(),
          members: [MEMBER, MEMBER_FROM_ELSEWHERE],
          unread: {
            cards: counts,
            total: Object.values(counts).reduce((a, b) => a + b, 0),
          },
        });
      }

      if (url.includes('/spaces/events')) {
        return json(200, { cursor: 5, latest: 5, events: [] });
      }

      // Opening a card: the marker is cleared on the service, so the next state
      // read comes back without it.
      if (url.includes('/read')) {
        cardRead = true;
        return json(200, { card_id: 'card-1', seen_seq: 5, unread: 0 });
      }

      if (url.includes('/typing')) {
        return json(200, {
          card_id: 'card-1',
          typing: JSON.parse(call.body ?? '{}').active ? [] : [],
        });
      }

      if (url.includes('/messages')) {
        return json(200, SAID);
      }

      if (url.includes('/thread')) {
        return json(200, {
          card: { id: 'card-1', title: CARD.title, status: 'todo', version: 1 },
          messages,
          typing,
          unread: 0,
          cursor: 5,
        });
      }

      if (url.includes('/spaces/cards/')) {
        return json(200, { ...CARD, status: 'doing', version: 2 });
      }

      return json(200, {});
    });

    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );
  };

  it('marks the card that changed, shows the comment with its author, and clears on open', async () => {
    renderCardWith();
    await screen.findByText('Ship the Together surface');

    // The board says something happened here, without opening anything.
    const badge = await screen.findByText('1 new');
    expect(badge).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Comments/ }));

    // The comment is on the card, under the handle its author signed in with.
    const thread = await screen.findByTestId('thread-card-1');
    expect(thread.textContent).toContain('the invite link is live');
    expect(thread.textContent).toContain('@marcus');

    // Opening it is what cleared the marker — and the request that did it went
    // out as this member's own session.
    await waitFor(() =>
      expect(screen.queryByText('1 new')).toBeNull(),
    );
    const read = calls.find((call) => call.url.includes('/read'));
    expect(read?.method).toBe('POST');
    expect(read?.headers.authorization).toBe('Bearer session-token');
  });

  it('shows that the other member is typing, and stops showing it when they do', async () => {
    const typer = [{ fid: 43, username: 'marcus', expires: 9 }];
    let typingNow = false;

    // The thread's own poll is what carries presence, so the assertions wait for
    // a later tick instead of trusting the first paint.
    stored.set('together-space-session', SESSION);
    respond((url) => {
      if (url.includes('/spaces/mine')) {
        return json(200, { fid: 42, space_id: 'space-1', spaces: [SPACE] });
      }

      if (url.includes('/spaces/state')) {
        return json(200, {
          ...statePayload(),
          members: [MEMBER, MEMBER_FROM_ELSEWHERE],
          unread: { cards: {}, total: 0 },
        });
      }

      if (url.includes('/spaces/events')) {
        return json(200, { cursor: 5, latest: 5, events: [] });
      }

      if (url.includes('/read')) {
        return json(200, { card_id: 'card-1', seen_seq: 5, unread: 0 });
      }

      if (url.includes('/thread')) {
        return json(200, {
          card: { id: 'card-1', title: CARD.title, status: 'todo', version: 1 },
          messages: [SAID],
          typing: typingNow ? typer : [],
          unread: 0,
          cursor: 5,
        });
      }

      if (url.includes('/spaces/cards/')) {
        return json(200, { ...CARD, status: 'doing', version: 2 });
      }

      return json(200, {});
    });

    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );
    await screen.findByText('Ship the Together surface');
    fireEvent.click(screen.getByRole('button', { name: /Comments/ }));
    await screen.findByText(/the invite link is live/);
    expect(screen.queryByTestId('typing')).toBeNull();

    // They start typing: the next poll brings the indicator over.
    typingNow = true;
    expect(
      await screen.findByText(/marcus is typing/, undefined, { timeout: 6000 }),
    ).toBeTruthy();

    // They stop, or their heartbeat lapses: it clears on its own.
    typingNow = false;
    await waitFor(() => expect(screen.queryByTestId('typing')).toBeNull(), {
      timeout: 6000,
    });
  });

  it('announces that you are typing while there is unsent text, and stops after sending', async () => {
    renderCardWith({ messages: [] });
    await screen.findByText('Ship the Together surface');
    fireEvent.click(screen.getByRole('button', { name: /Comments/ }));

    const composer = await screen.findByPlaceholderText(
      'Say something on this card',
    );
    fireEvent.change(composer, { target: { value: 'on it' } });

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes('/typing') &&
            call.body === JSON.stringify({ active: true }),
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes('/messages') &&
            call.body === JSON.stringify({ body: 'on it' }),
        ),
      ).toBe(true),
    );
    // The heartbeat stops the moment the text becomes the message.
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes('/typing') &&
            call.body === JSON.stringify({ active: false }),
        ),
      ).toBe(true),
    );
  });
});

class FakeSocket {
  static opened: FakeSocket[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }

  /** The service's half of the handshake: accepted, then subscribed. */
  open(cursor = 5) {
    this.onopen?.();
    this.onmessage?.({
      data: JSON.stringify({
        type: 'ready',
        space_id: 'space-1',
        fid: 42,
        cursor,
      }),
    });
  }

  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The socket dies: the service went away, or the network did. */
  die() {
    this.onclose?.();
  }

  close() {
    this.die();
  }
}

describe('Together — the live board', () => {
  /** The socket the page opened. It is created in an effect: wait for it. */
  const liveSocket = async (): Promise<FakeSocket> => {
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0));
    return FakeSocket.opened[FakeSocket.opened.length - 1];
  };

  /** A board whose verdict on the card can change mid-test, as a push would. */
  const bootBoard = async () => {
    stored.set('together-space-session', SESSION);
    FakeSocket.opened = [];
    let status = 'todo';
    respond((url) => {
      if (url.includes('/spaces/mine')) {
        return json(200, { fid: 42, space_id: 'space-1', spaces: [SPACE] });
      }

      if (url.includes('/spaces/state')) {
        return json(200, statePayload([{ ...CARD, status } as typeof CARD]));
      }

      if (url.includes('/spaces/events')) {
        return json(200, { cursor: 5, latest: 5, events: [] });
      }

      return json(200, {});
    });

    render(
      <Shell entries={['/~/together']}>
        <TogetherPage />
      </Shell>,
    );
    await screen.findByText('Ship the Together surface');
    return { moved: () => (status = 'done') };
  };

  it('asks the service on the socket the build points at, with the session it has', () => {
    // The local alpha's default origin, and the same token REST uses. A browser
    // cannot set a header on a websocket handshake, so it travels in the query.
    expect(togetherStreamUrl('session-token')).toBe(
      'ws://127.0.0.1:8766/spaces/stream?token=session-token',
    );
  });

  it('re-reads the board when a frame arrives, and shows the change', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const board = await bootBoard();
    const socket = await liveSocket();
    expect(FakeSocket.opened).toHaveLength(1);
    expect(socket.url).toContain('/spaces/stream?token=session-token');

    await act(async () => socket.open());
    expect(await screen.findByText('Live')).toBeTruthy();

    const readsBefore = calls.filter((call) =>
      call.url.includes('/spaces/state'),
    ).length;
    board.moved();
    await act(async () => {
      socket.push({
        type: 'event',
        space_id: 'space-1',
        seq: 6,
        kind: 'card.moved',
        actor_fid: 7,
        actor_name: 'marcus',
        created_at: 1,
        card_id: 'card-1',
        title: 'Ship the Together surface',
        status: 'done',
      });
    });

    // The frame carried "something changed"; the board came from the service.
    expect(await screen.findByText('Cast it to the channel')).toBeTruthy();
    expect(
      calls.filter((call) => call.url.includes('/spaces/state')).length,
    ).toBeGreaterThan(readsBefore);
    expect(screen.getByText(/@marcus/)).toBeTruthy();
  });

  it('says it is disconnected, then falls back to asking', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    await bootBoard();
    const socket = await liveSocket();
    await act(async () => socket.open());
    expect(await screen.findByText('Live')).toBeTruthy();

    // While the socket is carrying the board, the fallback stays quiet.
    calls = [];
    await act(async () => socket.die());
    expect(await screen.findByText('Disconnected — reconnecting')).toBeTruthy();
    expect(calls.some((call) => call.url.includes('/spaces/events'))).toBe(false);

    // ...and starts asking, so a client without a socket still converges.
    await waitFor(
      () =>
        expect(
          calls.some((call) => call.url.includes('/spaces/events')),
        ).toBe(true),
      { timeout: 6000 },
    );
    // Retrying is visible too: the page keeps trying to get its socket back.
    expect(FakeSocket.opened.length).toBeGreaterThan(1);
  }, 15000);

  it('never asks at all when the page was opened with polling switched off', async () => {
    window.history.replaceState({}, '', '/~/together?together-poll=off');
    vi.stubGlobal('WebSocket', FakeSocket);
    await bootBoard();
    const socket = await liveSocket();
    await act(async () => socket.open());
    expect(await screen.findByText('Live')).toBeTruthy();

    await act(async () => socket.die());
    expect(await screen.findByText('Disconnected — reconnecting')).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
    });

    expect(calls.some((call) => call.url.includes('/spaces/events'))).toBe(false);
    expect(FakeSocket.opened.length).toBeGreaterThan(1);
  }, 15000);
});
