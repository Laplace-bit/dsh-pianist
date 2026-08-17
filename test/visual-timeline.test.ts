import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/core/timeline.js';
import type { Score } from '../src/core/types.js';
import { VisualTimeline } from '../src/visual/visual-timeline.js';

function score(): Score {
  return {
    id: 'visual-window',
    title: 'Visual window',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 120 }],
    timeSignatureMap: [],
    tracks: [{
      id: 'piano',
      instrument: { id: 'grand' },
      voices: [{
        id: 'right',
        events: [
          { id: 'long', type: 'note', midi: 60, startTick: 0n, durationTicks: 3_840n, velocity: 0.4, voiceId: 'right', trackId: 'piano' },
          { id: 'middle', type: 'note', midi: 64, startTick: 1_920n, durationTicks: 480n, velocity: 0.8, voiceId: 'right', trackId: 'piano' },
          { id: 'future', type: 'note', midi: 67, startTick: 5_760n, durationTicks: 480n, velocity: 0.7, voiceId: 'right', trackId: 'piano' },
        ],
      }],
    }],
  };
}

describe('VisualTimeline', () => {
  it('pairs immutable note geometry from the one performance timeline', () => {
    const timeline = new VisualTimeline(buildTimeline(score()));

    expect(timeline.notes.map(note => [note.id, note.startTime, note.endTime, note.x])).toEqual([
      ['long', 0, 2, 23 / 52],
      ['middle', 1, 1.25, 25 / 52],
      ['future', 3, 3.25, 27 / 52],
    ]);
    expect(Object.isFrozen(timeline.notes)).toBe(true);
    expect(Object.isFrozen(timeline.notes[0])).toBe(true);
  });

  it('returns only notes and note-on events that intersect a viewport', () => {
    const timeline = new VisualTimeline(buildTimeline(score()));
    const window = timeline.window(1.1, 1.3);

    // The long note began before the query window and still needs rendering.
    expect(window.notes.map(note => note.id)).toEqual(['long', 'middle']);
    expect(window.noteOnEvents.map(event => event.noteId)).toEqual([]);

    expect(timeline.window(2.9, 3.1).notes.map(note => note.id)).toEqual(['future']);
    expect(timeline.window(2.9, 3.1).noteOnEvents.map(event => event.noteId)).toEqual(['future']);
  });

  it('normalizes inverted range bounds without changing output determinism', () => {
    const timeline = new VisualTimeline(buildTimeline(score()));

    expect(timeline.window(1.3, 1.1)).toEqual(timeline.window(1.1, 1.3));
  });

  it('uses its interval index instead of scanning a long score history', () => {
    const events = [] as ReturnType<typeof buildTimeline>['events'][number][];
    events.push({ id: 'sustain:on', type: 'noteOn', time: 0, tick: 0n, noteId: 'sustain', midi: 48, velocity: 0.5 });
    for (let index = 0; index < 20_000; index += 1) {
      const start = index * 0.1;
      const id = `short-${String(index)}`;
      events.push({ id: `${id}:on`, type: 'noteOn', time: start, tick: BigInt(index * 100), noteId: id, midi: 60, velocity: 0.6 });
      events.push({ id: `${id}:off`, type: 'noteOff', time: start + 0.05, tick: BigInt(index * 100 + 50), noteId: id, midi: 60, velocity: 0.6 });
    }
    events.push({ id: 'sustain:off', type: 'noteOff', time: 2_100, tick: 2_100_000n, noteId: 'sustain', midi: 48, velocity: 0.5 });
    events.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
    const timeline = new VisualTimeline({
      ppq: 960,
      durationTicks: 2_100_000n,
      durationSeconds: 2_100,
      events,
    });

    const result = timeline.window(1_999.2, 1_999.3);

    expect(result.notes.map(note => note.id)).toEqual(['sustain', 'short-19992']);
    expect(timeline.lastWindowVisitCount).toBeLessThan(200);
  });
});
