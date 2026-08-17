import { describe, expect, it } from 'vitest';
import { lowerBoundEventTime, upperBoundEventTime } from '../src/core/timeline-index.js';
import type { PerformanceEvent } from '../src/core/types.js';

const events: PerformanceEvent[] = [
  { id: 'a', type: 'noteOn', tick: 0n, time: 0 },
  { id: 'b', type: 'noteOff', tick: 960n, time: 1 },
  { id: 'c', type: 'noteOn', tick: 960n, time: 1 },
  { id: 'd', type: 'noteOff', tick: 1920n, time: 2 },
];

describe('timeline event indexes', () => {
  it('locates a seek boundary without scanning an event list', () => {
    expect(lowerBoundEventTime(events, -1)).toBe(0);
    expect(lowerBoundEventTime(events, 1)).toBe(1);
    expect(lowerBoundEventTime(events, 1.1)).toBe(3);
    expect(lowerBoundEventTime(events, 3)).toBe(4);
  });

  it('can advance past all events at a shared timestamp', () => {
    expect(upperBoundEventTime(events, 1)).toBe(3);
  });
});
