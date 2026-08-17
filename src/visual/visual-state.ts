import type { PerformanceEvent, TimelineData } from '../core/types.js';
import { noteXPosition } from './keyboard.js';

export interface ActiveNoteVisual {
  noteId: string;
  midi: number;
  velocity: number;
  startTime: number;
  endTime: number;
  x: number;
}

export interface VisualState {
  musicalTime: number;
  activeNotes: ActiveNoteVisual[];
  pressedMidi: Set<number>;
  pedal: number;
}

interface NoteState {
  noteId: string;
  midi: number;
  velocity: number;
  startTime: number;
  endTime: number;
  keyDown: boolean;
  released: boolean;
}

/**
 * Deterministically reconstruct visual state from the shared timeline.
 *
 * No module is allowed to accumulate frame deltas; every frame asks this
 * function "what should the world look like at musicalTime?".
 */
export function computeVisualState(
  timeline: TimelineData,
  musicalTime: number,
): VisualState {
  const noteStates = new Map<string, NoteState>();
  const pressedMidi = new Set<number>();
  let pedal = 0;

  for (const event of timeline.events) {
    if (event.time > musicalTime) {
      break;
    }
    switch (event.type) {
      case 'noteOn': {
        if (event.noteId === undefined || event.midi === undefined || event.velocity === undefined) {
          break;
        }
        noteStates.set(event.noteId, {
          noteId: event.noteId,
          midi: event.midi,
          velocity: event.velocity,
          startTime: event.time,
          endTime: event.time,
          keyDown: true,
          released: false,
        });
        break;
      }
      case 'noteOff': {
        if (event.noteId === undefined) {
          break;
        }
        const note = noteStates.get(event.noteId);
        if (note === undefined) {
          break;
        }
        note.endTime = event.time;
        note.keyDown = false;
        if (pedal === 0) {
          note.released = true;
        }
        break;
      }
      case 'pedalDown':
        pedal = event.pedalValue ?? 1;
        break;
      case 'pedalUp':
        pedal = event.pedalValue ?? 0;
        for (const note of noteStates.values()) {
          if (note.released === false && note.keyDown === false) {
            note.released = true;
          }
        }
        break;
      default:
        break;
    }
  }

  const activeNotes: ActiveNoteVisual[] = [];
  for (const note of noteStates.values()) {
    if (note.released === false) {
      if (note.keyDown) pressedMidi.add(note.midi);
      activeNotes.push({
        noteId: note.noteId,
        midi: note.midi,
        velocity: note.velocity,
        startTime: note.startTime,
        endTime: note.endTime,
        x: noteXPosition(note.midi),
      });
    }
  }
  activeNotes.sort((a, b) => a.midi - b.midi || a.startTime - b.startTime);

  return {
    musicalTime,
    activeNotes,
    pressedMidi,
    pedal,
  };
}
