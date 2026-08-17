import type { PerformanceEvent, TimelineData } from '../core/types.js';
import { lowerBoundEventTime, upperBoundEventTime } from '../core/timeline-index.js';
import { noteXPosition } from './keyboard.js';

/** Immutable note geometry derived from paired timeline events. */
export interface VisualTimelineNote {
  readonly id: string;
  readonly midi: number;
  readonly velocity: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly x: number;
}

/** A bounded query result suitable for a renderer frame. */
export interface VisualTimelineWindow {
  readonly startTime: number;
  readonly endTime: number;
  readonly notes: readonly VisualTimelineNote[];
  readonly noteOnEvents: readonly PerformanceEvent[];
}

interface PendingNote {
  readonly id: string;
  readonly midi: number;
  readonly velocity: number;
  readonly startTime: number;
}

function noteOrder(left: VisualTimelineNote, right: VisualTimelineNote): number {
  return left.startTime - right.startTime
    || left.endTime - right.endTime
    || left.midi - right.midi
    || left.id.localeCompare(right.id);
}

function lowerBoundNoteStart(notes: readonly VisualTimelineNote[], time: number): number {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (notes[middle]!.startTime < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundNoteStart(notes: readonly VisualTimelineNote[], time: number): number {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (notes[middle]!.startTime <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Read-only visual projection of the deterministic music timeline.
 *
 * It stores no playback state. A caller asks for a time window every frame,
 * so dropped frames, seeks, resizing, and rate changes cannot accumulate an
 * alternative visual clock.
 */
export class VisualTimeline {
  readonly notes: readonly VisualTimelineNote[];
  private readonly noteOnEvents: readonly PerformanceEvent[];
  private readonly maxEndTree: Float64Array;
  private readonly treeBase: number;
  private windowVisitCount = 0;

  constructor(timeline: TimelineData) {
    const pending = new Map<string, PendingNote>();
    const notes: VisualTimelineNote[] = [];
    const noteOnEvents: PerformanceEvent[] = [];

    for (const event of timeline.events) {
      if (event.type === 'noteOn') {
        if (event.noteId === undefined || event.midi === undefined || event.velocity === undefined) continue;
        const note: PendingNote = {
          id: event.noteId,
          midi: event.midi,
          velocity: event.velocity,
          startTime: event.time,
        };
        pending.set(note.id, note);
        noteOnEvents.push(event);
        continue;
      }
      if (event.type !== 'noteOff' || event.noteId === undefined) continue;
      const note = pending.get(event.noteId);
      if (note === undefined) continue;
      pending.delete(note.id);
      notes.push(Object.freeze({
        ...note,
        endTime: Math.max(note.startTime, event.time),
        x: noteXPosition(note.midi),
      }));
    }

    // Validation guarantees paired notes, but keeping malformed timeline data
    // visibly bounded makes a renderer resilient to an external caller.
    for (const note of pending.values()) {
      notes.push(Object.freeze({ ...note, endTime: timeline.durationSeconds, x: noteXPosition(note.midi) }));
    }

    notes.sort(noteOrder);
    this.notes = Object.freeze(notes);
    this.noteOnEvents = Object.freeze(noteOnEvents);

    let treeBase = 1;
    while (treeBase < notes.length) treeBase *= 2;
    this.treeBase = treeBase;
    this.maxEndTree = new Float64Array(treeBase * 2);
    this.maxEndTree.fill(Number.NEGATIVE_INFINITY);
    for (let index = 0; index < notes.length; index += 1) {
      this.maxEndTree[treeBase + index] = notes[index]!.endTime;
    }
    for (let index = treeBase - 1; index > 0; index -= 1) {
      this.maxEndTree[index] = Math.max(this.maxEndTree[index * 2]!, this.maxEndTree[index * 2 + 1]!);
    }
  }

  /** Number of interval-tree nodes examined by the most recent window query. */
  get lastWindowVisitCount(): number {
    return this.windowVisitCount;
  }

  /**
   * Return notes that intersect the requested musical-time range. The primary
   * scan starts at a binary-search boundary; only notes begun before that
   * boundary need an overlap check, so normal piano material remains bounded
   * by the viewport rather than the whole score.
   */
  window(startTime: number, endTime: number): VisualTimelineWindow {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw new RangeError('visual timeline window bounds must be finite');
    }
    const start = Math.min(startTime, endTime);
    const end = Math.max(startTime, endTime);
    const first = lowerBoundNoteStart(this.notes, start);
    const last = upperBoundNoteStart(this.notes, end);
    const visible: VisualTimelineNote[] = [];
    this.windowVisitCount = 0;

    this.collectOverlappingPrefix(1, 0, this.treeBase, first, start, visible);
    for (let index = first; index < last; index += 1) visible.push(this.notes[index]!);

    const firstEvent = lowerBoundEventTime(this.noteOnEvents, start);
    const lastEvent = upperBoundEventTime(this.noteOnEvents, end);
    return {
      startTime: start,
      endTime: end,
      notes: visible,
      noteOnEvents: this.noteOnEvents.slice(firstEvent, lastEvent),
    };
  }

  private collectOverlappingPrefix(
    node: number,
    rangeStart: number,
    rangeEnd: number,
    prefixEnd: number,
    minimumEnd: number,
    output: VisualTimelineNote[],
  ): void {
    this.windowVisitCount += 1;
    if (rangeStart >= prefixEnd || this.maxEndTree[node]! < minimumEnd) return;
    if (rangeEnd - rangeStart === 1) {
      const note = this.notes[rangeStart];
      if (note !== undefined) output.push(note);
      return;
    }
    const middle = rangeStart + Math.floor((rangeEnd - rangeStart) / 2);
    this.collectOverlappingPrefix(node * 2, rangeStart, middle, prefixEnd, minimumEnd, output);
    this.collectOverlappingPrefix(node * 2 + 1, middle, rangeEnd, prefixEnd, minimumEnd, output);
  }
}
