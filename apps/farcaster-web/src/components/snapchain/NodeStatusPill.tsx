/**
 * Node status pill — the one piece of chrome that says where your feed comes
 * from. It is persistent on purpose: reading your own infrastructure is the
 * point of this client, so the client never hides whose node answered.
 *
 * States (and nothing else — no state may claim "your node" when the relay
 * answered):
 *
 *   checking     your node is configured, first health call still in flight
 *   served       your node answered: version, shards, sync height
 *   unreachable  your node is configured but silent, so reads fall back
 *   relay        no node configured in this build: public relay only
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
        return 'Your node';
      case 'unreachable':
        return 'Node offline';
      case 'relay':
        return 'Relay';
      default:
        return 'Node…';
    }
  }
  switch (state) {
    case 'served': {
      const shards = health?.info?.numShards;
      const version = health?.info?.version;
      const detail = [version && `v${version}`, shards && `${shards} shards`]
        .filter(Boolean)
        .join(' · ');
      return detail ? `Served by your node · ${detail}` : 'Served by your node';
    }
    case 'unreachable':
      return 'Your node unreachable';
    case 'relay':
      return 'Public relay';
    case 'checking':
    default:
      return 'Checking your node…';
  }
};

const title = (state: NodePillState): string => {
  switch (state) {
    case 'served':
      return 'Reads and writes are going to the Snapchain node you configured. Open your node.';
    case 'unreachable':
      return 'Your node did not answer the last health check. Open your node to see why; reads fall back to the public relay until it does.';
    case 'relay':
      return 'This build has no node configured, so reads come from a public relay. Point it at your own node.';
    case 'checking':
    default:
      return 'Asking your node for /v1/info…';
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
