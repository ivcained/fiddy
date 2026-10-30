import React from 'react';

import {
  disableDraftSync,
  type DraftSyncState,
  enableDraftSync,
  getDraftSyncState,
  recoverDraftSync,
  scheduleDraftSync,
} from '~/lib/sealedDrafts/sync';

export const DraftSyncPanel: React.FC<{ fid: number }> = ({ fid }) => {
  const [state, setState] = React.useState<DraftSyncState>(() =>
    getDraftSyncState(window.localStorage, fid),
  );
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [recoveryInput, setRecoveryInput] = React.useState('');
  const [showRecovery, setShowRecovery] = React.useState(false);

  React.useEffect(() => {
    const update = () => setState(getDraftSyncState(window.localStorage, fid));
    update();
    window.addEventListener('fiddy:draft-sync-state', update);
    window.addEventListener('fiddy:sealed-drafts-changed', update);
    return () => {
      window.removeEventListener('fiddy:draft-sync-state', update);
      window.removeEventListener('fiddy:sealed-drafts-changed', update);
    };
  }, [fid]);

  const enroll = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await enableDraftSync(window.localStorage, fid);
      setRecoveryCode(result.recoveryCode);
      setAsking(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Sync could not be turned on. Your drafts are still on this device.',
      );
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    setBusy(true);
    setError('');
    try {
      await recoverDraftSync(window.localStorage, fid, recoveryInput);
      setRecoveryInput('');
      setShowRecovery(false);
    } catch {
      setError(
        'That recovery code could not open these drafts. Check it and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!state.available) {
    return (
      <p
        className="px-2 pb-2 text-sm text-faint"
        data-fiddy="drafts-device-only"
      >
        Drafts stay on this device.
      </p>
    );
  }

  return (
    <section
      className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border p-3 text-sm border-default"
      data-fiddy="draft-sync"
    >
      {recoveryCode ? (
        <div className="flex flex-col gap-2" data-fiddy="draft-recovery-code">
          <p className="text-default">
            Save this recovery code somewhere private. It is the only way to
            open your locked drafts on another device.
          </p>
          <code className="select-all break-all rounded p-2 text-xs bg-overlay-light">
            {recoveryCode}
          </code>
          <button
            type="button"
            className="self-start rounded-md border px-3 py-2 border-default"
            onClick={() => void navigator.clipboard.writeText(recoveryCode)}
          >
            Copy recovery code
          </button>
        </div>
      ) : (
        <>
          <p className="text-faint" data-fiddy="draft-sync-status">
            {state.lockedCount > 0
              ? `${state.lockedCount} synced ${state.lockedCount === 1 ? 'draft is' : 'drafts are'} locked with another key. Enter their recovery code to open them.`
              : state.status === 'error'
                ? 'Sync did not finish. Your drafts are safe on this device.'
                : state.enabled
                  ? 'Locked sync is on. Fiddy cannot read these drafts.'
                  : 'Drafts stay on this device unless you turn on locked sync.'}
          </p>
          {state.enabled ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-2 border-default"
                disabled={busy || state.status === 'syncing'}
                onClick={() => scheduleDraftSync(window.localStorage, fid)}
                data-fiddy="draft-sync-now"
              >
                {state.status === 'syncing' ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-2 border-default"
                onClick={() => disableDraftSync(window.localStorage, fid)}
              >
                Turn off sync
              </button>
            </div>
          ) : asking ? (
            <div className="flex flex-col gap-2">
              <p className="text-default">
                Keep a locked copy on Fiddy so you can open it on your other
                devices. Fiddy cannot read it.
              </p>
              <button
                type="button"
                className="self-start rounded-md bg-accent px-3 py-2 text-accent-foreground"
                disabled={busy}
                onClick={() => void enroll()}
                data-fiddy="draft-sync-enroll"
              >
                {busy ? 'Turning on…' : 'Turn on locked sync'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="self-start rounded-md border px-3 py-2 border-default"
              onClick={() => setAsking(true)}
              data-fiddy="draft-sync-offer"
            >
              Sync my drafts
            </button>
          )}
          <button
            type="button"
            className="self-start text-left underline text-faint"
            onClick={() => setShowRecovery((current) => !current)}
          >
            Have a recovery code?
          </button>
          {showRecovery && (
            <div className="flex flex-col gap-2">
              <input
                value={recoveryInput}
                onChange={(event) => setRecoveryInput(event.target.value)}
                placeholder="Paste your recovery code"
                aria-label="Draft recovery code"
                className="w-full rounded-md border p-2 bg-app border-default"
                data-fiddy="draft-recovery-input"
              />
              <button
                type="button"
                className="self-start rounded-md border px-3 py-2 border-default"
                disabled={busy || !recoveryInput.trim()}
                onClick={() => void recover()}
                data-fiddy="draft-recover"
              >
                Open synced drafts
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-danger" data-fiddy="draft-sync-error">
          {error}
        </p>
      )}
    </section>
  );
};
