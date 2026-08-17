import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/core/timeline.js';
import type { Score } from '../src/core/types.js';
import { computeVisualState } from '../src/visual/visual-state.js';
import { createKeyboardLayout, noteXPosition, pianoKeyAtPoint } from '../src/visual/keyboard.js';

function scoreWithPedal(): Score {
  return {
    id: 's',
    title: 'Pedal',
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
              { id: 'ped', type: 'pedal', startTick: 0n, endTick: 960n, value: 1, voiceId: 'v', trackId: 't' },
            ],
          },
        ],
      },
    ],
  };
}

describe('VisualState', () => {
  const timeline = buildTimeline(scoreWithPedal());

  it('keeps a released note sounding under pedal without showing its key as pressed', () => {
    // noteOff at 0.25s, pedal up at 0.5s.
    const state = computeVisualState(timeline, 0.3);
    expect(state.pedal).toBe(1);
    expect(state.pressedMidi.has(60)).toBe(false);
    expect(state.activeNotes).toHaveLength(1);
  });

  it('releases sustained notes at pedalUp', () => {
    const state = computeVisualState(timeline, 0.6);
    expect(state.pedal).toBe(0);
    expect(state.pressedMidi.has(60)).toBe(false);
    expect(state.activeNotes).toHaveLength(0);
  });

  it('is deterministic for the same time', () => {
    expect(computeVisualState(timeline, 0.3)).toEqual(computeVisualState(timeline, 0.3));
  });

  it('retains a half-pedal value from the shared timeline', () => {
    const score: Score = {
      ...scoreWithPedal(),
      tracks: [{
        id: 't',
        instrument: { id: 'piano' },
        voices: [{
          id: 'v',
          events: [
            { id: 'pedal', type: 'pedal', startTick: 0n, endTick: 960n, value: 0.5, voiceId: 'v', trackId: 't' },
          ],
        }],
      }],
    };

    expect(computeVisualState(buildTimeline(score), 0.1).pedal).toBe(0.5);
  });

  it('keeps an overlapping MIDI key pressed until every overlapping note is released', () => {
    const score: Score = {
      ...scoreWithPedal(),
      tracks: [{
        id: 't',
        instrument: { id: 'piano' },
        voices: [{
          id: 'v',
          events: [
            { id: 'first', type: 'note', midi: 60, startTick: 0n, durationTicks: 960n, velocity: 0.6, voiceId: 'v', trackId: 't' },
            { id: 'second', type: 'note', midi: 60, startTick: 480n, durationTicks: 960n, velocity: 0.8, voiceId: 'v', trackId: 't' },
          ],
        }],
      }],
    };
    const state = computeVisualState(buildTimeline(score), 0.6);

    expect(state.pressedMidi.has(60)).toBe(true);
    expect(state.activeNotes.map((note) => note.noteId)).toEqual(['second']);
  });

  it('does not release a held key just because the pedal comes up before noteOff', () => {
    const score: Score = {
      ...scoreWithPedal(),
      tracks: [{
        id: 't',
        instrument: { id: 'piano' },
        voices: [{
          id: 'v',
          events: [
            { id: 'long', type: 'note', midi: 60, startTick: 0n, durationTicks: 1920n, velocity: 0.8, voiceId: 'v', trackId: 't' },
            { id: 'pedal', type: 'pedal', startTick: 0n, endTick: 960n, value: 1, voiceId: 'v', trackId: 't' },
          ],
        }],
      }],
    };
    const state = computeVisualState(buildTimeline(score), 0.75);

    expect(state.pedal).toBe(0);
    expect(state.pressedMidi.has(60)).toBe(true);
    expect(state.activeNotes).toHaveLength(1);
  });
});

describe('KeyboardLayout', () => {
  it('contains 88 keys from A0 to C8', () => {
    const keys = createKeyboardLayout();
    expect(keys).toHaveLength(88);
    expect(keys[0].midi).toBe(21);
    expect(keys[87].midi).toBe(108);
    expect(keys[0].name).toBe('A0');
    expect(keys[87].name).toBe('C8');
  });

  it('returns deterministic normalized x positions', () => {
    expect(noteXPosition(60)).toBeCloseTo(23 / 52, 10);
    expect(noteXPosition(61)).toBeGreaterThan(noteXPosition(60));
    expect(noteXPosition(61)).toBeLessThan(noteXPosition(62));
  });

  it('hit-tests black keys before the white keys beneath them', () => {
    expect(pianoKeyAtPoint(235, 190, 520, 200)?.name).toBe('C4');
    expect(pianoKeyAtPoint(240, 150, 520, 200)?.name).toBe('C#4');
    expect(pianoKeyAtPoint(240, 100, 520, 200)).toBeUndefined();
  });
});
