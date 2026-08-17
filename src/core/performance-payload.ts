import { buildTimeline } from './timeline.js';
import type { PerformanceEvent, Score } from './types.js';

/** Increment when a breaking payload change is intentionally introduced. */
export const PIANO_PERFORMANCE_PAYLOAD_VERSION = 1 as const;

/** Describes an audio buffer without putting its samples into a tool response. */
export interface PianoPerformanceAudioDescriptor {
  readonly format: 'audioBuffer';
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * Versioned, structured contract between a score-producing tool and a
 * browser-side piano renderer. Audio data is deliberately out of band.
 */
export interface PianoPerformancePayload {
  readonly version: typeof PIANO_PERFORMANCE_PAYLOAD_VERSION;
  readonly performanceId: string;
  readonly score: Score;
  readonly timeline: readonly PerformanceEvent[];
  readonly duration: number;
  readonly audio: PianoPerformanceAudioDescriptor;
  readonly metadata: {
    readonly bpm: number;
    readonly ppq: number;
  };
}

export interface CreatePianoPerformancePayloadOptions {
  readonly performanceId?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
}

function immutableClone<T>(value: T): T {
  const cloned = structuredClone(value);

  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) {
      return;
    }
    Object.freeze(candidate);
    for (const child of Object.values(candidate)) {
      freeze(child);
    }
  };

  freeze(cloned);
  return cloned;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Build an immutable, additive-compatible payload from the one canonical
 * Score. Callers transport any rendered AudioBuffer separately (for example
 * via an object URL or a typed Host RPC view).
 */
export function createPianoPerformancePayload(
  score: Score,
  options: CreatePianoPerformancePayloadOptions = {},
): PianoPerformancePayload {
  const timeline = buildTimeline(score);
  const performanceId = options.performanceId ?? score.id;
  if (typeof performanceId !== 'string' || performanceId.trim() === '') {
    throw new TypeError('performanceId must be a non-empty string');
  }

  const sampleRate = positiveInteger(options.sampleRate ?? 44_100, 'sampleRate');
  const channels = positiveInteger(options.channels ?? 2, 'channels');
  const bpm = score.tempoMap[0]?.bpm;
  if (bpm === undefined) {
    // buildTimeline() has already validated the score; this is a defensive
    // guard to keep the public payload contract complete.
    throw new RangeError('score requires an initial tempo event');
  }

  return immutableClone({
    version: PIANO_PERFORMANCE_PAYLOAD_VERSION,
    performanceId,
    score,
    timeline: timeline.events,
    duration: timeline.durationSeconds,
    audio: { format: 'audioBuffer' as const, sampleRate, channels },
    metadata: { bpm, ppq: score.ppq },
  });
}
