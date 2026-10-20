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
 *   checking     your own server is configured, first health call still in flight
 *   served       your own server answered: version, shards, sync height
 *   unreachable  your own server is configured but silent, so reads fall back
 *   relay        nothing configured in this build: Fiddy's shared server only
 */

import { type NodeHealth, SnapchainNodeClient } from 'farcaster-node-client';
import React, { memo } from 'react';

import { Link } from '~/components/links/Link';
import {
  isNodeExplicitlyConfigured,
  resolveNodeBaseUrl,
} from '~/snapchain/nodeEnv';
import { useNodeHealth } from '~/snapchain/useNodeClient';

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
): string => {
  if (short) {
    switch (state) {
      case 'served':
        return 'Your own';
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
      return version
        ? `Answers come from your own setup · v${version}`
        : 'Answers come from your own setup';
    }
    case 'unreachable':
      return 'Your own setup is offline';
    case 'relay':
      return 'Answers come from Fiddy';
    case 'checking':
    default:
      return 'Checking your setup…';
  }
};

const title = (state: NodePillState): string => {
  switch (state) {
    case 'served':
      return 'Everything you read and write here goes through the setup you run. Open it in Advanced.';
    case 'unreachable':
      return 'Your own setup did not answer the last check. Open it in Advanced to see why; reading falls back to Fiddy until it does.';
    case 'relay':
      return 'This build has nothing of yours configured, so Fiddy serves the feed for you. Point it at your own setup in Advanced.';
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
  className?: string;
  /** Extra classes for the label span — e.g. hide it in a collapsed sidebar. */
  labelClassName?: string;
}

/** Presentational half: renders one state, links to the node surface. */
export const NodeStatusPillView = memo<NodeStatusPillViewProps>(
  ({ state, health, short = false, className = '', labelClassName = '' }) => (
    <Link
      to="settingsNode"
      params={{}}
      searchParams={{}}
      title={title(state)}
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
        {label(state, health, short)}
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

/** Wired pill: resolves the node from env and polls its health. */
export const NodeStatusPill = memo<NodeStatusPillProps>(
  ({
    node,
    configured,
    short = false,
    className = '',
    labelClassName = '',
  }) => {
    const resolved = React.useMemo(() => {
      if (node) {
        return { client: node, configured: configured ?? true };
      }
      const isConfigured = configured ?? isNodeExplicitlyConfigured();
      return {
        client: isConfigured
          ? new SnapchainNodeClient({ baseUrl: resolveNodeBaseUrl() })
          : undefined,
        configured: isConfigured,
      };
    }, [node, configured]);

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
        className={className}
        labelClassName={labelClassName}
      />
    );
  },
);

NodeStatusPill.displayName = 'NodeStatusPill';
