/**
 * TipSheet: what holding Like does the first time. Rendered via portal.
 *
 * The first full hold in this browser explains itself here and sends nothing
 * unless the person taps Tip; after that, holds tip at once. The sheet and
 * Settings share one switch for the whole thing: off, holding Like works like
 * a tap.
 *
 * Borrowed from quilcast (MIT)
 *   src/ui.tsx (TipSheet) / commit 700d8b78d8c7
 */

import { FC, memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { modalRootId } from '~/constants/modals';
import { holdTip, setHoldTip, tipSheet } from '~/lib/tipask';

type Q = { from: string; to: string } | null;

const TipSheet: FC = memo(() => {
  const [q, setQ] = useState<Q>(null);
  const [on, setOn] = useState(true);
  const done = useRef<((ok: boolean) => void) | undefined>(undefined);
  // Focus starts on Cancel; Enter alone never tips.
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Whether the pointer is still down inside the sheet (the hold's finger
  // may still be on the Like button under the modal).
  const armed = useRef(false);

  tipSheet.ask = (o) =>
    new Promise((d) => {
      done.current?.(false);
      done.current = d;
      armed.current = false;
      setOn(holdTip());
      setQ({ from: o.from, to: o.to });
    });

  useEffect(() => {
    if (q) {
      cancelRef.current?.focus();
    }
  }, [q]);

  if (!q) {
    return null;
  }

  const close = (ok: boolean) => {
    const d = done.current;
    done.current = undefined;
    setQ(null);
    d?.(ok);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => e.target === e.currentTarget && close(false)}
      onPointerDown={() => {
        armed.current = true;
      }}
      role="presentation"
    >
      <div
        className="mx-4 w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-900"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tip-sheet-h"
        tabIndex={-1}
      >
        <h2
          id="tip-sheet-h"
          className="mb-2 text-lg font-semibold text-gray-900 dark:text-white"
        >
          Tip @{q.to} $1?
        </h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Holding Like on someone's cast tips its author $1: 1 USDC on Base from{' '}
          {q.from}, straight to their wallet. Gas costs a little ETH on Base.
        </p>

        <div className="mb-4 flex items-center justify-between rounded-lg bg-gray-100 p-3 dark:bg-gray-800">
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            Hold Like to tip
          </span>
          <button
            type="button"
            className={`rounded-full px-4 py-1 text-sm font-medium transition-colors ${
              on
                ? 'bg-fiddy text-white'
                : 'bg-gray-300 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
            }`}
            onClick={() => {
              setHoldTip(!on);
              setOn(!on);
            }}
            aria-pressed={on}
          >
            {on ? 'On' : 'Off'}
          </button>
        </div>
        <p className="mb-6 text-xs text-gray-500 dark:text-gray-400">
          A tap still just likes. You can change this any time in Settings{' '}
          {'\u2192'} Wallets.
        </p>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            ref={cancelRef}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            onClick={() => close(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!on}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
              on
                ? 'bg-fiddy hover:opacity-90'
                : 'cursor-not-allowed bg-gray-400 dark:bg-gray-700'
            }`}
            onClick={(e) => {
              // Only tip if the pointer was pressed inside the sheet (not a
              // leftover click from the hold's release).
              if (!e.detail || armed.current) {
                close(true);
              }
            }}
          >
            Tip $1
          </button>
        </div>
      </div>
    </div>,
    document.getElementById(modalRootId)!,
  );
});

TipSheet.displayName = 'TipSheet';

export { TipSheet };
