/**
 * The composer's over-limit offer row: what a person sees when the cast they
 * are writing is too long to send.
 *
 * This component is deliberately DUMB. It draws one row in four shapes —
 * the offer, the wait, the ask, the failure — and reports presses. Whether
 * the offer may appear at all (top-level casts only), who answers it, and
 * what happens to the text on Replace are the composer's decisions
 * (`Composer.tsx`); none of that lives here.
 *
 * The interaction shape is ported from backmeupplz/quilcast 0.115.0 (MIT):
 * the row sits where the composer can see it, a destructive confirm is a
 * button IN the row (never a native `confirm()`, which shows nothing inside
 * the app shell), and the confirm carries a short `fresh` guard so the click
 * that opened the question — a double click, a quick second tap — cannot
 * also answer it.
 */

import React from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';

export type ComposerLengthOfferPhase =
  | { kind: 'offer' }
  | { kind: 'busy'; action: 'tighten' | 'split' }
  | {
      kind: 'ask';
      action: 'tighten' | 'split';
      /** The sentence the ask shows, e.g. "Fiddy split your cast into 3." */
      detail: string;
      confirmLabel: string;
    }
  | { kind: 'error'; sentence: string };

export interface ComposerLengthOfferProps {
  phase: ComposerLengthOfferPhase;
  /**
   * True during the short window after the ask appears: the confirm button
   * renders disabled, so the press that opened the question cannot answer it.
   */
  fresh: boolean;
  onTighten: () => void;
  onSplit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** After a failure: back to the offer, text untouched. */
  onRetry: () => void;
}

const BUSY_SENTENCE: Record<'tighten' | 'split', string> = {
  tighten: 'Fiddy is tightening it…',
  split: 'Fiddy is finding the breaks…',
};

const ComposerLengthOffer: React.FC<ComposerLengthOfferProps> = ({
  phase,
  fresh,
  onTighten,
  onSplit,
  onConfirm,
  onCancel,
  onRetry,
}) => {
  return (
    <div
      data-fiddy="length-offer"
      className="flex flex-row flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-sm border-default"
    >
      {phase.kind === 'offer' && (
        <>
          <span className="text-muted">
            This is too long for one cast. Fiddy can tighten it, or split it
            into a thread.
          </span>
          <DefaultButton
            size="sm"
            variant="muted"
            data-fiddy="length-offer-tighten"
            onClick={onTighten}
          >
            Tighten it
          </DefaultButton>
          <DefaultButton
            size="sm"
            variant="muted"
            data-fiddy="length-offer-split"
            onClick={onSplit}
          >
            Split it into a thread
          </DefaultButton>
        </>
      )}

      {phase.kind === 'busy' && (
        <span
          data-fiddy="length-offer-status"
          role="status"
          className="text-muted"
        >
          {BUSY_SENTENCE[phase.action]}
        </span>
      )}

      {phase.kind === 'ask' && (
        <>
          <span data-fiddy="length-offer-ask">{phase.detail}</span>
          <DefaultButton
            size="sm"
            variant="link"
            data-fiddy="length-offer-cancel"
            onClick={onCancel}
          >
            Cancel
          </DefaultButton>
          <DefaultButton
            size="sm"
            data-fiddy="length-offer-confirm"
            disabled={fresh}
            onClick={onConfirm}
          >
            {phase.confirmLabel}
          </DefaultButton>
        </>
      )}

      {phase.kind === 'error' && (
        <>
          <span
            data-fiddy="length-offer-error"
            role="alert"
            className="text-danger"
          >
            {phase.sentence}
          </span>
          <DefaultButton
            size="sm"
            variant="link"
            data-fiddy="length-offer-retry"
            onClick={onRetry}
          >
            Try again
          </DefaultButton>
        </>
      )}
    </div>
  );
};

export { ComposerLengthOffer };
