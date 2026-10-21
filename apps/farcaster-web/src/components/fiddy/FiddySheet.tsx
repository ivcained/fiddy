/**
 * One screen, one idea.
 *
 * Every Fiddy setup screen is this shape: the mark, where you are, one
 * sentence of headline, one short paragraph, whatever the step needs, exactly
 * one primary action, and one quiet way out. The rules the copy follows are in
 * the positioning brief — no infrastructure words anywhere on these screens.
 *
 * The same component is used by the onboarding flow and by the two sheets you
 * can reopen later, so a screen cannot drift into a second visual language.
 */

import React, { memo, ReactNode, RefObject } from 'react';

import { FiddyEgg } from '~/components/fiddy/FiddyEgg';

export interface FiddySheetAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface FiddySheetProps {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  primary?: FiddySheetAction | null;
  /**
   * Draw the primary action as the thing that just became the point of the
   * screen. Set only when something the visitor did has earned it — a filled-in
   * field, a first reply from their agent — never on arrival, because a button
   * that is loud before anything happened says nothing.
   */
  primaryHighlight?: boolean;
  /** The quiet way out: a plain text button, never a second loud one. */
  quiet?: FiddySheetAction | null;
  /** Small honest print under the actions. */
  note?: ReactNode;
  /** Mascot presence: a hero egg, a small one, or none. */
  egg?: 'hero' | 'small' | 'none';
  /** "Step 2 of 4" — omitted on the first and last screens. */
  step?: { index: number; total: number } | null;
  /** Identifies the screen for verification and for tests. */
  name?: string;
  wide?: boolean;
  /** The heading takes focus when a step becomes the current screen. */
  titleRef?: RefObject<HTMLHeadingElement | null>;
}

export const FiddySheet = memo<FiddySheetProps>(
  ({
    title,
    sub,
    children,
    primary = null,
    primaryHighlight = false,
    quiet = null,
    note = null,
    egg = 'none',
    step = null,
    name,
    wide = false,
    titleRef,
  }) => (
    <div
      className="fiddy-sheet"
      data-fiddy="sheet"
      data-fiddy-step={name ?? undefined}
    >
      <div className="fiddy-sheet-top">
        <img
          src="/brand/fiddy-logo-dark.png"
          alt="fiddy"
          className="fiddy-sheet-mark"
          width={1600}
          height={439}
        />
        {step ? (
          <span className="fiddy-step-count" data-fiddy="step-count">
            Step {step.index} of {step.total}
          </span>
        ) : (
          <span />
        )}
      </div>

      <div
        className={`fiddy-sheet-body ${wide ? 'fiddy-sheet-body-wide' : ''}`}
      >
        {egg === 'hero' ? <FiddyEgg size={112} /> : null}
        {egg === 'small' ? <FiddyEgg size={76} /> : null}

        <h1 className="fiddy-sheet-title" ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
        {sub ? <p className="fiddy-sheet-sub">{sub}</p> : null}

        {children ? (
          <div className="fiddy-sheet-content">{children}</div>
        ) : null}

        {primary || quiet ? (
          <div className="fiddy-sheet-actions">
            {primary ? (
              <button
                type="button"
                className={`fiddy-primary-btn ${primaryHighlight ? 'fiddy-primary-btn-hot' : ''}`}
                data-highlighted={primaryHighlight ? 'true' : undefined}
                onClick={primary.onClick}
                disabled={primary.disabled}
              >
                {primary.label}
              </button>
            ) : null}
            {quiet ? (
              <button
                type="button"
                className="fiddy-quiet-btn"
                onClick={quiet.onClick}
                disabled={quiet.disabled}
              >
                {quiet.label}
              </button>
            ) : null}
          </div>
        ) : null}

        {note ? <p className="fiddy-sheet-note">{note}</p> : null}
      </div>
    </div>
  ),
);

FiddySheet.displayName = 'FiddySheet';
