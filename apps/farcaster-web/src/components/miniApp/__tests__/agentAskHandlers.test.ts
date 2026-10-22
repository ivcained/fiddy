/**
 * `draft` and `post`: the two asks that end in Fiddy's own composer.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.2, §3.3, §6. Every
 * state the bridge can answer with is proved here with fakes and no browser:
 *
 *  - the message the agent gets is §3.2's template exactly, the app's text
 *    quoted and capped, and nothing else;
 *  - a `draft` puts the agent's words in the reader's composer and tells the app
 *    `drafted` — and the agent's words never come back out of this module;
 *  - a `post` is the reader's own press in the same composer, and the app is
 *    told `posted` / `unknown` / `failed` / `declined` from the write seam's own
 *    evidence, never a guess, and **never a cast hash** (§3.3);
 *  - an ask the reader declined is never carried anywhere.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentAskApproval } from '~/components/miniApp/agentAskApproval';
import {
  AGENT_ASK_MAX_TEXT_LENGTH,
  agentAskAnswer,
  type AgentAskEnvelope,
} from '~/components/miniApp/agentAskChannel';
import {
  agentAskChatMessage,
  type AgentWriteEvidence,
  createAgentAskHandlers,
} from '~/components/miniApp/agentAskHandlers';

const ORIGIN = 'https://beep.works';

const envelope = (
  overrides: Partial<AgentAskEnvelope> = {},
): AgentAskEnvelope => ({
  id: 'ask-1',
  ask: 'draft',
  text: 'ask me anything for $0.05',
  ...overrides,
});

const context = { origin: ORIGIN, name: 'Beep' };

/** Let a promise chain reach its next await. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const HASH = '0x9f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f708192a3';

interface Harness {
  approval: ReturnType<typeof createAgentAskApproval>;
  handlers: ReturnType<typeof createAgentAskHandlers>;
  chat: ReturnType<typeof vi.fn>;
  composerIntents: { text: string; embeds?: string[] }[];
  /** How the composer closed, for the write the reader pressed Cast on. */
  closeComposer: (outcome: { cast: boolean }) => void;
  /** One write's evidence, as the seam reports it. */
  reportWrite: (evidence: AgentWriteEvidence) => void;
  agent: unknown;
}

const harness = ({
  agents = [
    { session: { baseUrl: 'https://agent.test', token: 't' }, agentId: 'a1' },
  ],
  reply = 'Here is a draft: “ask me anything for $0.05”.',
}: {
  agents?: unknown[];
  reply?: string;
} = {}): Harness => {
  const approval = createAgentAskApproval({ deadlineMs: 5 * 60_000 });
  const chat = vi.fn(async () => reply);
  const composerIntents: { text: string; embeds?: string[] }[] = [];
  let closeComposer: (outcome: { cast: boolean }) => void = () => undefined;
  let reportWrite: (evidence: AgentWriteEvidence) => void = () => undefined;

  const target = agents[0] as { session: unknown; agentId: string } | undefined;

  const handlers = createAgentAskHandlers({
    approval,
    agent: async () => target,
    chat,
    composer: (intent) => {
      composerIntents.push(intent);
      const closed = new Promise<{ cast: boolean }>((resolve) => {
        closeComposer = resolve;
      });
      return { closed };
    },
    writes: {
      observe: (listener) => {
        reportWrite = listener;
        return () => {
          reportWrite = () => undefined;
        };
      },
    },
  });

  return {
    approval,
    handlers,
    chat,
    composerIntents,
    closeComposer: (outcome) => closeComposer(outcome),
    reportWrite: (evidence) => reportWrite(evidence),
    agent: agents,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('what a mini app may ask for', () => {
  it('answers exactly the two asks this slice lands', () => {
    const { handlers } = harness();

    expect(handlers.answers('draft')).toBe(true);
    expect(handlers.answers('post')).toBe(true);
    // `remind` is S3's: until then a shell with no path for it says so.
    expect(handlers.answers('remind')).toBe(false);
  });
});

describe('draft', () => {
  it('is not carried until the reader approved it', async () => {
    const { approval, handlers, chat, composerIntents } = harness();

    const answered = handlers.answer(envelope(), context);
    await flush();

    // The card is up; nothing has happened yet.
    expect(approval.getState().pending?.origin).toBe(ORIGIN);
    expect(chat).not.toHaveBeenCalled();
    expect(composerIntents).toEqual([]);

    approval.decline();
    expect(await answered).toBe('declined');
    expect(chat).not.toHaveBeenCalled();
    expect(composerIntents).toEqual([]);
  });

  it('sends §3.2’s message, exactly, with the app’s text quoted and capped', async () => {
    const { approval, handlers, chat } = harness();
    const long = 'x'.repeat(600);
    const answered = handlers.answer(envelope({ text: long }), context);
    await flush();
    approval.approve();
    await answered;

    expect(chat).toHaveBeenCalledTimes(1);
    const [target, message] = chat.mock.calls[0] as [
      { agentId: string },
      string,
    ];
    expect(target.agentId).toBe('a1');
    expect(message).toBe(
      `Someone's app at beep.works asks you for a draft cast about this:\n"${'x'.repeat(
        AGENT_ASK_MAX_TEXT_LENGTH,
      )}"\nWrite the draft. Do not post anything.`,
    );
    // The app's own words, and nothing the app added.
    expect(message).not.toContain('undefined');
    expect(agentAskChatMessage({ domain: 'beep.works', text: long })).toBe(
      message,
    );
  });

  it('opens the reader’s own composer with the agent’s answer, and says drafted', async () => {
    const { approval, handlers, composerIntents } = harness({
      reply: 'A draft about the thing.',
    });
    const answered = handlers.answer(
      envelope({ embeds: ['https://example.com/a.png'] }),
      context,
    );
    await flush();
    approval.approve();

    expect(await answered).toBe('drafted');
    expect(composerIntents).toEqual([
      {
        text: 'A draft about the thing.',
        embeds: ['https://example.com/a.png'],
      },
    ]);
    // The reader's press is the only thing that can sign anything, so the card
    // is done: it is not left waiting on the composer.
    expect(approval.getState().phase).toBe('idle');
  });

  it('never hands the agent’s words back to the app', async () => {
    const secret = 'the reader’s agent said something private';
    const { approval, handlers } = harness({ reply: secret });
    const ask = envelope();

    const answered = handlers.answer(ask, context);
    await flush();
    approval.approve();
    const state = await answered;

    // The app gets a state word, and the sentence that word owns.
    const answer = agentAskAnswer(ask.id, state);
    expect(answer.state).toBe('drafted');
    expect(JSON.stringify(answer)).not.toContain('private');
    expect(answer.message).toBe('A draft is open in the composer.');
  });

  it('tells the app failed and opens nothing when the agent cannot be reached', async () => {
    const { approval, handlers, composerIntents, chat } = harness({
      agents: [],
    });

    const answered = handlers.answer(envelope(), context);
    await flush();
    approval.approve();
    const state = await answered;

    expect(state).toBe('failed');
    expect(chat).not.toHaveBeenCalled();
    expect(composerIntents).toEqual([]);
    // §3.2: one sentence says so, and the reader is the person it is said to.
    expect(approval.getState().phase).toBe('ended');
    expect(approval.getState().note).toBe(
      'Your agent could not be reached, so no draft was written.',
    );
  });

  it('tells the app failed and opens nothing when the chat itself fails', async () => {
    const { approval, composerIntents } = harness();
    const erroring = createAgentAskHandlers({
      approval,
      agent: async () => ({ session: {}, agentId: 'a1' }),
      chat: async () => {
        throw new Error('agent service down');
      },
      composer: (intent) => {
        composerIntents.push(intent);
        return { closed: Promise.resolve({ cast: false }) };
      },
    });

    const answered = erroring.answer(envelope(), context);
    await flush();
    approval.approve();

    expect(await answered).toBe('failed');
    expect(composerIntents).toEqual([]);
    expect(approval.getState().phase).toBe('ended');
  });
});

describe('post', () => {
  const postAsk = () => envelope({ ask: 'post', id: 'ask-post' });

  const runPost = async (harnessed: Harness) => {
    const answered = harnessed.handlers.answer(postAsk(), context);
    await flush();
    harnessed.approval.approve();
    await flush();
    // Returned inside an object on purpose: `await` on the promise itself would
    // wait for the composer to close, which is what the test then drives.
    return { answered };
  };

  it('opens the reader’s own composer with the app’s words, never the app itself', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    expect(harnessed.composerIntents).toEqual([
      { text: 'ask me anything for $0.05' },
    ]);
    harnessed.closeComposer({ cast: true });
    expect(await answered).toBe('posted');
  });

  it('says posted when the seam’s own evidence says the message landed', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: true });

    expect(await answered).toBe('posted');
  });

  it('says posted from the seam’s evidence even when the composer could not render it', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // A node accepted it and reads it back; the client simply could not turn
    // the stored message into a cast to show (`nodeWrites`' own 502). The
    // write did land, and the evidence is the only place that says so.
    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('posted');
  });

  it('says unknown when it was accepted and nothing shows it', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    harnessed.reportWrite({ accepted: true, landed: false, messageHash: HASH });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('unknown');
  });

  it('says failed when an approved attempt did not land', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // Signed and submitted, and the node refused it.
    harnessed.reportWrite({ accepted: false, landed: null, messageHash: HASH });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('failed');
  });

  it('says declined when the reader never got as far as a write', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // The composing reader closing the composer: nothing was ever signed.
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('declined');
  });

  it('says declined when the reader said not now to the posting-key approval', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // The seam's own refusal for a write with no key: nothing signed, nothing
    // submitted — the person's own answer, reported as the person's own answer.
    harnessed.reportWrite({ accepted: false, landed: null });
    harnessed.closeComposer({ cast: false });

    expect(await answered).toBe('declined');
  });

  it('remembers the strongest thing that happened, not the last', async () => {
    const harnessed = harness();
    const { answered } = await runPost(harnessed);

    // A refused attempt, then the reader got a key and the retry landed.
    harnessed.reportWrite({ accepted: false, landed: null, messageHash: HASH });
    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: true });

    expect(await answered).toBe('posted');
  });

  it('never hands the app the cast’s hash', async () => {
    const harnessed = harness();
    const ask = postAsk();
    const { answered } = await runPost(harnessed);

    harnessed.reportWrite({ accepted: true, landed: true, messageHash: HASH });
    harnessed.closeComposer({ cast: true });
    const state = await answered;

    const answer = agentAskAnswer(ask.id, state);
    expect(Object.keys(answer).sort()).toEqual([
      'id',
      'message',
      'state',
      'type',
      'v',
    ]);
    expect(JSON.stringify(answer)).not.toContain(HASH);
    expect(JSON.stringify(answer)).not.toContain('9f2c1d4e');
    expect(answer.message).toBe(
      "Fiddy's owner approved it, and the network shows the cast.",
    );
  });

  it('is not carried at all when the reader declined the ask itself', async () => {
    const harnessed = harness();
    const ask = postAsk();

    const answered = harnessed.handlers.answer(ask, context);
    await flush();
    harnessed.approval.decline();

    expect(await answered).toBe('declined');
    // No composer, and nothing to observe: declining the card is the end of it.
    expect(harnessed.composerIntents).toEqual([]);
  });
});

describe('the sentences the app can read', () => {
  it('carries no protocol word for a reader or an app author', async () => {
    const states = [
      'posted',
      'unknown',
      'failed',
      'declined',
      'drafted',
    ] as const;

    for (const state of states) {
      const answer = agentAskAnswer('ask-1', state);
      expect(answer.message).not.toMatch(/node|signer|scope|TTL|gasless/i);
    }
  });
});
