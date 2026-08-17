import { upperBoundEventTime } from '../core/timeline-index.js';
import type { PerformanceEvent } from '../core/types.js';

/**
 * Delivers visual events once for a forward-moving clock.
 *
 * Rendering may skip frames, but it must not skip event transitions. Seeking
 * deliberately rebuilds state elsewhere and advances this cursor past events
 * at the target so a particle burst is not replayed just by seeking.
 */
export class VisualEventCursor {
  private index = 0;

  constructor(private readonly events: readonly PerformanceEvent[]) {}

  get currentIndex(): number {
    return this.index;
  }

  reset(): void {
    this.index = 0;
  }

  seek(musicalTime: number): void {
    this.index = upperBoundEventTime(this.events, musicalTime);
  }

  advance(previousTime: number, currentTime: number): PerformanceEvent[] {
    if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
      throw new Error('visual cursor times must be finite');
    }
    if (currentTime < previousTime) {
      this.seek(currentTime);
      return [];
    }

    const minimumIndex = upperBoundEventTime(this.events, previousTime);
    if (this.index < minimumIndex) {
      this.index = minimumIndex;
    }

    const emitted: PerformanceEvent[] = [];
    while (this.index < this.events.length && this.events[this.index].time <= currentTime) {
      emitted.push(this.events[this.index]);
      this.index += 1;
    }
    return emitted;
  }
}
