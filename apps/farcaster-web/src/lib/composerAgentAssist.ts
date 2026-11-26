/**
 * The composer's over-limit assistant.
 *
 * WHY THIS EXISTS
 * A cast has a hard byte limit, and the composer used to be a dead end past
 * it: a red negative number and a button that would not press. The text just
 * sat there. Quilcast turned that moment into an offer ("make it an article");
 * Fiddy is the agent client, so the same moment can offer what an agent can
 * actually do: tighten the text into one cast, or split it into a thread the
 * composer already knows how to queue.
 *
 * The interaction shape (an inline offer row gated to top-level casts, an
 * ask-before-replace that never uses a native dialog, a short guard so the
 * click that opened the question cannot answer it) is ported from
 * backmeupplz/quilcast 0.115.0 (MIT) — the code here is Fiddy's own.
 *
 * WHERE THE ANSWERS COME FROM
 * The same agent surface `/~/agent` chats through: the owner's paired agent
 * service session (`~/lib/agentService`), one message per action. The browser
 * never holds a model key, never names the provider, and every reply is
 * *validated* before it is allowed near the composer — a tightened text that
 * is still over the limit, or a "split" that is not a usable thread, is
 * refused with a sentence that says the user's text is unchanged.
 *
 * WHAT THIS MODULE MUST NEVER DO
 * Invent an answer, apply one, or touch the user's text. It resolves the
 * agent, asks, checks, and either returns usable text or throws one honest
 * sentence. Applying (or not applying) the result is the composer's decision,
 * asked in place — never a native `confirm()`, which shows nothing inside the
 * app shell.
 */

import {
  type AgentServiceSession,
  chatWithAgent,
  listAgents,
  loadAgentSession,
} from '~/lib/agentService';

/** The agent the composer can ask, once one has been found. */
export interface ComposerAssist {
  session: AgentServiceSession;
  agentId: string;
}

/** One error, one sentence the owner can read. The text is never changed. */
export class ComposerAssistError extends Error {
  constructor(public ownerSentence: string) {
    super(ownerSentence);
    this.name = 'ComposerAssistError';
  }
}

/**
 * How long a resolved (or refused) agent is remembered. The offer appears on
 * the over-limit moment, which can happen on every keystroke past the limit;
 * the answer must not be re-asked each time.
 */
export const COMPOSER_ASSIST_CACHE_MS = 60_000;

/** The line the model is told to put between split parts. */
export const SPLIT_DELIMITER = '%%%';

let cache: { assist: ComposerAssist | null; at: number } | null = null;

/** Forget the cached answer. Tests use this; a new session makes it stale. */
export const resetComposerAssistCache = (): void => {
  cache = null;
};

/** Statuses an agent can chat in. A stopped or sleeping agent is no offer. */
const canChat = (status: string): boolean =>
  status === 'running' || status === 'starting';

/**
 * Is there an agent this composer can ask? Resolves the stored service
 * session, then asks it once for the owner's agents. No session, an
 * unreachable service, or no chat-able agent all answer `null` — the surface
 * then falls back to the plain length counter, never a dead button.
 */
export const resolveComposerAgent = async (
  fetchImpl?: typeof fetch,
): Promise<ComposerAssist | null> => {
  const now = Date.now();
  if (cache && now - cache.at < COMPOSER_ASSIST_CACHE_MS) {
    return cache.assist;
  }
  let assist: ComposerAssist | null = null;
  try {
    const session = await loadAgentSession();
    if (session) {
      const agents = await listAgents(session, fetchImpl);
      const agent = agents.find(({ status }) => canChat(status));
      if (agent) {
        assist = { session, agentId: agent.id };
      }
    }
  } catch {
    // A service that does not answer is not an offer; it is also not an error
    // the person composing can act on. The counter stays the whole answer.
    assist = null;
  }
  cache = { assist, at: now };
  return assist;
};

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** A model that wraps its answer in a code fence still gets read. */
const stripFences = (reply: string): string =>
  reply
    .trim()
    .replace(/^```[^\n]*\n/, '')
    .replace(/\n```$/, '')
    .trim();

const UNREACHABLE_SENTENCE =
  'Fiddy could not be reached just now. Your text is unchanged.';

/**
 * One call: a shorter version of `text` that fits a single cast. The reply is
 * only accepted when it is non-empty and within the byte limit — anything
 * else is refused, because showing a "shorter" text that still cannot send
 * would rebuild the dead end this exists to remove.
 */
export const tightenCastText = async ({
  assist,
  text,
  byteLimit,
  fetchImpl,
}: {
  assist: ComposerAssist;
  text: string;
  byteLimit: number;
  fetchImpl?: typeof fetch;
}): Promise<string> => {
  const prompt = [
    'The text below is too long for a Farcaster cast.',
    `Rewrite it so it is at most ${byteLimit} UTF-8 bytes long, keeping its meaning and the author's voice.`,
    'Keep the original language. Reply with ONLY the rewritten text — no quotes, no commentary.',
    '',
    text,
  ].join('\n');

  let reply: string;
  try {
    reply = await chatWithAgent(
      assist.session,
      assist.agentId,
      prompt,
      fetchImpl,
    );
  } catch {
    throw new ComposerAssistError(UNREACHABLE_SENTENCE);
  }

  const shortened = stripFences(reply);
  if (!shortened) {
    throw new ComposerAssistError(
      'Fiddy came back with nothing. Your text is unchanged.',
    );
  }
  if (utf8Bytes(shortened) > byteLimit) {
    throw new ComposerAssistError(
      "Fiddy's shorter version was still too long for one cast. Your text is unchanged.",
    );
  }
  return shortened;
};

/**
 * One call: `text` cut into the parts of a thread. Every part must be within
 * the byte limit, there must be at least two, and never more than the
 * composer can queue — a split that cannot be posted as-is is refused rather
 * than half-applied.
 */
export const splitCastText = async ({
  assist,
  text,
  byteLimit,
  maxParts,
  fetchImpl,
}: {
  assist: ComposerAssist;
  text: string;
  byteLimit: number;
  maxParts: number;
  fetchImpl?: typeof fetch;
}): Promise<string[]> => {
  const prompt = [
    'The text below is too long for a single Farcaster cast.',
    `Split it into between 2 and ${maxParts} casts that read as one thread, each at most ${byteLimit} UTF-8 bytes.`,
    'Keep the original wording wherever it fits; break only where the thread needs a break. Keep the original language.',
    `Reply with ONLY the parts, separated by a line containing exactly ${SPLIT_DELIMITER}. No quotes, no numbering, no commentary.`,
    '',
    text,
  ].join('\n');

  let reply: string;
  try {
    reply = await chatWithAgent(
      assist.session,
      assist.agentId,
      prompt,
      fetchImpl,
    );
  } catch {
    throw new ComposerAssistError(UNREACHABLE_SENTENCE);
  }

  const parts = stripFences(reply)
    .split(new RegExp(`^\\s*${SPLIT_DELIMITER}\\s*$`, 'm'))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    throw new ComposerAssistError(
      'Fiddy could not find good breaks for a thread. Your text is unchanged.',
    );
  }
  if (parts.length > maxParts) {
    throw new ComposerAssistError(
      `Fiddy would need ${parts.length} casts for that, but a thread here is ${maxParts}. Try tightening it first.`,
    );
  }
  if (parts.some((part) => utf8Bytes(part) > byteLimit)) {
    throw new ComposerAssistError(
      'One of the parts came back too long for a cast. Your text is unchanged.',
    );
  }
  return parts;
};
