import { describe, expect, it } from 'vitest';
import { cancelAndHoldAutomation } from '../src/audio/cancel-and-hold.js';

class ParamStub {
  value: number;
  readonly calls: Array<{ method: string; when?: number; value?: number }> = [];

  constructor(value: number, supportsNativeHold: boolean) {
    this.value = value;
    if (supportsNativeHold) {
      this.cancelAndHoldAtTime = (time: number): ParamStub => {
        this.calls.push({ method: 'cancel-hold', when: time });
        return this;
      };
    }
  }

  cancelScheduledValues(when: number): ParamStub {
    this.calls.push({ method: 'cancel', when });
    return this;
  }

  setValueAtTime(value: number, when: number): ParamStub {
    this.calls.push({ method: 'set', value, when });
    this.value = value;
    return this;
  }

  cancelAndHoldAtTime?: (time: number) => ParamStub;
}

describe('cancelAndHoldAutomation', () => {
  it('delegates to the native cancelAndHoldAtTime when available', () => {
    const param = new ParamStub(0.42, true);
    cancelAndHoldAutomation(param as unknown as AudioParam, 9.5, 0.0001);
    expect(param.calls).toEqual([{ method: 'cancel-hold', when: 9.5 }]);
  });

  it('falls back to pinning the current computed value on engines without native support', () => {
    const param = new ParamStub(0.42, false);
    cancelAndHoldAutomation(param as unknown as AudioParam, 9.5, 0.0001);
    expect(param.calls).toEqual([
      { method: 'cancel', when: 9.5 },
      { method: 'set', when: 9.5, value: 0.42 },
    ]);
  });

  it('applies the floor to the pinned fallback value', () => {
    const param = new ParamStub(0, false);
    cancelAndHoldAutomation(param as unknown as AudioParam, 3, 0.0001);
    expect(param.calls).toEqual([
      { method: 'cancel', when: 3 },
      { method: 'set', when: 3, value: 0.0001 },
    ]);
  });
});
