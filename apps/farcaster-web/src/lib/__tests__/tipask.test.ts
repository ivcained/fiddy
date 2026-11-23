/**
 * Hold-to-tip state machine tests. Borrowed from quilcast (MIT).
 *   src/tipask.test.ts / commit 700d8b78d8c7
 */
import { describe, expect, it } from 'vitest';

const store = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
  writable: true,
  configurable: true,
});

const { holdTip, setHoldTip, tipOk, tipSheet, tipTold } =
  await import('../tipask');

// A stand-in for TipSheet: records each time it is shown, may flip its switch,
// and answers with `answer`.
let asked = 0;
let answer = false;
let switchOff = false;
tipSheet.ask = async () => {
  asked++;
  if (switchOff) {
    setHoldTip(false);
  }
  return answer;
};

const reset = () => {
  store.clear();
  asked = 0;
  answer = false;
  switchOff = false;
};

const o = { from: 'Main', to: 'alice' };

describe('hold-to-tip', () => {
  it('is on until someone turns it off', () => {
    reset();
    expect(holdTip()).toBe(true);
    setHoldTip(false);
    expect(holdTip()).toBe(false);
    setHoldTip(true);
    expect(holdTip()).toBe(true);
  });

  it('the first hold explains itself; Cancel tips nothing and asks again next time', async () => {
    reset();
    expect(await tipOk(o)).toBe(false);
    expect(await tipOk(o)).toBe(false);
    expect(asked).toBe(2);
    expect(tipTold()).toBe(false);
  });

  it('once someone tipped from the sheet, holds tip without asking', async () => {
    reset();
    answer = true;
    expect(await tipOk(o)).toBe(true);
    expect(tipTold()).toBe(true);
    answer = false;
    expect(await tipOk(o)).toBe(true);
    expect(await tipOk(o)).toBe(true);
    expect(asked).toBe(1);
  });

  it('switched off, a hold never asks and never tips, even once told', async () => {
    reset();
    setHoldTip(false);
    answer = true;
    expect(await tipOk(o)).toBe(false);
    expect(asked).toBe(0);
    setHoldTip(true);
    expect(await tipOk(o)).toBe(true);
    setHoldTip(false);
    expect(await tipOk(o)).toBe(false);
    expect(asked).toBe(1);
  });

  it("turning the sheet's switch off means no tip, and no more asking", async () => {
    reset();
    answer = true;
    switchOff = true;
    expect(await tipOk(o)).toBe(false);
    expect(tipTold()).toBe(false);
    expect(holdTip()).toBe(false);
    expect(await tipOk(o)).toBe(false);
    expect(asked).toBe(1);
  });

  it('a browser that keeps nothing stays on, asks every time and still tips when told to', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kept = (globalThis as any).localStorage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    try {
      asked = 0;
      answer = true;
      switchOff = false;
      expect(holdTip()).toBe(true);
      expect(await tipOk(o)).toBe(true);
      expect(await tipOk(o)).toBe(true);
      expect(asked).toBe(2);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).localStorage = kept;
    }
  });
});
