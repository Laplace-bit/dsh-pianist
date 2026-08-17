import { describe, expect, it } from 'vitest';
import { TempoMap } from '../src/core/tempo-map.js';

describe('TempoMap', () => {
  it('converts a simple tick to seconds', () => {
    const map = new TempoMap(960, [{ tick: 0n, bpm: 120 }]);
    expect(map.tickToSeconds(960n)).toBeCloseTo(0.5, 10);
    expect(map.tickToSeconds(1920n)).toBeCloseTo(1, 10);
  });

  it('integrates tempo changes', () => {
    // 0..960 at 120 BPM = 0.5s; 960..1920 at 60 BPM = 1s.
    const map = new TempoMap(960, [
      { tick: 0n, bpm: 120 },
      { tick: 960n, bpm: 60 },
    ]);
    expect(map.tickToSeconds(960n)).toBeCloseTo(0.5, 10);
    expect(map.tickToSeconds(1920n)).toBeCloseTo(1.5, 10);
  });

  it('round-trips seconds to ticks', () => {
    const map = new TempoMap(960, [
      { tick: 0n, bpm: 120 },
      { tick: 960n, bpm: 90 },
    ]);
    const ticks = [0n, 480n, 960n, 1200n, 2400n];
    for (const tick of ticks) {
      const seconds = map.tickToSeconds(tick);
      expect(map.secondsToTick(seconds)).toBe(tick);
    }
  });

  it('reports bpm at a tick', () => {
    const map = new TempoMap(960, [
      { tick: 0n, bpm: 100 },
      { tick: 960n, bpm: 110 },
    ]);
    expect(map.bpmAt(0n)).toBe(100);
    expect(map.bpmAt(959n)).toBe(100);
    expect(map.bpmAt(960n)).toBe(110);
  });

  it('sorts tempo events deterministically', () => {
    const map = new TempoMap(960, [
      { tick: 960n, bpm: 110 },
      { tick: 0n, bpm: 100 },
    ]);
    expect(map.events.map((event) => event.bpm)).toEqual([100, 110]);
  });
});
