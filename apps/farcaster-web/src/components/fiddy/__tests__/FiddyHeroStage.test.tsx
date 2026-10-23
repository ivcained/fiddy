// @vitest-environment jsdom
/**
 * The hero's promises, held to account in a browser-less test: the still paints
 * first, reduced motion never fetches anything, a model that cannot mount leaves
 * the still in place, the two variants differ in exactly one way (whether the
 * pointer belongs to the model or to the page), and the surface it draws into is
 * disposed rather than leaked.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scene = vi.hoisted(() => ({
  mount: vi.fn(),
}));

vi.mock('~/components/fiddy/fiddyModelScene', () => ({
  mountFiddyModel: scene.mount,
}));

import {
  FIDDY_HERO_PADDING,
  FIDDY_HERO_POSTER,
  FIDDY_HERO_TURN_RADIANS_PER_SECOND,
  heroMotionAllowed,
} from '~/components/fiddy/fiddyHero';
import { FiddyHeroStage } from '~/components/fiddy/FiddyHeroStage';

const setReducedMotion = (matches: boolean) => {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion') ? matches : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
};

const stage = () => document.querySelector('[data-fiddy-hero]');
const still = () => document.querySelector('.fiddy-hero-stage-still');
const dispose = vi.fn();

beforeEach(() => {
  scene.mount.mockReset();
  dispose.mockReset();
  scene.mount.mockResolvedValue({ dispose });
  setReducedMotion(false);
});

afterEach(cleanup);

describe('heroMotionAllowed', () => {
  it('is the same one rule the chrome mark obeys', () => {
    expect(heroMotionAllowed(true)).toBe(false);
    expect(heroMotionAllowed(false)).toBe(true);
    expect(heroMotionAllowed(null)).toBe(true);
  });
});

describe('FiddyHeroStage', () => {
  it('paints the still before anything is fetched', () => {
    render(<FiddyHeroStage />);
    const image = still() as HTMLImageElement;
    expect(image).toBeTruthy();
    expect(image.getAttribute('src')).toBe(FIDDY_HERO_POSTER);
    expect(stage()?.getAttribute('data-fiddy-hero')).toBe('still');
  });

  it('never asks for the model under reduced motion, and still shows Fiddy', async () => {
    setReducedMotion(true);
    render(<FiddyHeroStage />);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(scene.mount).not.toHaveBeenCalled();
    expect(still()).toBeTruthy();
    expect(stage()?.getAttribute('data-fiddy-hero')).toBe('still');
  });

  it('turns the model on for the front door, and off beside a form', async () => {
    const hero = render(<FiddyHeroStage variant="hero" />);
    await waitFor(() => expect(scene.mount).toHaveBeenCalled());
    expect(scene.mount.mock.calls[0][2]).toMatchObject({
      turntable: FIDDY_HERO_TURN_RADIANS_PER_SECOND,
      draggable: true,
      view: [0.34, 0.2, 1],
      padding: FIDDY_HERO_PADDING,
    });
    hero.unmount();

    scene.mount.mockClear();
    render(<FiddyHeroStage variant="form" />);
    await waitFor(() => expect(scene.mount).toHaveBeenCalled());
    // The whole difference between the two: a canvas that eats a tap meant for
    // the name field next to it would be a bug.
    expect(scene.mount.mock.calls[0][2]).toMatchObject({ draggable: false });
  });

  it('stays on the still when the model cannot mount, and says nothing', async () => {
    scene.mount.mockRejectedValue(new Error('no WebGL'));
    render(<FiddyHeroStage />);
    await waitFor(() => expect(scene.mount).toHaveBeenCalled());
    await waitFor(() =>
      expect(stage()?.getAttribute('data-fiddy-hero')).toBe('still'),
    );
    expect(still()).toBeTruthy();
  });

  it('reports the model on screen once it is up, and disposes it on unmount', async () => {
    const view = render(<FiddyHeroStage />);
    await waitFor(() =>
      expect(stage()?.getAttribute('data-fiddy-hero')).toBe('moving'),
    );
    view.unmount();
    expect(dispose).toHaveBeenCalled();
  });
});
