// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAIN_CARDS, BrainSheet } from '~/components/fiddy/BrainSheet';
import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { AgentServiceError } from '~/lib/agentService';
import { loadFiddySetup, resetFiddySetup } from '~/lib/fiddySetup';

const service = vi.hoisted(() => ({
  probeBrain: vi.fn(),
  applyBrain: vi.fn(),
  listAgents: vi.fn(),
  session: null as null | { baseUrl: string; token: string },
  status: 'unpaired' as string,
}));

vi.mock('~/hooks/agent/useAgentSession', () => ({
  useAgentSession: () => ({
    status: service.status,
    session: service.session,
    pair: vi.fn(),
    forget: vi.fn(),
  }),
}));

vi.mock('~/lib/agentService', () => ({
  AgentServiceError: class AgentServiceError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  },
  normaliseServiceUrl: (raw: string) =>
    raw.startsWith('https://') ? raw : null,
  isValidServiceToken: (raw: string) => raw.trim().length >= 8,
  probeBrain: service.probeBrain,
  applyBrain: service.applyBrain,
  listAgents: service.listAgents,
}));

const click = (selector: string) =>
  fireEvent.click(document.querySelector(selector) as HTMLElement);

const fill = (selector: string, value: string) =>
  fireEvent.change(document.querySelector(selector) as HTMLElement, {
    target: { value },
  });

beforeEach(() => {
  installFakeStorage();
  service.status = 'unpaired';
  service.session = null;
  service.probeBrain.mockReset();
  service.applyBrain.mockReset();
  service.listAgents.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  resetFiddySetup();
});

describe('BrainSheet', () => {
  it('offers one card per service, and the built-in one says it works out of the box', () => {
    render(<BrainSheet />);
    for (const card of BRAIN_CARDS) {
      expect(screen.getByText(card.title)).toBeTruthy();
    }
    expect(document.querySelectorAll('[data-fiddy-brain]')).toHaveLength(
      BRAIN_CARDS.length,
    );
    const builtIn = document.querySelector(
      '[data-fiddy-brain="fiddy"]',
    ) as HTMLElement;
    expect(builtIn.textContent).toContain('Works out of the box');
    expect(builtIn.textContent?.toLowerCase()).toContain('built-in brain');
  });

  it('asks for a key and a model on an account card, and never for an address', () => {
    render(<BrainSheet />);
    expect(document.querySelector('[data-fiddy="brain-connect"]')).toBeNull();

    click('[data-fiddy-brain="openrouter"]');
    expect(document.querySelector('[data-fiddy="brain-connect"]')).toBeTruthy();
    expect(
      document.querySelector('[data-fiddy-field="brain-key"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-fiddy-field="brain-model"]'),
    ).toBeTruthy();
    // The address belongs to the card, so the owner is not asked for it.
    expect(
      document.querySelector('[data-fiddy-field="brain-address"]'),
    ).toBeNull();
  });

  it('asks for three things on your own service, and nothing on the built-in brain', () => {
    render(<BrainSheet />);
    click('[data-fiddy-brain="custom"]');
    expect(
      document.querySelector('[data-fiddy-field="brain-address"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-fiddy-field="brain-key"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-fiddy-field="brain-model"]'),
    ).toBeTruthy();

    click('[data-fiddy-brain="fiddy"]');
    expect(document.querySelector('[data-fiddy="brain-connect"]')).toBeNull();
    expect(loadFiddySetup().brain).toBe('fiddy');
  });

  it('tests the connection, offers the models it found, and fills one in', async () => {
    service.probeBrain.mockResolvedValue({
      ok: true,
      status: 'ok',
      code: 'BRAIN_OK',
      models: ['gpt-one', 'gpt-two'],
    });
    render(<BrainSheet />);
    click('[data-fiddy-brain="openai"]');
    fill('[data-fiddy-field="brain-key"]', 'sk-0123456789abcdef');
    fill('[data-fiddy-field="brain-model"]', 'gpt-one');
    click('[data-fiddy-action="test-brain"]');

    await waitFor(() =>
      expect(screen.getByText(/That key works/)).toBeTruthy(),
    );
    expect(service.probeBrain.mock.calls[0]?.[0]).toBeNull();
    expect(service.probeBrain.mock.calls[0]?.[1]).toEqual({
      kind: 'preset',
      presetId: 'openai',
      model: 'gpt-one',
      key: 'sk-0123456789abcdef',
    });
    click('[data-fiddy-model="gpt-two"]');
    expect(
      (
        document.querySelector(
          '[data-fiddy-field="brain-model"]',
        ) as HTMLInputElement
      ).value,
    ).toBe('gpt-two');
  });

  it('says what failed in plain words, and names no infrastructure', async () => {
    service.probeBrain.mockRejectedValue(
      new AgentServiceError('BRAIN_KEY_REFUSED', 401),
    );
    render(<BrainSheet />);
    click('[data-fiddy-brain="anthropic"]');
    fill('[data-fiddy-field="brain-key"]', 'sk-wrong-key-0123456');
    fill('[data-fiddy-field="brain-model"]', 'claude-a');
    click('[data-fiddy-action="test-brain"]');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not accepted');
    expect(alert.textContent?.toLowerCase()).not.toContain('code');
    expect(alert.textContent?.toLowerCase()).not.toContain('error 401');
  });

  it('asks for what is missing instead of testing an empty form', () => {
    render(<BrainSheet />);
    click('[data-fiddy-brain="custom"]');
    click('[data-fiddy-action="test-brain"]');
    expect(screen.getByRole('alert').textContent).toContain(
      'What is the address',
    );
    expect(service.probeBrain).not.toHaveBeenCalled();
  });

  it('keeps the choice on this device when there is no agent yet, and keeps no key', async () => {
    render(<BrainSheet />);
    click('[data-fiddy-brain="google"]');
    fill('[data-fiddy-field="brain-key"]', 'sk-google-0123456789');
    fill('[data-fiddy-field="brain-model"]', 'gemini-flash');
    click('[data-fiddy-action="use-brain"]');

    await waitFor(() =>
      expect(screen.getByText(/Saved on this device/)).toBeTruthy(),
    );
    const setup = loadFiddySetup();
    expect(setup.brain).toBe('google');
    expect(setup.brainModel).toBe('gemini-flash');
    expect(service.applyBrain).not.toHaveBeenCalled();
    const raw = window.localStorage.getItem('fiddy.setup') ?? '';
    expect(raw).not.toContain('sk-google-0123456789');
    expect(raw.toLowerCase()).not.toContain('key');
  });

  it("changes the brain on the owner's own agent when one is paired", async () => {
    service.status = 'paired';
    service.session = {
      baseUrl: 'https://agents.example.com',
      token: 'token-1234567',
    };
    service.listAgents.mockResolvedValue([
      { id: 'ab12cd34ef', name: 'Sprout', status: 'running' },
    ]);
    service.applyBrain.mockResolvedValue({
      changed: true,
      readback: { provider: 'custom:brain', model: 'my-model' },
    });
    render(<BrainSheet />);
    click('[data-fiddy-brain="custom"]');
    await waitFor(() =>
      expect(
        document.querySelector('[data-fiddy-field="brain-agent"]'),
      ).toBeTruthy(),
    );
    fill('[data-fiddy-field="brain-address"]', 'https://api.example.com/v1');
    fill('[data-fiddy-field="brain-key"]', 'sk-0123456789abcdef');
    fill('[data-fiddy-field="brain-model"]', 'my-model');
    click('[data-fiddy-action="use-brain"]');

    await waitFor(() =>
      expect(screen.getByText(/Sprout now thinks with/)).toBeTruthy(),
    );
    expect(service.applyBrain).toHaveBeenCalledWith(
      service.session,
      'ab12cd34ef',
      {
        kind: 'custom',
        baseUrl: 'https://api.example.com/v1',
        model: 'my-model',
        key: 'sk-0123456789abcdef',
      },
    );
    expect(loadFiddySetup()).toMatchObject({
      brain: 'custom',
      brainServiceUrl: 'https://api.example.com/v1',
      brainModel: 'my-model',
    });
  });

  it('keeps the builders row closed until it is asked for', () => {
    render(<BrainSheet />);
    expect(document.querySelector('[data-fiddy="brain-advanced"]')).toBeNull();

    fireEvent.click(screen.getByText(/Advanced — for builders/i));
    const advanced = document.querySelector('[data-fiddy="brain-advanced"]');
    expect(advanced).toBeTruthy();
    expect(advanced?.textContent?.toLowerCase()).toContain('not wired yet');
  });

  it('uses no infrastructure words anywhere on the sheet', () => {
    render(<BrainSheet />);
    click('[data-fiddy-brain="custom"]');
    click('[data-fiddy-action="test-brain"]');
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const jargon of [
      'node',
      'snapchain',
      'scope',
      'ttl',
      'signer',
      'gasless',
      'api key',
      'mcp',
      'protocol',
      'endpoint',
      'bearer',
    ]) {
      expect(text).not.toContain(jargon);
    }
  });
});
