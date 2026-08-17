import { describe, expect, it } from 'vitest';
import type { PerformanceEvent } from '../src/core/types.js';
import { VisualEventCursor } from '../src/visual/event-cursor.js';
import { createParticleBurst } from '../src/visual/particles.js';

const events: PerformanceEvent[] = [
  { id: 'n1:on', type: 'noteOn', tick: 0n, time: 0, noteId: 'n1', midi: 60, velocity: 0.5 },
  { id: 'n1:off', type: 'noteOff', tick: 480n, time: 0.25, noteId: 'n1', midi: 60 },
  { id: 'n2:on', type: 'noteOn', tick: 960n, time: 0.5, noteId: 'n2', midi: 64, velocity: 0.9 },
];

describe('VisualEventCursor', () => {
  it('delivers all crossed events when a frame is dropped', () => {
    const cursor = new VisualEventCursor(events);
    expect(cursor.advance(-0.001, 0)).toEqual([events[0]]);
    expect(cursor.advance(0, 0.6)).toEqual([events[1], events[2]]);
    expect(cursor.advance(0.6, 1)).toEqual([]);
  });

  it('does not replay historical event bursts after a seek', () => {
    const cursor = new VisualEventCursor(events);
    cursor.seek(0.5);
    expect(cursor.advance(0.5, 1)).toEqual([]);
    cursor.seek(0.1);
    expect(cursor.advance(0.1, 0.6)).toEqual([events[1], events[2]]);
  });
});

describe('createParticleBurst', () => {
  it('is deterministic and responds to velocity without random global state', () => {
    const first = createParticleBurst(events[2]);
    const second = createParticleBurst(events[2]);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(createParticleBurst(events[0]).length);
    expect(createParticleBurst(events[1])).toEqual([]);
  });
});
