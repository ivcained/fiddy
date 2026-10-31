import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { SettingsPageContent } from '~/components/page/SettingsPageContent';
import { useAuth } from '~/contexts/AuthProvider';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { SettingsNav } from '~/layouts/SettingsNav';
import { formatUsd, parseFundingBalance } from '~/lib/fiddyCredit';
import { ensureOwnerSession } from '~/lib/fiddyOwnerSession';
import {
  deleteServerData,
  type Erased,
  eraseFarcasterAccount,
  eraseNodeClient,
  resolveEraseNode,
  serverPurgeAvailable,
  type ServerPurgeResult,
} from '~/snapchain/accountErase';
import { loadAppKey } from '~/snapchain/appKeyStorage';

/**
 * Settings → Delete account.
 *
 * Adapted from quilcast's delete flow (backmeupplz/quilcast, commits
 * dc5bf769923c + 8aba47042319, MIT), in Fiddy's own words: one idea per
 * screen, the destructive button arms only after the person says they
 * understand, and every number on the last screen really happened (a thing
 * the network would not forget is counted and said, never smoothed over).
 *
 * The order matters: Fiddy's own data goes FIRST, because the service reads
 * the account's casts to find the photos it should delete; then the posts,
 * likes, follows and profile go from Farcaster itself.
 */

type Stage =
  | { name: 'intro' }
  | { name: 'balance'; availableUsdc: string }
  | { name: 'arm' }
  | { name: 'running' }
  | { name: 'done'; server: ServerPurgeResult | null; erased: Erased }
  | { name: 'blocked'; reason: string }
  | { name: 'failed'; reason: string };

type StepLine = {
  step: 'server' | 'find' | 'casts' | 'reactions' | 'follows' | 'profile';
  done: number;
  total: number;
};

/** The words each step gets. No jargon: nobody deletes their "link graph". */
const STEP_WORDS: Record<StepLine['step'], string> = {
  server: 'What Fiddy itself keeps (drafts, photos, your posting key)',
  find: 'Reading what your account has',
  casts: 'Your posts',
  reactions: 'Your likes and recasts',
  follows: 'Your follows',
  profile: 'Your profile',
};

const SettingsDeleteAccountPage = memo(() => {
  const { fid } = useCurrentUser();
  const { signOut } = useAuth();
  const [stage, setStage] = useState<Stage>({ name: 'intro' });
  const [armed, setArmed] = useState(false);
  const [balanceArmed, setBalanceArmed] = useState(false);
  const [lines, setLines] = useState<StepLine[]>([]);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const note = (step: StepLine['step'], done: number, total: number) => {
    if (cancelled.current) {
      return;
    }
    setLines((previous) => [
      ...previous.filter((line) => line.step !== step),
      { step, done, total },
    ]);
  };

  /** From the intro: can this device actually do this, and is there a balance to talk about first? */
  const begin = useCallback(async () => {
    const appKeyHex = await loadAppKey(fid);
    if (!appKeyHex) {
      setStage({
        name: 'blocked',
        reason:
          'This device holds no posting key for your account, so it cannot remove your posts. Open Your own setup in Settings and press "Issue app key" once, then come back here.',
      });
      return;
    }
    const target = resolveEraseNode();
    if ('refusal' in target) {
      setStage({ name: 'blocked', reason: target.refusal });
      return;
    }
    if (!serverPurgeAvailable()) {
      // A self-hosted copy keeps no server data for you; only the network half runs.
      setStage({ name: 'arm' });
      return;
    }
    try {
      const session = await ensureOwnerSession(fid);
      const response = await fetch('/api/fiddy/funding/balance', {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${session.token}`,
        },
      });
      const balance = parseFundingBalance(await response.json());
      if (BigInt(balance.credit.availableBaseUnits) > 0n) {
        setStage({
          name: 'balance',
          availableUsdc: balance.credit.availableUsdc,
        });
        return;
      }
      setStage({ name: 'arm' });
    } catch (error) {
      setStage({
        name: 'blocked',
        reason:
          error instanceof Error && error.message.length > 0
            ? error.message
            : 'Fiddy could not check your balance just now. Nothing was deleted — try again in a moment.',
      });
    }
  }, [fid]);

  const run = useCallback(async () => {
    // Reset per run: StrictMode's dev-only mount/unmount cycle fires the
    // cleanup once at mount, which would otherwise poison this flag forever
    // and leave every run stuck on "Deleting…".
    cancelled.current = false;
    setStage({ name: 'running' });
    setLines([]);
    try {
      let server: ServerPurgeResult | null = null;
      if (serverPurgeAvailable()) {
        note('server', 0, 0);
        const session = await ensureOwnerSession(fid);
        server = await deleteServerData({ fid, token: session.token });
        note('server', 1, 1);
      }
      const appKeyHex = await loadAppKey(fid);
      const target = resolveEraseNode();
      if (!appKeyHex || 'refusal' in target) {
        throw new Error(
          'refusal' in target
            ? target.refusal
            : 'This device no longer holds a posting key for your account.',
        );
      }
      const erased = await eraseFarcasterAccount({
        fid,
        appKeyHex,
        node: eraseNodeClient(target),
        onProgress: note,
      });
      if (cancelled.current) {
        return;
      }
      setStage({ name: 'done', server, erased });
    } catch (error) {
      if (cancelled.current) {
        return;
      }
      setStage({
        name: 'failed',
        reason:
          error instanceof Error
            ? error.message
            : 'Something stopped the deletion partway. Nothing was pretended away — press Try again and it picks up where it left off.',
      });
    }
  }, [fid]);

  return (
    <Page meta={{ title: 'Delete Account / Settings' }}>
      <>
        <div className="border-default sm:border-x">
          <PageHeader hideCastButton>
            <PageTitle>Settings</PageTitle>
          </PageHeader>
        </div>
        <BorderedMainContent className="flex flex-row">
          <SettingsNav />
          <SettingsPageContent>
            <div
              className="flex max-w-lg flex-col gap-4"
              data-fiddy="delete-account-page"
            >
              {stage.name === 'intro' && (
                <>
                  <h2
                    className="text-lg font-semibold"
                    data-fiddy="delete-account-intro"
                  >
                    Delete your account?
                  </h2>
                  <p>
                    This removes your posts, likes, recasts and follows, and
                    clears your profile — and it removes what Fiddy itself keeps
                    for you: your drafts and the photos and clips you uploaded
                    here.
                  </p>
                  <p>
                    It cannot be undone. And one honest thing: Farcaster is a
                    public network, so deleting asks every server that keeps a
                    copy to forget it. Most do; Fiddy can only vouch for itself.
                  </p>
                  <div className="flex flex-row gap-2">
                    <DefaultButton
                      variant="muted"
                      onClick={() => window.history.back()}
                      data-fiddy="delete-account-cancel"
                    >
                      Keep my account
                    </DefaultButton>
                    <DefaultButton
                      variant="danger"
                      onClick={() => void begin()}
                      data-fiddy="delete-account-continue"
                    >
                      Continue
                    </DefaultButton>
                  </div>
                </>
              )}

              {stage.name === 'balance' && (
                <>
                  <h2
                    className="text-lg font-semibold"
                    data-fiddy="delete-account-balance"
                  >
                    You have {formatUsd(stage.availableUsdc)} left
                  </h2>
                  <p>
                    Your Fiddy balance is a payment record, so deleting your
                    account does not delete it — it stays on the books. If you
                    want to use it or sort it out first, do that from Wallet
                    before you delete.
                  </p>
                  <label
                    className="flex cursor-pointer flex-row items-start gap-2"
                    data-fiddy="delete-account-balance-ack"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={balanceArmed}
                      onChange={(event) =>
                        setBalanceArmed(event.target.checked)
                      }
                    />
                    <span>I understand my balance stays behind.</span>
                  </label>
                  <div className="flex flex-row gap-2">
                    <DefaultButton
                      variant="muted"
                      onClick={() => setStage({ name: 'intro' })}
                    >
                      Back
                    </DefaultButton>
                    <DefaultButton
                      variant="danger"
                      disabled={!balanceArmed}
                      onClick={() => setStage({ name: 'arm' })}
                      data-fiddy="delete-account-balance-continue"
                    >
                      Continue
                    </DefaultButton>
                  </div>
                </>
              )}

              {stage.name === 'arm' && (
                <>
                  <h2
                    className="text-lg font-semibold"
                    data-fiddy="delete-account-arm"
                  >
                    Last step
                  </h2>
                  <p>
                    Once this starts, your posts, likes, follows and profile are
                    removed, and Fiddy forgets your drafts and uploads. There is
                    no undo.
                  </p>
                  <label
                    className="flex cursor-pointer flex-row items-start gap-2"
                    data-fiddy="delete-account-arm-check"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={armed}
                      onChange={(event) => setArmed(event.target.checked)}
                    />
                    <span>I understand this can’t be undone.</span>
                  </label>
                  <div className="flex flex-row gap-2">
                    <DefaultButton
                      variant="muted"
                      onClick={() => setStage({ name: 'intro' })}
                    >
                      Back
                    </DefaultButton>
                    <DefaultButton
                      variant="danger"
                      disabled={!armed}
                      onClick={() => void run()}
                      data-fiddy="delete-account-confirm"
                    >
                      Delete everything
                    </DefaultButton>
                  </div>
                </>
              )}

              {stage.name === 'running' && (
                <>
                  <h2
                    className="text-lg font-semibold"
                    data-fiddy="delete-account-progress"
                  >
                    Deleting…
                  </h2>
                  <p>
                    Stay on this page. It can take a few minutes for a busy
                    account.
                  </p>
                  <ul className="flex flex-col gap-1">
                    {lines.map((line) => (
                      <li
                        key={line.step}
                        data-fiddy={`delete-account-step-${line.step}`}
                      >
                        {STEP_WORDS[line.step]}
                        {line.total > 0
                          ? ` — ${line.done} of ${line.total}`
                          : ''}
                        {line.total > 0 && line.done === line.total ? ' ✓' : ''}
                        {line.step === 'server' && line.done === 1 ? ' ✓' : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {stage.name === 'done' && (
                <>
                  <h2
                    className="text-lg font-semibold"
                    data-fiddy="delete-account-done"
                  >
                    It’s done.
                  </h2>
                  <p>
                    Removed {stage.erased.casts} posts, {stage.erased.reactions}{' '}
                    likes and recasts, {stage.erased.follows} follows, and
                    cleared your profile.
                  </p>
                  {stage.server && (
                    <p data-fiddy="delete-account-server-result">
                      Fiddy forgot {stage.server.drafts} drafts and{' '}
                      {stage.server.media} of your uploads
                      {stage.server.mediaKept > 0
                        ? `; ${stage.server.mediaKept} ${stage.server.mediaKept === 1 ? 'file stays' : 'files stay'} because ${stage.server.mediaKept === 1 ? 'it’s' : 'they’re'} shared with others or ${stage.server.mediaKept === 1 ? 'was' : 'were'} uploaded before we kept track`
                        : ''}
                      .
                    </p>
                  )}
                  {stage.erased.failed > 0 && (
                    <p data-fiddy="delete-account-failed-count">
                      {stage.erased.failed}{' '}
                      {stage.erased.failed === 1 ? 'thing' : 'things'} could not
                      be removed
                      {stage.erased.error ? ` — ${stage.erased.error}` : ''}.
                      Running this again later picks up exactly those.
                    </p>
                  )}
                  <p>You’re signed out next.</p>
                  <DefaultButton
                    variant="normal"
                    onClick={() => void signOut()}
                    data-fiddy="delete-account-finish"
                  >
                    Finish and sign out
                  </DefaultButton>
                </>
              )}

              {stage.name === 'blocked' && (
                <>
                  <h2
                    className="text-lg font-semibold"
                    data-fiddy="delete-account-blocked"
                  >
                    Not from here yet
                  </h2>
                  <p>{stage.reason}</p>
                  <DefaultButton
                    variant="muted"
                    onClick={() => window.history.back()}
                  >
                    Back
                  </DefaultButton>
                </>
              )}

              {stage.name === 'failed' && (
                <>
                  <h2
                    className="text-lg font-semibold"
                    data-fiddy="delete-account-error"
                  >
                    It stopped partway
                  </h2>
                  <p>{stage.reason}</p>
                  <p>
                    What was deleted stays deleted; trying again picks up what
                    is left. Nothing is pretended away.
                  </p>
                  <div className="flex flex-row gap-2">
                    <DefaultButton
                      variant="muted"
                      onClick={() => setStage({ name: 'intro' })}
                    >
                      Back
                    </DefaultButton>
                    <DefaultButton
                      variant="danger"
                      onClick={() => void run()}
                      data-fiddy="delete-account-retry"
                    >
                      Try again
                    </DefaultButton>
                  </div>
                </>
              )}
            </div>
          </SettingsPageContent>
        </BorderedMainContent>
      </>
    </Page>
  );
});

SettingsDeleteAccountPage.displayName = 'SettingsDeleteAccountPage';

export { SettingsDeleteAccountPage };
