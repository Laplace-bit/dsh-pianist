import type { TimelineData } from '../core/types.js';
import type { PianoSamplePreloadRequest } from './sample-pack.js';

/**
 * Derive the smallest deterministic warm-up set for a score. This lets a
 * manifest-backed sample pack decode audio before play without keeping every
 * velocity/root in memory on a constrained device.
 */
export function samplePreloadRequests(timeline: TimelineData): readonly PianoSamplePreloadRequest[] {
  const requests = new Map<string, PianoSamplePreloadRequest>();
  for (const event of timeline.events) {
    if (event.type !== 'noteOn' || event.midi === undefined || event.velocity === undefined) continue;
    const key = `${String(event.midi)}:${String(event.velocity)}`;
    if (!requests.has(key)) {
      requests.set(key, Object.freeze({ midi: event.midi, velocity: event.velocity }));
    }
  }
  return Object.freeze([...requests.values()]);
}
