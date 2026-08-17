import { describe, expect, it } from 'vitest';
import { createPianoPerformancePayload, PIANO_PERFORMANCE_PAYLOAD_VERSION } from '../src/core/performance-payload.js';
import type { Score } from '../src/core/types.js';

const score: Score = {
  id: 'payload-score',
  title: 'Payload score',
  ppq: 960,
  tempoMap: [{ tick: 0n, bpm: 100 }],
  timeSignatureMap: [{ tick: 0n, numerator: 4, denominator: 4 }],
  tracks: [{
    id: 'piano',
    instrument: { id: 'grand' },
    voices: [{
      id: 'right',
      events: [{ id: 'c4', type: 'note', midi: 60, startTick: 0n, durationTicks: 960n, velocity: 0.8, voiceId: 'right', trackId: 'piano' }],
    }],
  }],
};

describe('PianoPerformancePayload', () => {
  it('derives a versioned immutable tool contract from the canonical score', () => {
    const payload = createPianoPerformancePayload(score, { performanceId: 'performance-1', sampleRate: 48_000, channels: 1 });

    expect(payload).toMatchObject({
      version: PIANO_PERFORMANCE_PAYLOAD_VERSION,
      performanceId: 'performance-1',
      duration: 0.6,
      audio: { format: 'audioBuffer', sampleRate: 48_000, channels: 1 },
      metadata: { bpm: 100, ppq: 960 },
    });
    expect(payload.timeline.map(event => event.id)).toEqual(['c4:on', 'tempo:0', 'c4:off']);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.timeline)).toBe(true);
    expect(Object.isFrozen(payload.score)).toBe(true);
    expect(payload.score).not.toBe(score);
  });

  it('rejects invalid transport metadata', () => {
    expect(() => createPianoPerformancePayload(score, { sampleRate: 44_100.5 })).toThrow(RangeError);
    expect(() => createPianoPerformancePayload(score, { performanceId: ' ' })).toThrow(TypeError);
  });
});
