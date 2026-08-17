import type { PerformanceEvent, TimelineData } from '../core/types.js';
import { reconstructPerformanceState } from '../core/performance-state.js';
import { lowerBoundEventTime, upperBoundEventTime } from '../core/timeline-index.js';
import type { MusicalClock } from './musical-clock.js';
import type { PianoEngine } from './types.js';

/**
 * Lookahead scheduler.
 *
 * It only asks the clock where we are and schedules audio events at the exact
 * AudioContext times derived from the same clock. It never guesses musical time.
 */
export class Scheduler {
  private events: readonly PerformanceEvent[];
  private index = 0;
  private lookaheadSeconds: number;
  private readonly scheduledEventIds = new Set<string>();

  constructor(
    private timeline: TimelineData,
    private readonly engine: PianoEngine,
    private readonly clock: MusicalClock,
    lookaheadSeconds = 0.12,
  ) {
    this.events = timeline.events;
    if (Number.isFinite(lookaheadSeconds) === false || lookaheadSeconds < 0) {
      throw new RangeError('lookaheadSeconds must be a non-negative finite number');
    }
    this.lookaheadSeconds = lookaheadSeconds;
  }

  get currentIndex(): number {
    return this.index;
  }

  update(): void {
    if (this.clock.state !== 'playing') {
      return;
    }
    // Lookahead is an audio-time budget, not a rate-dependent musical-time
    // budget. Convert it through the one authoritative playback rate.
    const horizon = this.clock.currentTime + this.lookaheadSeconds * this.clock.rate;
    while (this.index < this.events.length) {
      const event = this.events[this.index];
      if (event.time > horizon) {
        break;
      }
      if (!this.scheduledEventIds.has(event.id)) this.dispatch(event);
      this.index += 1;
    }
  }

  seek(musicalTime: number, restoreActiveVoices = false): void {
    const target = Math.max(0, musicalTime);
    const when = this.clock.contextTime;
    this.engine.allNotesOff(when);
    this.engine.setPedal(0, when);
    this.scheduledEventIds.clear();
    // A restored state already includes every event at `target`. Starting at
    // the lower bound would replay a simultaneous note-on (or pedal change)
    // immediately after it was reconstructed. Non-restoring seeks retain
    // same-time events so a ready/stopped player can start naturally at zero.
    this.index = restoreActiveVoices
      ? upperBoundEventTime(this.events, target)
      : lowerBoundEventTime(this.events, target);

    if (restoreActiveVoices) {
      const state = reconstructPerformanceState(this.timeline, target);
      this.engine.setPedal(state.pedal, when);
      if (this.engine.restoreNote !== undefined) {
        for (const note of state.activeNotes) {
          this.engine.restoreNote({
            id: note.noteId,
            midi: note.midi,
            velocity: note.velocity,
            when,
            offsetSeconds: Math.max(0, target - note.startTime),
            keyDown: note.keyDown,
          });
        }
      }
    }
  }

  /** Drop all scheduled voices and use a new immutable score timeline. */
  replaceTimeline(timeline: TimelineData): void {
    this.engine.allNotesOff(this.clock.contextTime);
    this.engine.setPedal(0, this.clock.contextTime);
    this.timeline = timeline;
    this.events = timeline.events;
    this.index = 0;
    this.scheduledEventIds.clear();
  }

  /**
   * Extend a streaming score without touching voices already handed to Web
   * Audio. Stable event ids let the scheduler merge newly arrived events while
   * skipping lookahead events that were scheduled from an earlier prefix.
   */
  updateTimeline(timeline: TimelineData): void {
    this.timeline = timeline;
    this.events = timeline.events;
    this.index = lowerBoundEventTime(this.events, Math.max(0, this.clock.currentTime));
  }

  setLookaheadSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError('lookaheadSeconds must be a non-negative finite number');
    }
    this.lookaheadSeconds = seconds;
  }

  get scheduledCount(): number {
    return this.scheduledEventIds.size;
  }

  get exhausted(): boolean {
    return this.index >= this.events.length;
  }

  private dispatch(event: PerformanceEvent): void {
    if (this.scheduledEventIds.has(event.id)) return;
    const when = Math.max(this.clock.contextTime, this.clock.toContextTime(event.time));
    switch (event.type) {
      case 'noteOn':
        if (event.noteId !== undefined && event.midi !== undefined && event.velocity !== undefined) {
          this.engine.noteOn(event.noteId, event.midi, event.velocity, when);
        }
        break;
      case 'noteOff':
        if (event.noteId !== undefined) {
          this.engine.noteOff(event.noteId, when);
        }
        break;
      case 'pedalDown':
        this.engine.setPedal(event.pedalValue ?? 1, when);
        break;
      case 'pedalUp':
        this.engine.setPedal(event.pedalValue ?? 0, when);
        break;
      case 'tempoChange':
        // Tempo changes are handled by the TempoMap/clock timeline. Nothing to
        // schedule on the audio engine itself.
        break;
      default:
        break;
    }
    this.scheduledEventIds.add(event.id);
  }
}
