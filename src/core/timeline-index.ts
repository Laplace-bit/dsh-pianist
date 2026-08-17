import type { PerformanceEvent } from './types.js';

/**
 * Return the first event whose time is greater than or equal to `time`.
 *
 * Seek paths use this instead of scanning every preceding event, keeping the
 * cost bounded for long performances.
 */
export function lowerBoundEventTime(events: readonly PerformanceEvent[], time: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle].time < time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Return the first event whose time is strictly greater than `time`. */
export function upperBoundEventTime(events: readonly PerformanceEvent[], time: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle].time <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
