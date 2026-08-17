import { describe, expect, it } from 'vitest';
import type { Score } from '../src/core/types.js';
import { transposeScore } from '../src/core/transpose.js';
import { ScoreValidationError } from '../src/core/errors.js';

function score(): Score {
  return {
    id: 's',
    title: 'Transpose',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 120 }],
    timeSignatureMap: [],
    tracks: [
      {
        id: 't',
        instrument: { id: 'piano' },
        voices: [
          {
            id: 'v',
            events: [
              { id: 'n', type: 'note', midi: 60, startTick: 0n, durationTicks: 480n, velocity: 0.8, voiceId: 'v', trackId: 't' },
            ],
          },
        ],
      },
    ],
  };
}

describe('transposeScore', () => {
  it('transposes notes explicitly', () => {
    const result = transposeScore(score(), 2);
    expect(result.tracks[0].voices[0].events[0]).toMatchObject({ midi: 62 });
    expect(score().tracks[0].voices[0].events[0]).toMatchObject({ midi: 60 });
  });

  it('rejects out-of-range transposition instead of dropping', () => {
    expect(() => transposeScore(score(), -100)).toThrow(ScoreValidationError);
  });
});
