import type { TimelineData } from './types.js';

export interface ActivePerformanceNote {
  noteId: string;
  midi: number;
  velocity: number;
  startTime: number;
  /** The scheduled note-off time when known. */
  endTime: number | undefined;
  keyDown: boolean;
}

export interface PerformanceState {
  activeNotes: readonly ActivePerformanceNote[];
  pedal: number;
}

interface MutableActiveNote extends ActivePerformanceNote {}

/**
 * Rebuild the sound/keyboard state at an exact musical time. It is deliberately
 * driven by the immutable performance events, so seek and dropped animation
 * frames cannot leave an accumulated state behind.
 */
export function reconstructPerformanceState(
  timeline: TimelineData,
  musicalTime: number,
): PerformanceState {
  const notes = new Map<string, MutableActiveNote>();
  let pedal = 0;

  for (const event of timeline.events) {
    if (event.time > musicalTime) {
      break;
    }
    if (event.type === 'noteOn') {
      if (event.noteId === undefined || event.midi === undefined || event.velocity === undefined) {
        continue;
      }
      notes.set(event.noteId, {
        noteId: event.noteId,
        midi: event.midi,
        velocity: event.velocity,
        startTime: event.time,
        endTime: undefined,
        keyDown: true,
      });
      continue;
    }
    if (event.type === 'noteOff') {
      if (event.noteId === undefined) {
        continue;
      }
      const note = notes.get(event.noteId);
      if (note === undefined) {
        continue;
      }
      note.endTime = event.time;
      note.keyDown = false;
      if (pedal === 0) {
        notes.delete(event.noteId);
      }
      continue;
    }
    if (event.type === 'pedalDown') {
      pedal = event.pedalValue ?? 1;
      continue;
    }
    if (event.type === 'pedalUp') {
      pedal = event.pedalValue ?? 0;
      for (const [noteId, note] of notes) {
        if (note.keyDown === false) {
          notes.delete(noteId);
        }
      }
    }
  }

  return {
    activeNotes: [...notes.values()].sort((left, right) =>
      left.midi - right.midi || left.startTime - right.startTime || left.noteId.localeCompare(right.noteId)),
    pedal,
  };
}
