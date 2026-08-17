import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/core/timeline.js';
import type { Score } from '../src/core/types.js';
import { OfflineVisualFrameRenderer, musicalTimeForFrame } from '../src/visual/offline-frame-renderer.js';

const score: Score = {
  id: 'frame-score', title: 'Frame score', ppq: 960,
  tempoMap: [{ tick: 0n, bpm: 120 }], timeSignatureMap: [],
  tracks: [{ id: 'piano', instrument: { id: 'grand' }, voices: [{
    id: 'right', events: [{ id: 'c4', type: 'note', midi: 60, startTick: 960n, durationTicks: 960n, velocity: 0.7, voiceId: 'right', trackId: 'piano' }],
  }] }],
};

describe('OfflineVisualFrameRenderer', () => {
  it('derives every frame from frameIndex / FPS rather than frame deltas', () => {
    const renderer = new OfflineVisualFrameRenderer(buildTimeline(score));
    const frame = renderer.render(45, 60);
    const repeated = renderer.render(45, 60);

    expect(musicalTimeForFrame(45, 60)).toBe(0.75);
    expect(frame.musicalTime).toBe(0.75);
    expect(frame.state.pressedMidi).toEqual(new Set([60]));
    expect(frame.window.notes.map(note => note.id)).toEqual(['c4']);
    expect(repeated).toEqual(frame);
  });

  it('validates frame timing inputs', () => {
    expect(() => musicalTimeForFrame(-1, 60)).toThrow(RangeError);
    expect(() => musicalTimeForFrame(1, 0)).toThrow(RangeError);
  });
});
