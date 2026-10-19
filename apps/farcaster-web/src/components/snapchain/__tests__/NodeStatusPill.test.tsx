// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { NodeHealth } from 'farcaster-node-client';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  nodePillState,
  NodeStatusPillView,
} from '~/components/snapchain/NodeStatusPill';

// The pill links into the router; the anchor is all this test needs from it.
vi.mock('~/components/links/Link', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({
      children,
      title,
      className,
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
      title: string;
      params: unknown;
      searchParams: unknown;
      to: string;
    }) =>
      createElement(
        'a',
        { href: '/~/settings/node', title, className },
        children,
      ),
  };
});

const health = (ok: boolean, version = '0.13.5'): NodeHealth => ({
  ok,
  baseUrl: 'https://node.example.com',
  latencyMs: 12,
  ...(ok ? { info: { version, numShards: 2 } as NodeHealth['info'] } : {}),
});

afterEach(cleanup);

describe('nodePillState', () => {
  it('never claims your node when no node is configured', () => {
    expect(
      nodePillState({ configured: false, loading: false, health: null }),
    ).toBe('relay');
    // Even a stale healthy reading must not upgrade a build with no node.
    expect(
      nodePillState({
        configured: false,
        loading: false,
        health: health(true),
      }),
    ).toBe('relay');
  });

  it('is checking while the first call is in flight', () => {
    expect(
      nodePillState({ configured: true, loading: true, health: null }),
    ).toBe('checking');
  });

  it('says served only when the node answered', () => {
    expect(
      nodePillState({ configured: true, loading: false, health: health(true) }),
    ).toBe('served');
  });

  it('says unreachable when a configured node failed or stopped answering', () => {
    expect(
      nodePillState({
        configured: true,
        loading: false,
        health: health(false),
      }),
    ).toBe('unreachable');
    // A previous healthy reading followed by a failed refresh is still a
    // failed refresh: the pill reports the last call, not a memory of success.
    expect(
      nodePillState({
        configured: true,
        loading: true,
        health: health(false),
      }),
    ).toBe('unreachable');
  });
});

describe('NodeStatusPillView', () => {
  it('names your node, with the version and shard count', () => {
    render(
      <NodeStatusPillView state="served" health={health(true, '0.13.4')} />,
    );
    expect(
      screen.getByText('Served by your node · v0.13.4 · 2 shards'),
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Served');
  });

  it('says public relay, and does not mention your node, when there is none', () => {
    render(<NodeStatusPillView state="relay" health={null} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toBe('Public relay');
    expect(text.toLowerCase()).not.toContain('your node');
  });

  it('says unreachable in words, so a fallback is never silent', () => {
    render(<NodeStatusPillView state="unreachable" health={health(false)} />);
    expect(screen.getByRole('status').textContent).toBe(
      'Your node unreachable',
    );
  });

  it('shortens to one word for the phone top bar', () => {
    render(<NodeStatusPillView state="served" health={health(true)} short />);
    expect(screen.getByRole('status').textContent).toBe('Your node');
  });

  it('links to the node surface in every state', () => {
    render(<NodeStatusPillView state="relay" health={null} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      '/~/settings/node',
    );
  });
});
