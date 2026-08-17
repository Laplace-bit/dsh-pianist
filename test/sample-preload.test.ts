import { describe, expect, it } from 'vitest';
import { samplePreloadRequests } from '../src/audio/sample-preload.js';
import type { TimelineData } from '../src/core/types.js';

describe('samplePreloadRequests', () => {
  it('deduplicates only exact timeline MIDI/velocity pairs in event order', () => {
    const timeline: TimelineData = {
      ppq: 960,
      durationTicks: 960n,
      durationSeconds: 0.5,
      events: [
        { id: 'a:on', type: 'noteOn', tick: 0n, time: 0, noteId: 'a', midi: 60, velocity: 0.4 },
        { id: 'a:off', type: 'noteOff', tick: 240n, time: 0.125, noteId: 'a', midi: 60 },
        { id: 'b:on', type: 'noteOn', tick: 240n, time: 0.125, noteId: 'b', midi: 60, velocity: 0.4 },
        { id: 'c:on', type: 'noteOn', tick: 480n, time: 0.25, noteId: 'c', midi: 64, velocity: 0.9 },
      ],
    };

    expect(samplePreloadRequests(timeline)).toEqual([
      { midi: 60, velocity: 0.4 },
      { midi: 64, velocity: 0.9 },
    ]);
  });
});
