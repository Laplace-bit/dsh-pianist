import type { TempoEvent, Tick } from './types.js';

export interface TempoSegment {
  startTick: Tick;
  endTick: Tick | null;
  bpm: number;
}

/**
 * Deterministic TempoMap.
 *
 * tick -> seconds is an integral over tempo segments. It never assumes a
 * single global BPM.
 */
export class TempoMap {
  readonly ppq: number;
  readonly events: readonly TempoEvent[];

  constructor(ppq: number, events: readonly TempoEvent[]) {
    if (Number.isInteger(ppq) === false || ppq <= 0) {
      throw new Error('PPQ must be a positive integer');
    }
    if (events.length === 0) {
      throw new Error('TempoMap requires at least one tempo event');
    }
    this.ppq = ppq;
    this.events = [...events]
      .map((event) => ({ tick: BigInt(event.tick), bpm: Number(event.bpm) }))
      .sort((a, b) => (a.tick < b.tick ? -1 : a.tick > b.tick ? 1 : 0));
  }

  static default(ppq: number, bpm = 120): TempoMap {
    return new TempoMap(ppq, [{ tick: 0n, bpm }]);
  }

  bpmAt(tick: Tick): number {
    const target = BigInt(tick);
    let bpm = this.events[0].bpm;
    for (const event of this.events) {
      if (event.tick <= target) {
        bpm = event.bpm;
      } else {
        break;
      }
    }
    return bpm;
  }

  get segments(): TempoSegment[] {
    const segments: TempoSegment[] = [];
    for (let i = 0; i < this.events.length; i += 1) {
      const current = this.events[i];
      const next = this.events[i + 1];
      segments.push({
        startTick: current.tick,
        endTick: next ? next.tick : null,
        bpm: current.bpm,
      });
    }
    return segments;
  }

  /** Convert an absolute tick to absolute seconds. */
  tickToSeconds(tick: Tick): number {
    const target = BigInt(tick);
    let seconds = 0;
    let cursor = 0n;

    for (const segment of this.segments) {
      const start = segment.startTick;
      if (target < start) {
        break;
      }
      if (cursor < start) {
        seconds += Number(start - cursor) * 60 / this.events[0].bpm / this.ppq;
        cursor = start;
      }
      const end = segment.endTick ?? target;
      if (target <= end) {
        seconds += Number(target - cursor) * 60 / segment.bpm / this.ppq;
        return seconds;
      }
      seconds += Number(end - cursor) * 60 / segment.bpm / this.ppq;
      cursor = end;
    }

    // Tick is beyond the last tempo event; continue with the final BPM.
    seconds += Number(target - cursor) * 60 / this.events[this.events.length - 1].bpm / this.ppq;
    return seconds;
  }

  /** Convert absolute seconds to an approximate integer tick. */
  secondsToTick(seconds: number): Tick {
    if (Number.isFinite(seconds) === false || seconds < 0) {
      throw new Error('seconds must be a finite non-negative number');
    }
    const target = seconds;
    const segments = this.segments;
    let cursorSeconds = 0;
    let cursorTick = 0n;

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const segmentStart = segment.startTick;
      if (cursorTick < segmentStart) {
        cursorSeconds += Number(segmentStart - cursorTick) * 60 / this.events[0].bpm / this.ppq;
        cursorTick = segmentStart;
      }

      const segmentDurationTicks =
        segment.endTick === null
          ? Number.MAX_SAFE_INTEGER
          : Number(segment.endTick - cursorTick);
      const segmentDurationSeconds =
        (segmentDurationTicks * 60) / segment.bpm / this.ppq;

      if (target < cursorSeconds + segmentDurationSeconds || segment.endTick === null) {
        const ticksInSegment =
          ((target - cursorSeconds) * segment.bpm * this.ppq) / 60;
        return cursorTick + BigInt(Math.max(0, Math.round(ticksInSegment)));
      }

      cursorSeconds += segmentDurationSeconds;
      cursorTick = segment.endTick;
    }

    return cursorTick;
  }
}
