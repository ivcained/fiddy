/**
 * Client Filter Card - include or exclude casts by the client that authored them.
 *
 * This is a view-layer preference, never a protocol claim: the casts stay on your
 * node either way. Client identity comes from the node's own signer records
 * (`requestFid` on a gasless key), so a client is only *named* when the reader
 * names it — this UI never invents a vendor attribution from a FID.
 */

import type {
  ClientFilterMode,
  ClientFilterPolicy,
} from 'farcaster-node-client';
import React, { memo, useState } from 'react';

import {
  type ClientLabels,
  requestFidFromClientId,
} from '~/snapchain/nodePreferences';

interface ClientFilterCardProps {
  policy: ClientFilterPolicy;
  clientCounts: Map<string, { label: string; count: number }>;
  clientLabels: ClientLabels;
  onChange: (mode: ClientFilterMode, clientIds: string[]) => void;
  onLabelClient: (clientId: string, label: string) => void;
}

const MODES: { mode: ClientFilterMode; label: string; hint: string }[] = [
  { mode: 'all', label: 'All', hint: 'Show casts from every client' },
  {
    mode: 'only',
    label: 'Only',
    hint: 'Show casts only from the clients below',
  },
  {
    mode: 'exclude',
    label: 'Exclude',
    hint: 'Hide casts from the clients below',
  },
];

const ClientFilterCard = memo<ClientFilterCardProps>(
  ({ policy, clientCounts, clientLabels, onChange, onLabelClient }) => {
    const [namingClientId, setNamingClientId] = useState<string | null>(null);
    const [draftLabel, setDraftLabel] = useState('');

    const selected = new Set(policy.clientIds);
    const clientList = Array.from(clientCounts.entries()).map(([id, data]) => ({
      id,
      ...data,
    }));

    const handleModeChange = (mode: ClientFilterMode) => {
      // Changing mode keeps the current selection: `all` ignores it, `only` and
      // `exclude` apply it. That way switching back and forth never loses work.
      onChange(mode, Array.from(selected));
    };

    const handleClientToggle = (clientId: string) => {
      const next = new Set(selected);
      if (next.has(clientId)) {
        next.delete(clientId);
      } else {
        next.add(clientId);
      }
      // Toggling a client while on "all" is a no-op unless we move to a mode that
      // uses the selection, so nudge the reader into "exclude" — the common intent.
      onChange(
        policy.mode === 'all' ? 'exclude' : policy.mode,
        Array.from(next),
      );
    };

    const startNaming = (clientId: string, currentLabel: string) => {
      setNamingClientId(clientId);
      setDraftLabel(
        requestFidFromClientId(clientId) === null ? '' : currentLabel,
      );
    };

    const commitLabel = () => {
      if (namingClientId) {
        onLabelClient(namingClientId, draftLabel);
      }
      setNamingClientId(null);
      setDraftLabel('');
    };

    return (
      <div className="solid-glass-pane rounded-lg border p-4 border-default">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold text-primary">Client filter</span>
          <span className="text-xs text-muted">
            view only — nothing is hidden on your setup
          </span>
        </div>

        <div className="mb-3 flex gap-2">
          {MODES.map(({ mode, label, hint }) => (
            <button
              key={mode}
              type="button"
              title={hint}
              onClick={() => handleModeChange(mode)}
              className={`rounded px-3 py-1 text-sm ${
                policy.mode === mode
                  ? 'font-medium text-[#1a1c10] bg-action-primary'
                  : 'text-primary bg-action-muted hover:bg-tertiary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {clientList.length > 0 ? (
          <div className="flex flex-col gap-2">
            {clientList.map(({ id, label, count }) => (
              <div key={id} className="flex items-center gap-2 text-sm">
                <label className="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onChange={() => handleClientToggle(id)}
                    className="accent-[#d4ff3f]"
                  />
                  <span className="flex-1 text-primary">{label}</span>
                  <span className="text-xs text-muted">({count})</span>
                </label>
                {requestFidFromClientId(id) !== null && (
                  <button
                    type="button"
                    onClick={() =>
                      startNaming(
                        id,
                        clientLabels[String(requestFidFromClientId(id))] ?? '',
                      )
                    }
                    className="text-action-primary text-xs hover:underline"
                  >
                    {clientLabels[String(requestFidFromClientId(id))]
                      ? 'rename'
                      : 'name'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted">
            No client data yet — refresh the feed above.
          </div>
        )}

        {namingClientId && (
          <div className="mt-3 flex items-center gap-2">
            <input
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.target.value)}
              placeholder="e.g. the app you know this FID belongs to"
              className="flex-1 rounded border bg-transparent p-2 text-sm text-primary border-default"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitLabel();
                }
              }}
            />
            <button
              type="button"
              onClick={commitLabel}
              className="rounded px-3 py-1 text-sm text-[#1a1c10] bg-action-primary"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setNamingClientId(null);
                setDraftLabel('');
              }}
              className="rounded px-2 py-1 text-sm text-muted hover:text-primary"
            >
              Cancel
            </button>
          </div>
        )}

        <div className="mt-3 text-xs text-muted">
          Who wrote a cast is read from your own setup&rsquo;s own records: the
          key that signed it reports which app asked for it, and that is how a
          client gets named here. No account gets a name until you give it one.
        </div>
      </div>
    );
  },
);

ClientFilterCard.displayName = 'ClientFilterCard';

export { ClientFilterCard };
