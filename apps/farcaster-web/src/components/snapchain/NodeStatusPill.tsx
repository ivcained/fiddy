/**
 * The one piece of chrome that says where your feed comes from.
 *
 * It is persistent on purpose: reading your own infrastructure is a real thing
 * this client does, so the client never hides whose server answered. What it
 * must not do is make you learn a protocol to understand a dot. The words here
 * are the plain ones from the positioning brief — "the setup you run", never the
 * name of the software it runs — and the pill links to the Advanced screen where
 * the precise version of the same fact lives.
 *
 * States (and nothing else — no state may claim your own server when Fiddy's
 * shared one answered):
 *
 *   checking     a server is configured, first health call still in flight
 *   served       it answered: version, shards, sync height
 *   unreachable  it is configured but silent, so reads fall back
 *   relay        nothing configured in this build: Fiddy's shared server only
 *
 * `kind` refines the words of a reading, and that is the point of the node
 * picker: a public server somebody else runs now says so, instead of borrowing
 * the words for a machine you own. With nothing chosen, the old wording stands
 * — a build that was pointed at an address from outside cannot know who runs
 * it, and guessing is what this pill must never do.
 */

import { type NodeHealth, SnapchainNodeClient } from 'farcaster-node-client';
import React, { memo } from 'react';

import { Link } from '~/components/links/Link';
import {
  isNodeChosen,
  isNodeConfigured,
  resolveEffectiveNodeBaseUrl,
} from '~/snapchain/nodeChoice';
import type { NodeChoiceKind } from '~/snapchain/nodePreferences';
import { useNodeHealth } from '~/snapchain/useNodeClient';
import { useActiveNodeChoice } from '~/snapchain/useNodeChoice';

export type NodePillState = 'checking' | 'served' | 'unreachable' | 'relay';

export interface NodePillInputs {
  configured: boolean;
  loading: boolean;
  health: NodeHealth | null;
}

/**
 * Pure state machine, exported so the pill's claims stay testable without a
 * browser: every visual label of the pill is decided here and nowhere else.
 */
export const nodePillState = ({
  configured,
  loading,
  health,
}: NodePillInputs): NodePillState => {
  if (!configured) {
    return 'relay';
  }
  if (health?.ok) {
    return 'served';
  }
  if (loading && !health) {
    return 'checking';
  }
  return 'unreachable';
};

const DOT_CLASSES: Record<NodePillState, string> = {
  checking: 'bg-muted',
  served: 'bg-[#d4ff3f]',
  unreachable: 'bg-red-400',
  relay: 'bg-muted',
};

const SHELL_CLASSES: Record<NodePillState, string> = {
  checking: 'border-default text-muted',
  served: 'border-[#d4ff3f]/40 text-[#d4ff3f]',
  unreachable: 'border-red-800/60 text-red-400',
  relay: 'border-default text-muted',
};

const label = (
  state: NodePillState,
  health: NodeHealth | null,
  short: boolean,
  kind: NodeChoiceKind | null,
): string => {
  if (short) {
    switch (state) {
      case 'served':
        return kind === 'public' ? 'Public' : 'Your own';
      case 'unreachable':
        return 'Offline';
      case 'relay':
        return 'Shared';
      default:
        return 'Checking…';
    }
  }
  switch (state) {
    case 'served': {
      const version = health?.info?.version;
      // Shard counts are infrastructure vocabulary; the version is the one
      // detail that helps someone compare against what they run.
      const source = kind === 'public' ? 'a public server' : 'your own setup';
      return version
        ? `Answers come from ${source} · v${version}`
        : `Answers come from ${source}`;
    }
    case 'unreachable':
      return kind === 'public'
        ? 'That public server is offline'
        : 'Your own setup is offline';
    case 'relay':
      return 'Answers come from Fiddy';
    case 'checking':
    default:
      return 'Checking your setup…';
  }
};

const title = (state: NodePillState, kind: NodeChoiceKind | null): string => {
  switch (state) {
    case 'served':
      return kind === 'public'
        ? 'Every answer you read here came from a server a public project runs and keeps open. Pick a different one, or point Fiddy at your own, in Advanced.'
        : 'Everything you read and write here goes through the setup you run. Open it in Advanced.';
    case 'unreachable':
      return kind === 'public'
        ? 'The public server Fiddy was reading from did not answer the last check. Pick another one, or point Fiddy at your own, in Advanced; reading falls back to Fiddy until one answers.'
        : 'Your own setup did not answer the last check. Open it in Advanced to see why; reading falls back to Fiddy until it does.';
    case 'relay':
      return 'This build has nothing of yours configured, so Fiddy serves the feed for you. Point it at a public one, or at your own, in Advanced.';
    case 'checking':
    default:
      return 'Asking your setup whether it is up…';
  }
};

export interface NodeStatusPillViewProps {
  state: NodePillState;
  health: NodeHealth | null;
  /** Dot + one word, for a phone top bar. */
  short?: boolean;
  /** Which kind of server answered — only ever refines the words. */
  kind?: NodeChoiceKind | null;
  className?: string;
  /** Extra classes for the label span — e.g. hide it in a collapsed sidebar. */
  labelClassName?: string;
}

/** Presentational half: renders one state, links to the node surface. */
export const NodeStatusPillView = memo<NodeStatusPillViewProps>(
  ({
    state,
    health,
    short = false,
    kind = null,
    className = '',
    labelClassName = '',
  }) => (
    <Link
      to="settingsNode"
      params={{}}
      searchParams={{}}
      title={title(state, kind)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors hover:border-[#d4ff3f] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d4ff3f] ${SHELL_CLASSES[state]} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASSES[state]} ${
          state === 'checking' ? 'animate-pulse' : ''
        }`}
      />
      <span
        role="status"
        aria-live="polite"
        className={`truncate ${labelClassName}`}
      >
        {label(state, health, short, kind)}
      </span>
    </Link>
  ),
);

NodeStatusPillView.displayName = 'NodeStatusPillView';

export interface NodeStatusPillProps {
  /** Test seam: inject a node client instead of resolving one from env. */
  node?: SnapchainNodeClient;
  configured?: boolean;
  short?: boolean;
  className?: string;
  labelClassName?: string;
}

/** Wired pill: resolves the server in use and polls its health. */
export const NodeStatusPill = memo<NodeStatusPillProps>(
  ({
    node,
    configured,
    short = false,
    className = '',
    labelClassName = '',
  }) => {
    // The server in use can change while this pill is on screen, so it is read
    // from the same store everything else reads from: a change rebuilds the
    // client, which re-runs the health check against the new address.
    const choice = useActiveNodeChoice();

    const resolved = React.useMemo(() => {
      if (node) {
        return { client: node, configured: configured ?? true };
      }
      const isConfigured = configured ?? isNodeConfigured();
      return {
        client: isConfigured
          ? new SnapchainNodeClient({ baseUrl: resolveEffectiveNodeBaseUrl() })
          : undefined,
        configured: isConfigured,
      };
    }, [node, configured, choice]);

    const { health, loading } = useNodeHealth(resolved.client);
    const state = nodePillState({
      configured: resolved.configured,
      loading,
      health,
    });

    return (
      <NodeStatusPillView
        state={state}
        health={health}
        short={short}
        kind={isNodeChosen() ? (choice?.kind ?? null) : null}
        className={className}
        labelClassName={labelClassName}
      />
    );
  },
);

NodeStatusPill.displayName = 'NodeStatusPill';
