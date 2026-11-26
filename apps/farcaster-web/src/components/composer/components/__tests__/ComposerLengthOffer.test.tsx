// @vitest-environment jsdom
/**
 * The over-limit offer row, measured as the dumb component it is: it draws
 * the four shapes, reports presses, and never answers the ask while the
 * click that opened it could still be a double click.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ComposerLengthOffer,
  type ComposerLengthOfferPhase,
} from '~/components/composer/components/ComposerLengthOffer';
const noop = () => {};

const renderOffer = (phase: ComposerLengthOfferPhase) =>
  render(
    <ComposerLengthOffer
      phase={phase}
      fresh={false}
      onTighten={noop}
      onSplit={noop}
      onConfirm={noop}
      onCancel={noop}
      onRetry={noop}
    />,
  );

describe('the offer', () => {
  it('names the dead end and offers both verbs', () => {
    renderOffer({ kind: 'offer' });

    expect(screen.getByText(/This is too long for one cast\./)).toBeTruthy();
    expect(screen.getByText('Tighten it')).toBeTruthy();
    expect(screen.getByText('Split it into a thread')).toBeTruthy();
  });

  it('reports the presses it is asked to report', () => {
    const onTighten = vi.fn();
    const onSplit = vi.fn();
    render(
      <ComposerLengthOffer
        phase={{ kind: 'offer' }}
        fresh={false}
        onTighten={onTighten}
        onSplit={onSplit}
        onConfirm={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );

    screen.getByText('Tighten it').click();
    expect(onTighten).toHaveBeenCalledTimes(1);
    screen.getByText('Split it into a thread').click();
    expect(onSplit).toHaveBeenCalledTimes(1);
  });
});

describe('the wait', () => {
  it('says what Fiddy is doing, with no buttons to press', () => {
    renderOffer({ kind: 'busy', action: 'tighten' });

    expect(screen.getByRole('status').textContent).toBe(
      'Fiddy is tightening it…',
    );
    expect(screen.queryByText('Tighten it')).toBeNull();
  });
});

describe('the ask', () => {
  it('shows the sentence and the confirm, and reports both presses', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ComposerLengthOffer
        phase={{
          kind: 'ask',
          action: 'tighten',
          detail: 'Fiddy made it fit one cast. Replace your text?',
          confirmLabel: 'Replace',
        }}
        fresh={false}
        onTighten={noop}
        onSplit={noop}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onRetry={noop}
      />,
    );

    expect(
      screen.getByText('Fiddy made it fit one cast. Replace your text?'),
    ).toBeTruthy();
    screen.getByText('Replace').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    screen.getByText('Cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the confirm is disabled while fresh, so a double click cannot answer', () => {
    render(
      <ComposerLengthOffer
        phase={{
          kind: 'ask',
          action: 'split',
          detail: 'Fiddy split your cast into 3. Check the breaks.',
          confirmLabel: 'Add to thread',
        }}
        fresh={true}
        onTighten={noop}
        onSplit={noop}
        onConfirm={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );

    const confirm = screen.getByText('Add to thread') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});

describe('the failure', () => {
  it('shows the sentence and offers to try again', () => {
    const onRetry = vi.fn();
    render(
      <ComposerLengthOffer
        phase={{
          kind: 'error',
          sentence:
            'Fiddy could not be reached just now. Your text is unchanged.',
        }}
        fresh={false}
        onTighten={noop}
        onSplit={noop}
        onConfirm={noop}
        onCancel={noop}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert').textContent).toMatch(
      /Your text is unchanged/,
    );
    screen.getByText('Try again').click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('the marker contract the probes rely on', () => {
  it('one data-fiddy marker per control, stable across shapes', async () => {
    const { rerender } = renderOffer({ kind: 'offer' });

    expect(
      document.querySelector('[data-fiddy="length-offer"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-fiddy="length-offer-tighten"]'),
    ).not.toBeNull();

    rerender(
      <ComposerLengthOffer
        phase={{
          kind: 'ask',
          action: 'tighten',
          detail: 'Fiddy made it fit one cast.',
          confirmLabel: 'Replace',
        }}
        fresh={true}
        onTighten={noop}
        onSplit={noop}
        onConfirm={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-fiddy="length-offer-confirm"]'),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-fiddy="length-offer-cancel"]'),
    ).not.toBeNull();
  });
});
