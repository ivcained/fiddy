// @vitest-environment jsdom
/**
 * The composer's over-limit assistant, measured where its decisions are made.
 *
 * Every check is one honesty rule: the offer exists only when a chat-able
 * agent really answers; a reply is applied only when it is usable (fits the
 * byte limit, splits into a real thread); and every refusal is one sentence
 * that says the user's text is unchanged. Nothing here applies anything —
 * applying is the composer's job, asked in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the browser store (the same shape the schedules
// tests use): what is under test is the resolution and validation logic, not
// localforage.
const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: async ({ key, fallback }: { key: string; fallback: unknown }) =>
    store.has(key) ? store.get(key) : fallback,
  setItem: async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  },
  deleteItem: async (key: string) => {
    store.delete(key);
  },
}));

import {
  COMPOSER_ASSIST_CACHE_MS,
  ComposerAssistError,
  resetComposerAssistCache,
  resolveComposerAgent,
  SPLIT_DELIMITER,
  splitCastText,
  tightenCastText,
} from '~/lib/composerAgentAssist';

const SESSION_KEY = 'fiddy.agent.session';
const SESSION = { baseUrl: 'https://fiddy.fun', token: 'owner-session-token' };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const runningAgent = () =>
  jsonResponse({ ok: true, data: [{ id: 'inst-1', status: 'running' }] });

const chatReply = (text: string) =>
  jsonResponse({ ok: true, result: { output_text: text } });

const pairSession = () => {
  store.set(SESSION_KEY, SESSION);
};

const longText = 'word '.repeat(300).trim();

beforeEach(() => {
  store.clear();
  resetComposerAssistCache();
  pairSession();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetComposerAssistCache();
});

describe('resolving the agent behind the offer', () => {
  it('answers the paired session and its first chat-able agent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(runningAgent());

    const assist = await resolveComposerAgent(fetchImpl);

    expect(assist).toEqual({ session: SESSION, agentId: 'inst-1' });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://fiddy.fun/api/agents/instances');
  });

  it('a stopped or sleeping agent is no offer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: [{ id: 'inst-1', status: 'stopped' }],
      }),
    );

    expect(await resolveComposerAgent(fetchImpl)).toBeNull();
  });

  it('a service that does not answer is no offer, not an error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('refused'));

    expect(await resolveComposerAgent(fetchImpl)).toBeNull();
  });

  it('a browser with no session is no offer', async () => {
    store.delete(SESSION_KEY);
    const fetchImpl = vi.fn();

    expect(await resolveComposerAgent(fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('remembers the answer, so the over-limit moment does not re-ask', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(runningAgent());

    await resolveComposerAgent(fetchImpl);
    await resolveComposerAgent(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a stale answer expires', async () => {
    const now = vi.spyOn(Date, 'now');
    const fetchImpl = vi.fn().mockResolvedValue(runningAgent());

    await resolveComposerAgent(fetchImpl);
    now.mockReturnValue(Date.now() + COMPOSER_ASSIST_CACHE_MS + 1);
    await resolveComposerAgent(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('tighten', () => {
  const assist = { session: SESSION, agentId: 'inst-1' };

  it('returns a reply that fits, unwrapped from a code fence', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(chatReply('```\nShort enough.\n```'));

    const text = await tightenCastText({
      assist,
      text: longText,
      byteLimit: 1024,
      fetchImpl,
    });

    expect(text).toBe('Short enough.');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { message: string };
    expect(body.message).toContain(longText);
  });

  it('a reply still over the limit is refused, text unchanged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatReply(longText));

    await expect(
      tightenCastText({ assist, text: longText, byteLimit: 1024, fetchImpl }),
    ).rejects.toMatchObject({
      name: 'ComposerAssistError',
      ownerSentence: /still too long/i,
    });
  });

  it('an empty reply is refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatReply('   '));

    await expect(
      tightenCastText({ assist, text: longText, byteLimit: 1024, fetchImpl }),
    ).rejects.toMatchObject({ ownerSentence: /came back with nothing/i });
  });

  it('a service that refuses is one sentence, never a raw error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false }, 500));

    await expect(
      tightenCastText({ assist, text: longText, byteLimit: 1024, fetchImpl }),
    ).rejects.toBeInstanceOf(ComposerAssistError);
  });
});

describe('split', () => {
  const assist = { session: SESSION, agentId: 'inst-1' };

  it('returns the parts the model separated, trimmed and cleaned', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        chatReply(
          `One.\n${SPLIT_DELIMITER}\nTwo.\n${SPLIT_DELIMITER}\n\nThree.`,
        ),
      );

    const parts = await splitCastText({
      assist,
      text: longText,
      byteLimit: 1024,
      maxParts: 5,
      fetchImpl,
    });

    expect(parts).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('a reply with no separator is refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatReply('just one blob'));

    await expect(
      splitCastText({
        assist,
        text: longText,
        byteLimit: 1024,
        maxParts: 5,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ ownerSentence: /could not find good breaks/i });
  });

  it('more parts than the composer can queue is refused', async () => {
    const reply = ['a', 'b', 'c', 'd'].join(`\n${SPLIT_DELIMITER}\n`);
    const fetchImpl = vi.fn().mockResolvedValue(chatReply(reply));

    await expect(
      splitCastText({
        assist,
        text: longText,
        byteLimit: 1024,
        maxParts: 3,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ ownerSentence: /thread here is 3/i });
  });

  it('a part over the byte limit is refused', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(chatReply(`short\n${SPLIT_DELIMITER}\n${longText}`));

    await expect(
      splitCastText({
        assist,
        text: longText,
        byteLimit: 1024,
        maxParts: 3,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ ownerSentence: /too long for a cast/i });
  });
});
