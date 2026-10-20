// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import {
  allowedChannelCount,
  DEFAULT_AGENT_NAME,
  defaultFiddySetup,
  loadFiddySetup,
  resetFiddySetup,
  saveFiddySetup,
} from '~/lib/fiddySetup';

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  resetFiddySetup();
});

describe('fiddySetup', () => {
  it('starts with Farcaster allowed and nothing else', () => {
    const setup = loadFiddySetup();
    expect(setup.agentName).toBe(DEFAULT_AGENT_NAME);
    expect(setup.brain).toBe('fiddy');
    expect(setup.completedAt).toBeNull();
    expect(allowedChannelCount(setup)).toBe(1);
    expect(setup.channels.farcaster).toBe(true);
    expect(setup.channels.whatsapp).toBe(false);
  });

  it('keeps answers across a save and a reload', () => {
    saveFiddySetup({
      agentName: 'Sprout',
      brain: 'other',
      brainServiceUrl: 'https://agents.example.com',
      channels: { ...defaultFiddySetup().channels, telegram: true },
    });

    const setup = loadFiddySetup();
    expect(setup.agentName).toBe('Sprout');
    expect(setup.brain).toBe('other');
    expect(setup.brainServiceUrl).toBe('https://agents.example.com');
    expect(allowedChannelCount(setup)).toBe(2);
    expect(setup.channels.telegram).toBe(true);
  });

  it('merges a patch instead of replacing what was already answered', () => {
    saveFiddySetup({ agentName: 'Sprout' });
    saveFiddySetup({ brain: 'gemini' });
    expect(loadFiddySetup().agentName).toBe('Sprout');
    expect(loadFiddySetup().brain).toBe('gemini');
  });

  it('falls back to defaults on garbage instead of throwing', () => {
    window.localStorage.setItem(
      'fiddy.setup',
      '{"agentName":42,"brain":"gpt9"',
    );
    expect(loadFiddySetup().agentName).toBe(DEFAULT_AGENT_NAME);
    expect(loadFiddySetup().brain).toBe('fiddy');
  });

  it('ignores unknown channel keys from a future or older build', () => {
    window.localStorage.setItem(
      'fiddy.setup',
      JSON.stringify({
        agentName: 'Sprout',
        channels: { farcaster: true, myspace: true, email: 'yes' },
      }),
    );
    const setup = loadFiddySetup();
    expect(setup.channels).not.toHaveProperty('myspace');
    // A non-boolean is not a permission.
    expect(setup.channels.email).toBe(false);
  });

  it('never stores a credential: only an address survives a save', () => {
    saveFiddySetup({
      brain: 'other',
      brainServiceUrl: 'https://agents.example.com',
    } as never);
    const raw = window.localStorage.getItem('fiddy.setup') ?? '';
    expect(raw).toContain('https://agents.example.com');
    expect(raw.toLowerCase()).not.toContain('token');
    expect(raw.toLowerCase()).not.toContain('key');
  });
});
