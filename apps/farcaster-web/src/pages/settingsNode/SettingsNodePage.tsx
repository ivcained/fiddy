/**
 * Your own setup — the Advanced screen.
 *
 * The positioning pivot demoted this surface on purpose: it still works, it is
 * still linked from the status pill and from Advanced in the nav, and it is
 * deliberately absent from onboarding. Everything on it is optional, and the
 * product works without it.
 *
 * The vocabulary here is the precise one (node, app key, scope, TTL) because
 * these are the names of the things you are configuring — but the screen says
 * "Advanced" out loud, and every entry point into it uses plain words.
 *
 * Provides:
 * - Node status (health check, version, shards)
 * - App key management (issue/revoke gasless keys)
 * - Cast composer using your own node
 * - Feed from your own node
 * - Client include/exclude filter
 */

import {
  type AppKey,
  appKeyFromPrivateKeyHex,
  buildCastAddMessage,
  buildLinkAddMessage,
  buildLinkRemoveMessage,
  buildReactionAddMessage,
  buildReactionRemoveMessage,
  bytesToHex,
  CastClientResolver,
  type ClientFilterMode,
  type ClientFilterPolicy,
  type ClientIdentity,
  fetchCastsByFid,
  fetchFollowingFeed,
  fetchSignerState,
  filterCastsByClient,
  generateAppKey,
  issueAppKey,
  type IssueAppKeyStep,
  type NodeSigner,
  revokeAppKey,
} from 'farcaster-node-client';
import React, { memo, useCallback, useEffect, useState } from 'react';
import { mnemonicToAccount } from 'viem/accounts';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { SettingsPageContent } from '~/components/page/SettingsPageContent';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { SettingsNav } from '~/layouts/SettingsNav';
import {
  clearAppKey,
  loadAppKey,
  loadAppNonce,
  saveAppKey,
  saveAppNonce,
} from '~/snapchain/appKeyStorage';
import { resolveNodeBaseUrl } from '~/snapchain/nodeEnv';
import {
  type ClientLabels,
  loadClientLabels,
  loadFilterPolicy,
  saveClientLabels,
  saveFilterPolicy,
  toKnownClients,
  withClientLabel,
} from '~/snapchain/nodePreferences';
import { useNodeClient } from '~/snapchain/useNodeClient';
import { trackError } from '~/utils/errorUtils';

import { AppKeyCard } from './Component/AppKeyCard';
import { ClientFilterCard } from './Component/ClientFilterCard';
import { NodeComposer } from './Component/NodeComposer';
import { NodeFeed } from './Component/NodeFeed';
import { NodeStatusCard } from './Component/NodeStatusCard';
import { SeedPhraseWarningModal } from './Component/SeedPhraseWarningModal';

/**
 * `trackError` takes a single error, so a failed node call is wrapped to keep
 * both the operation that failed and the underlying reason in the dev log.
 */
const nodeError = (operation: string, error: unknown) =>
  new Error(
    `${operation}: ${error instanceof Error ? error.message : String(error)}`,
  );

const SettingsNodePage = memo(() => {
  const { fid } = useCurrentUser();
  const node = useNodeClient();

  // Node health state
  const [nodeHealth, setNodeHealth] = useState<{
    ok: boolean;
    baseUrl: string;
    latencyMs: number;
    version?: string;
    numShards?: number;
    maxHeight?: number;
    error?: string;
  } | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  // App key state
  const [appKey, setAppKey] = useState<AppKey | null>(null);
  const [signerState, setSignerState] = useState<{
    hasKey: boolean;
    gaslessSignerCount: number;
    gaslessSignerLimit: number;
    currentUserNonce: number;
    signer?: NodeSigner;
  } | null>(null);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issueStep, setIssueStep] = useState<IssueAppKeyStep | null>(null);

  // Seed phrase modal state
  const [showSeedPhraseModal, setShowSeedPhraseModal] = useState(false);

  // Feed state
  const [casts, setCasts] = useState<
    Array<{
      cast: {
        fid: number;
        hash: string;
        signer: string;
        timestamp: number;
        timestampMs: number;
        castAdd?: { text: string; embeds: unknown[] };
      };
      client?: ClientIdentity;
    }>
  >([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedEmpty, setFeedEmpty] = useState(false);

  // Client filter state
  const [filterPolicy, setFilterPolicy] = useState<ClientFilterPolicy>({
    mode: 'all',
    clientIds: [],
  });
  const [clientLabels, setClientLabels] = useState<ClientLabels>({});
  const [clientCounts, setClientCounts] = useState<
    Map<string, { label: string; count: number }>
  >(new Map());

  // Post state
  const [postSuccess, setPostSuccess] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  // React/follow state. These writes have no optimistic UI, so without a
  // message a rejected reaction would look like a no-op to the reader.
  const [actionError, setActionError] = useState<string | null>(null);

  // Load app key on mount
  useEffect(() => {
    if (!fid) {
      return;
    }
    loadAppKey(fid).then((keyHex) => {
      if (keyHex) {
        // The seed phrase is never stored; the app key is, and this is how it
        // comes back after a reload.
        appKeyFromPrivateKeyHex(keyHex).then(setAppKey);
      }
    });
  }, [fid]);

  // Restore the view-layer preferences (client filter + your client labels).
  useEffect(() => {
    if (!fid) {
      return;
    }
    Promise.all([loadFilterPolicy(fid), loadClientLabels(fid)]).then(
      ([policy, labels]) => {
        setFilterPolicy(policy);
        setClientLabels(labels);
      },
    );
  }, [fid]);

  // Fetch node health
  const refreshHealth = useCallback(async () => {
    if (!node) {
      setNodeHealth({
        ok: false,
        baseUrl: resolveNodeBaseUrl(),
        latencyMs: 0,
        error: 'No node client configured',
      });
      setHealthLoading(false);
      return;
    }

    setHealthLoading(true);
    try {
      const health = await node.health();
      setNodeHealth({
        ok: health.ok,
        baseUrl: health.baseUrl,
        latencyMs: health.latencyMs,
        version: health.info?.version,
        numShards: health.info?.numShards,
        maxHeight: health.info?.shardInfos?.[0]?.maxHeight,
        error: health.error,
      });
    } catch (err) {
      setNodeHealth({
        ok: false,
        baseUrl: node.baseUrl,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    setHealthLoading(false);
  }, [node]);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  // Fetch signer state when we have an app key
  useEffect(() => {
    if (!node || !fid || !appKey) {
      return;
    }

    fetchSignerState({ node, fid, publicKeyHex: appKey.publicKeyHex }).then(
      (state) => {
        const hasKey = !!state.signer;
        setSignerState({
          hasKey,
          gaslessSignerCount: state.gaslessSignerCount,
          gaslessSignerLimit: state.gaslessSignerLimit,
          currentUserNonce: state.currentUserNonce,
          signer: state.signer,
        });
      },
    );
  }, [node, fid, appKey]);

  // Fetch feed
  const refreshFeed = useCallback(async () => {
    if (!node || !fid) {
      return;
    }

    setFeedLoading(true);
    setFeedEmpty(false);

    try {
      // First try the following feed
      const followingFeed = await fetchFollowingFeed({
        node,
        fid,
        limit: 25,
        includeSelf: true,
      });

      if (followingFeed.length === 0) {
        // Fall back to own casts
        const ownCasts = await fetchCastsByFid({ node, fid, limit: 25 });
        setCasts(
          ownCasts.map((cast) => ({
            cast: {
              fid: cast.fid,
              hash: cast.hash,
              signer: cast.signer,
              timestamp: cast.timestamp,
              timestampMs: cast.timestampMs,
              castAdd: cast.castAdd,
            },
          })),
        );
        setFeedEmpty(true);
      } else {
        // Resolve client identities. `knownClients` is the map of labels the
        // reader gave to other clients; unlabelled app FIDs stay anonymous.
        const resolver = new CastClientResolver({
          node,
          selfAppFid: fid,
          knownClients: toKnownClients(clientLabels),
        });

        const resolved = await resolver.resolveAll(
          followingFeed.map((c) => ({
            fid: c.fid,
            signer: c.signer,
          })),
        );

        const castsWithClients = followingFeed.map((cast) => ({
          cast: {
            fid: cast.fid,
            hash: cast.hash,
            signer: cast.signer,
            timestamp: cast.timestamp,
            timestampMs: cast.timestampMs,
            castAdd: cast.castAdd,
          },
          client: resolved.get(cast.signer.toLowerCase()),
        }));

        // Count clients for filter UI
        const counts = new Map<string, { label: string; count: number }>();
        castsWithClients.forEach(({ client }) => {
          if (client) {
            const existing = counts.get(client.id);
            if (existing) {
              existing.count++;
            } else {
              counts.set(client.id, { label: client.label, count: 1 });
            }
          }
        });
        setClientCounts(counts);

        // Apply filter
        if (filterPolicy.mode !== 'all' && filterPolicy.clientIds.length > 0) {
          const filtered = filterCastsByClient({
            messages: followingFeed,
            clients: resolved,
            policy: filterPolicy,
          });
          const filteredSet = new Set(
            filtered.map((f) => `${f.fid}:${f.hash}`),
          );
          setCasts(
            castsWithClients
              .filter((c) => filteredSet.has(`${c.cast.fid}:${c.cast.hash}`))
              .map((c) => ({
                cast: {
                  fid: c.cast.fid,
                  hash: c.cast.hash,
                  signer: c.cast.signer,
                  timestamp: c.cast.timestamp,
                  timestampMs: c.cast.timestampMs,
                  castAdd: c.cast.castAdd,
                },
                client: c.client,
              })),
          );
        } else {
          setCasts(castsWithClients);
        }
      }
    } catch (error) {
      // One unreachable read must not empty the page: surface it and stop.
      trackError(nodeError('Failed to load node feed', error));
    }

    setFeedLoading(false);
  }, [node, fid, filterPolicy, clientLabels]);

  useEffect(() => {
    refreshFeed();
  }, [refreshFeed]);

  // Handle issuing a new app key
  const handleIssueKey = useCallback(
    async (mnemonic: string) => {
      if (!node || !fid) {
        return;
      }

      setIssueLoading(true);
      setPostError(null);

      try {
        // Derive custody account from mnemonic
        const custodyAccount = mnemonicToAccount(mnemonic);

        // Generate a new app key
        const newKey = await generateAppKey();

        // Issue the key through the node
        // First get the current nonce so we can compute the next one
        const nodeSignerState = await fetchSignerState({ node, fid });
        const nextNonce = nodeSignerState.currentUserNonce + 1;

        const result = await issueAppKey({
          node,
          fid,
          appKey: newKey,
          custodyAccount,
          nonce: nextNonce,
          onStep: setIssueStep,
        });

        // Save the key - convert private key Uint8Array to hex
        const privateKeyHex = bytesToHex(newKey.privateKey);
        await saveAppKey(fid, privateKeyHex);
        await saveAppNonce(fid, result.userId.nonce + 1);

        setAppKey(newKey);
        setSignerState({
          hasKey: true,
          gaslessSignerCount: nodeSignerState?.gaslessSignerCount ?? 1,
          gaslessSignerLimit: nodeSignerState?.gaslessSignerLimit ?? 1000,
          currentUserNonce: result.userId.nonce,
          signer: result.signer,
        });

        setShowSeedPhraseModal(false);
      } catch (err) {
        setPostError(err instanceof Error ? err.message : String(err));
      }

      setIssueLoading(false);
      setIssueStep(null);
    },
    [node, fid],
  );

  // Handle revoking the app key
  const handleRevokeKey = useCallback(async () => {
    if (!node || !fid || !appKey) {
      return;
    }

    setIssueLoading(true);
    setPostError(null);

    try {
      const nonce = await loadAppNonce(fid);
      await revokeAppKey({
        node,
        fid,
        appKey,
        nonce,
      });

      await clearAppKey(fid);
      setAppKey(null);
      setSignerState(null);
    } catch (err) {
      setPostError(err instanceof Error ? err.message : String(err));
    }

    setIssueLoading(false);
  }, [node, fid, appKey]);

  // Handle posting a cast
  const handlePostCast = useCallback(
    async (text: string) => {
      if (!node || !fid || !appKey) {
        return;
      }

      setPostError(null);
      setPostSuccess(null);

      try {
        const built = await buildCastAddMessage({
          fid,
          signerPrivateKey: appKey.privateKey,
          text,
        });

        const accepted = await node.submitMessage(built.bytes);
        const confirmed = await node.confirmMessage({
          fid,
          hash: accepted.hash,
        });

        if (confirmed) {
          setPostSuccess('Cast stored on the node');
          refreshFeed();
        } else {
          setPostSuccess('Accepted for relay (not yet stored)');
        }
      } catch (err) {
        const error = err as { nodeError?: string; nodeErrorDetail?: string };
        setPostError(
          error.nodeError ||
            error.nodeErrorDetail ||
            (err instanceof Error ? err.message : String(err)),
        );
      }
    },
    [node, fid, appKey, refreshFeed],
  );

  // Handle reaction
  const handleReaction = useCallback(
    async (
      castFid: number,
      castHash: string,
      reactionType: 'like' | 'recast',
      remove: boolean,
    ) => {
      if (!node || !fid || !appKey) {
        return;
      }

      try {
        const built = remove
          ? await buildReactionRemoveMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              reactionType,
              targetCastId: { fid: castFid, hash: castHash },
            })
          : await buildReactionAddMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              reactionType,
              targetCastId: { fid: castFid, hash: castHash },
            });

        await node.submitMessage(built.bytes);
        setActionError(null);
        refreshFeed();
      } catch (error) {
        const message = nodeError('Failed to react through the node', error);
        trackError(message);
        setActionError(message.message);
      }
    },
    [node, fid, appKey, refreshFeed],
  );

  // Handle follow
  const handleFollow = useCallback(
    async (targetFid: number, remove: boolean) => {
      if (!node || !fid || !appKey) {
        return;
      }

      try {
        const built = remove
          ? await buildLinkRemoveMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              targetFid,
            })
          : await buildLinkAddMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              targetFid,
            });

        await node.submitMessage(built.bytes);
        setActionError(null);
        refreshFeed();
      } catch (error) {
        const message = nodeError('Failed to follow through the node', error);
        trackError(message);
        setActionError(message.message);
      }
    },
    [node, fid, appKey, refreshFeed],
  );

  // Handle filter change. The policy is view-layer preference, so it is stored
  // per FID and reapplied on reload; `refreshFeed` re-runs from the changed
  // state via its own effect, so no manual re-fetch is needed here.
  const handleFilterChange = useCallback(
    (mode: ClientFilterMode, clientIds: string[]) => {
      const next: ClientFilterPolicy = { mode, clientIds };
      setFilterPolicy(next);
      if (fid) {
        saveFilterPolicy(fid, next).catch(() => {
          // Storage failing must not block filtering for this session.
        });
      }
    },
    [fid],
  );

  // Name (or un-name) another client. Labels are the reader's, never invented.
  const handleLabelClient = useCallback(
    (clientId: string, label: string) => {
      setClientLabels((current) => {
        const next = withClientLabel(current, clientId, label);
        if (fid) {
          saveClientLabels(fid, next).catch(() => {});
        }
        return next;
      });
    },
    [fid],
  );

  if (!fid) {
    return (
      <Page meta={{ title: 'Your own setup (Advanced) / Fiddy' }}>
        <div className="border-default sm:border-x">
          <PageHeader hideCastButton>
            <div className="flex items-center gap-2">
              <PageTitle>Your own setup</PageTitle>
              <span className="rounded-full border border-[rgba(255,255,255,0.09)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                Advanced
              </span>
            </div>
          </PageHeader>
        </div>
        <BorderedMainContent className="flex flex-row">
          <SettingsNav />
          <SettingsPageContent>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <span className="text-lg font-semibold">No account</span>
              <span className="text-sm text-muted">
                Sign in to use the setup you run
              </span>
            </div>
          </SettingsPageContent>
        </BorderedMainContent>
      </Page>
    );
  }

  return (
    <Page meta={{ title: 'Your own setup (Advanced) / Fiddy' }}>
      <div className="border-default sm:border-x">
        <PageHeader hideCastButton>
          <div className="flex items-center gap-2">
            <PageTitle>Your own setup</PageTitle>
            <span className="rounded-full border border-[rgba(255,255,255,0.09)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              Advanced
            </span>
          </div>
        </PageHeader>
      </div>
      <BorderedMainContent className="flex flex-row">
        <SettingsNav />
        <SettingsPageContent>
          <div className="flex flex-col gap-6">
            {/* Plain words first: nothing on this screen is needed to use
                Fiddy, and the precise words below are the ones you configure. */}
            <p className="text-sm text-muted">
              This is the Advanced part. Point Fiddy at the server you run and
              everything you read and write goes through it — the rest of Fiddy
              works without it, and nothing here is needed to get started.
            </p>

            {/* Node Status Card */}
            <NodeStatusCard
              health={nodeHealth}
              loading={healthLoading}
              onRefresh={refreshHealth}
            />

            {/* App Key Card */}
            <AppKeyCard
              signer={signerState?.signer}
              publicKeyHex={appKey?.publicKeyHex}
              gaslessSignerCount={signerState?.gaslessSignerCount ?? 0}
              gaslessSignerLimit={signerState?.gaslessSignerLimit ?? 1000}
              currentUserNonce={signerState?.currentUserNonce ?? 0}
              loading={issueLoading}
              issueStep={issueStep}
              error={postError}
              onIssue={() => setShowSeedPhraseModal(true)}
              onRevoke={handleRevokeKey}
            />

            {/* Composer */}
            <NodeComposer
              disabled={!appKey}
              disabledMessage={
                !appKey
                  ? 'Issue an app key first to post casts through your own setup'
                  : undefined
              }
              onPost={handlePostCast}
              success={postSuccess}
              error={postError}
            />

            {/* Feed. `actionError` covers the react/follow writes, which have
                no optimistic UI of their own. */}
            {actionError && (
              <div
                className="rounded border p-2 text-xs bg-tertiary border-default text-danger"
                role="alert"
              >
                {actionError}
              </div>
            )}
            <NodeFeed
              casts={casts}
              loading={feedLoading}
              isFallback={feedEmpty}
              onRefresh={refreshFeed}
              onReact={handleReaction}
              onFollow={handleFollow}
            />

            {/* Client Filter */}
            <ClientFilterCard
              policy={filterPolicy}
              clientCounts={clientCounts}
              clientLabels={clientLabels}
              onChange={handleFilterChange}
              onLabelClient={handleLabelClient}
            />
          </div>
        </SettingsPageContent>
      </BorderedMainContent>

      {/* Seed Phrase Warning Modal */}
      {showSeedPhraseModal && (
        <SeedPhraseWarningModal
          onClose={() => setShowSeedPhraseModal(false)}
          onConfirm={handleIssueKey}
          loading={issueLoading}
        />
      )}
    </Page>
  );
});

SettingsNodePage.displayName = 'SettingsNodePage';

export { SettingsNodePage };
