import type {
  ChordEvent,
  MusicEvent,
  NoteEvent,
  Score,
  TupletEvent,
} from './types.js';
import { MAX_MIDI, MIN_MIDI, validateScore } from './validator.js';
import { ScoreValidationError } from './errors.js';

/**
 * Explicitly transpose a score by semitones. Out-of-range notes are rejected
 * rather than silently dropped.
 */
export function transposeScore(score: Score, semitones: number): Score {
  if (Number.isInteger(semitones) === false) {
    throw new Error('semitones must be an integer');
  }
  const cloned: Score = structuredClone(score);
  transposeMusicEvents(cloned.tracks.flatMap((track) => track.voices.flatMap((voice) => voice.events)), semitones);
  validateScore(cloned);
  return cloned;
}

function transposeMusicEvents(events: MusicEvent[], semitones: number): void {
  for (const event of events) {
    if (event.type === 'note') {
      const midi = event.midi + semitones;
      if (midi < MIN_MIDI || midi > MAX_MIDI) {
        throw new ScoreValidationError([`transposed note ${event.id} is outside piano range: ${midi}`]);
      }
      (event as NoteEvent).midi = midi;
    } else if (event.type === 'chord') {
      for (const note of (event as ChordEvent).notes) {
        const midi = note.midi + semitones;
        if (midi < MIN_MIDI || midi > MAX_MIDI) {
          throw new ScoreValidationError([`transposed chord note in ${event.id} is outside piano range: ${midi}`]);
        }
        note.midi = midi;
      }
    } else if (event.type === 'tuplet') {
      transposeMusicEvents((event as TupletEvent).events, semitones);
    }
  }
}
