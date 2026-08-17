import { describe, expect, it } from 'vitest';
import { parsePianoToolStream } from '../src/client/piano-tool-stream.js';

function note(startBeat: number, pitch = 'C4'): string {
  return JSON.stringify({ pitches: [pitch], startBeat, durationBeats: 1, hand: 'right' });
}

function prefix(notes: string): string {
  return `{"title":"流式 {钢琴}","bpm":120,"timeSignature":{"numerator":4,"denominator":4},"pedals":[],"tempoChanges":[],"autoplay":true,"notes":[${notes}`;
}

describe('piano_perform incremental argument parser', () => {
  it('extracts only structurally complete note groups from an unfinished JSON stream', () => {
    const preview = parsePianoToolStream(`${prefix(`${note(0)},${note(1)},`)}{"pitches":["E4"]`);

    expect(preview).toMatchObject({
      complete: false,
      title: '流式 {钢琴}',
      bpm: 120,
      noteGroupCount: 2,
      soundedNoteCount: 2,
      chronological: true,
    });
    expect(preview.input?.notes).toHaveLength(2);
    expect(preview.readyToPlay).toBe(false);
  });

  it('marks a chronological prefix playable after an adaptive safety buffer exists', () => {
    const notes = Array.from({ length: 9 }, (_, index) => note(index)).join(',');
    const preview = parsePianoToolStream(prefix(notes), { elapsedMs: 2_000 });

    expect(preview).toMatchObject({
      complete: false,
      noteGroupCount: 9,
      bufferedUntilBeat: 8,
      chronological: true,
      readyToPlay: true,
    });
  });

  it('starts from a safe prefix before optional controls arrive', () => {
    const notes = Array.from({ length: 5 }, (_, index) => note(index)).join(',');
    const preview = parsePianoToolStream(
      `{"title":"Early water","bpm":120,"notes":[${notes}`,
      { elapsedMs: 2_000 },
    );

    expect(preview.input?.title).toBe('Early water');
    expect(preview.readyToPlay).toBe(true);
    expect(preview.input?.timeSignature).toBeUndefined();
  });

  it('waits for settlement when note groups are not ordered by nondecreasing startBeat', () => {
    const preview = parsePianoToolStream(prefix([note(0), note(8), note(2)].join(',')), { elapsedMs: 8_000 });

    expect(preview.chronological).toBe(false);
    expect(preview.readyToPlay).toBe(false);
  });

  it('parses the complete tool payload without losing optional performance controls', () => {
    const raw = JSON.stringify({
      title: 'Complete',
      bpm: 90,
      timeSignature: { numerator: 3, denominator: 4 },
      pedals: [{ startBeat: 0, endBeat: 3 }],
      tempoChanges: [{ beat: 3, bpm: 96 }],
      autoplay: false,
      notes: [JSON.parse(note(0)), JSON.parse(note(1))],
    });
    const preview = parsePianoToolStream(raw);

    expect(preview.complete).toBe(true);
    expect(preview.input).toMatchObject({
      title: 'Complete',
      bpm: 90,
      timeSignature: { numerator: 3, denominator: 4 },
      pedals: [{ startBeat: 0, endBeat: 3 }],
      tempoChanges: [{ beat: 3, bpm: 96 }],
      autoplay: false,
    });
  });

  it('streams compact note objects and counts compact chords', () => {
    const preview = parsePianoToolStream(
      '{"title":"Compact","bpm":120,"notes":[{"p":"C4","s":0,"d":1},{"p":["E4","G4"],"s":1,"d":1}',
      { elapsedMs: 1_000 },
    );

    expect(preview).toMatchObject({
      noteGroupCount: 2,
      soundedNoteCount: 3,
      chronological: true,
      bufferedUntilBeat: 1,
    });
    expect(preview.input?.notes).toHaveLength(2);
  });
});
