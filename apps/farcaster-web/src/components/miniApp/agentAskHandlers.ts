/**
 * The two asks that end in Fiddy's own composer: `draft` and `post`.
 *
 * Design of record: `docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.2 (`draft`), §3.3
 * (`post`), §4 (the card) and §6 (the sentences). S1 answers every ask honestly
 * and does nothing; this is the half that does something, for exactly two asks,
 * and it is written so that the two properties §3 keeps cannot be broken from
 * here:
 *
 *  1. **Nothing is echoed.** Every path below returns a state word and nothing
 *     else. The agent's words never cross back into the frame (§3.2), and a
 *     `post` reports a state and never a cast hash (§3.3 — `composeCast` hands
 *     one back today; that asymmetry is deliberate).
 *  2. **No text is signed that the reader has not read in Fiddy's own
 *     composer.** `draft` puts the agent's answer in the reader's composer,
 *     `post` puts the app's own words there (read first on the card, quoted and
 *     inert), and both end at the reader's own press of Cast. There is no path
 *     from an ask to the write seam that skips that composer, and this file has
 *     no way to write at all: it opens the shell's composer and reads what the
 *     shell's own write did.
 *
 * The module is React-free and takes everything it needs as an argument, so
 * every state it can answer is proved by a unit test with no browser and no
 * network: the card's decision, the one chat message, the composer, and the
 * write seam's own evidence.
 */

import type { AgentAskTicket } from '~/components/miniApp/agentAskApproval';
import {
  AGENT_ASK_MAX_TEXT_LENGTH,
  type AgentAskEnvelope,
  type AgentAskKind,
  type AgentAskState,
} from '~/components/miniApp/agentAskChannel';

/**
 * What the write seam reports about a write, as much of it as an answer needs:
 * `landed` is the node's own state read back after it accepted the message, and
 * `messageHash` is set only once something was signed and submitted. A refusal
 * with no hash never signed anything (§3.3's "the person said no").
 */
export interface AgentWriteEvidence {
  accepted: boolean;
  landed: boolean | null;
  messageHash?: string;
}

/** What the composer answered: whether a cast really came back from the seam. */
export interface ComposerOutcome {
  cast: boolean;
}

/** The shell's own composer, opened over the mini app window. */
export interface ComposerOpening {
  /** Resolves when the composer closes: a cast came back, or it did not. */
  closed: Promise<ComposerOutcome>;
}

/** The paired agent a `draft` message goes to, read when the ask is approved. */
export interface AgentAskTarget {
  /** The paired session, whatever the agent service needs to be reached. */
  session: unknown;
  /** The agent this browser's session is for. The app can never name it (§5). */
  agentId: string;
}

export interface AgentAskHandlerDeps {
  /** The store that puts the decision in front of the reader (§4). */
  approval: { ask: (ask: PendingAskShape) => AgentAskTicket };
  /**
   * The paired agent, or undefined when this browser cannot reach one. Read
   * after the reader approves, never before: an unreachable agent must not
   * change what the card asks.
   */
  agent: () => Promise<AgentAskTarget | undefined>;
  /** One chat message, answering the agent's own words (or throwing). */
  chat: (target: AgentAskTarget, message: string) => Promise<string>;
  /**
   * Open the shell's composer over the mini app window — the same route
   * `composeCast` uses — with the words already in it. Opening is immediate
   * (the reader's press of Cast is what ends it); the returned promise is what
   * the shell's own write answers.
   */
  composer: (intent: { text: string; embeds?: string[] }) => ComposerOpening;
  /**
   * The write seam's own evidence, as it happens, for the one write the reader
   * presses. Optional: with nothing wired, a `post` reports what the composer
   * itself answered (a cast came back or it did not) and never a state it
   * cannot back.
   */
  writes?: {
    observe: (listener: (evidence: AgentWriteEvidence) => void) => () => void;
  };
}

/** The ask, in the shape the store needs it (§4's card, S2's two kinds). */
export interface PendingAskShape {
  id: string;
  origin: string;
  kind: AgentAskKind;
  text: string;
  embeds?: string[];
  name?: string;
}

/** What the card names of the window the ask came from. */
export interface AgentAskHandlerContext {
  /** The origin the window was launched with. */
  origin: string;
  /** The app's own manifest name, when the shell read one. */
  name?: string;
}

export interface AgentAskHandlers {
  /** Whether this shell has a real answer for this ask at all. */
  answers: (kind: AgentAskKind) => boolean;
  /**
   * Answer one validated ask. The state it returns is what the app is told, and
   * it is the only thing the app is told.
   */
  answer: (
    envelope: AgentAskEnvelope,
    context: AgentAskHandlerContext,
  ) => Promise<AgentAskState>;
}

/**
 * §3.2, the message the agent gets, exactly: the app's own text quoted, with the
 * app's domain named and the length capped at the 500 it arrived with. The
 * template is fixed and this is the whole of what the app can put into it, so an
 * app cannot name a recipient, an account, a tool or a second instruction —
 * §7 row 4 is the reason, and the reader's composer is the backstop.
 */
export const agentAskChatMessage = ({
  domain,
  text,
}: {
  domain: string;
  text: string;
}): string =>
  `Someone's app at ${domain} asks you for a draft cast about this:\n"${text.slice(
    0,
    AGENT_ASK_MAX_TEXT_LENGTH,
  )}"\nWrite the draft. Do not post anything.`;

/** The domain in an origin, as the sentence in §3.2 and the card both say it. */
export const domainOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * What the app is told, from what actually happened to the write (§3.3).
 *
 * The seam's own evidence decides it, in this order, and nothing else does:
 *
 *   landed                 the node read the message back — `posted`
 *   accepted, not landed    the network took it and does not show it — `unknown`
 *   refused, after signing  an attempt was made and did not land — `failed`
 *   nothing signed          the reader never got as far as a write — `declined`
 *
 * The last line is the one worth stating: a reader who closed the composer, or
 * who said not now to the posting-key approval the seam raised itself, is told
 * to the app as `declined` — the person's own answer, which is what it was. A
 * composer that handed back a cast is the same proof as `landed` (it is the
 * seam's read-back that produces one) and is used when no evidence stream is
 * wired at all.
 */
export const agentPostState = ({
  cast,
  evidence,
}: {
  cast: boolean;
  evidence: AgentWriteEvidence[];
}): AgentAskState => {
  if (evidence.some((one) => one.landed === true) || cast) {
    return 'posted';
  }
  if (evidence.some((one) => one.accepted && one.landed === false)) {
    return 'unknown';
  }
  if (evidence.some((one) => !one.accepted && one.messageHash !== undefined)) {
    return 'failed';
  }
  return 'declined';
};

export const createAgentAskHandlers = (
  deps: AgentAskHandlerDeps,
): AgentAskHandlers => {
  const draft = async (
    envelope: AgentAskEnvelope,
    context: AgentAskHandlerContext,
  ): Promise<AgentAskState> => {
    const target = await deps.agent();
    if (target === undefined) {
      // §3.2: "If the agent is unreachable, the composer is not opened, one
      // sentence says so, and the app is told `failed`." Nobody was asked for
      // anything and nothing was drafted.
      return 'failed';
    }

    let text: string;
    try {
      text = await deps.chat(
        target,
        agentAskChatMessage({
          domain: domainOf(context.origin),
          text: envelope.text,
        }),
      );
    } catch {
      return 'failed';
    }

    // The agent's answer becomes the reader's own draft, in the reader's own
    // composer. It is never sent to the app (§3.2) — this is the only place it
    // goes, and the next thing that can happen to it is the reader's own press.
    deps.composer({
      text,
      ...(envelope.embeds === undefined ? {} : { embeds: envelope.embeds }),
    });
    return 'drafted';
  };

  const post = async (envelope: AgentAskEnvelope): Promise<AgentAskState> => {
    const evidence: AgentWriteEvidence[] = [];
    const stop =
      deps.writes?.observe((one) => {
        evidence.push(one);
      }) ?? (() => undefined);

    let outcome: ComposerOutcome;
    try {
      // The app's own words, read on the card first (quoted and inert) and
      // signed only from here: the reader presses Cast in Fiddy's own composer,
      // and the write leaves through the seam every other write uses — which
      // raises the existing posting-key approval all by itself if this device
      // holds no key (§3.3). There is no second approval here and no second
      // route into the seam.
      outcome = await deps.composer({ text: envelope.text }).closed;
    } catch {
      outcome = { cast: false };
    } finally {
      stop();
    }

    return agentPostState({ cast: outcome.cast, evidence });
  };

  return {
    answers: (kind) => kind === 'draft' || kind === 'post',

    answer: async (envelope, context) => {
      const ticket = deps.approval.ask({
        id: envelope.id,
        origin: context.origin,
        kind: envelope.ask,
        text: envelope.text,
        ...(envelope.embeds === undefined ? {} : { embeds: envelope.embeds }),
        ...(context.name === undefined ? {} : { name: context.name }),
      });

      // The card is the consent: nothing below happens until the reader pressed
      // its own control. A declined ask is never carried anywhere.
      const decision = await ticket.decision;
      if (decision === 'declined') {
        return 'declined';
      }

      if (envelope.ask === 'draft') {
        ticket.working('Asking your agent for the draft…');
        const state = await draft(envelope, context);
        if (state === 'failed') {
          ticket.end(
            'Your agent could not be reached, so no draft was written.',
          );
          return state;
        }
        ticket.settle();
        return state;
      }

      // `post`: the composer is the reader's, and it opens over the app's frame.
      // The card underneath has nothing left to show while it is up.
      ticket.working(
        'Your composer is open — press Cast when the words are right.',
      );
      const state = await post(envelope);
      ticket.settle();
      return state;
    },
  };
};
