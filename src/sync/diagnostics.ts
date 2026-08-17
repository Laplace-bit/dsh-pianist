export const DEFAULT_SYNC_DRIFT_THRESHOLD_MS = 16;

export type PianistRuntimeLogType =
  | 'PLAY'
  | 'PAUSE'
  | 'SEEK'
  | 'STOP'
  | 'NOTE_ON'
  | 'NOTE_OFF'
  | 'PEDAL'
  | 'SYNC_WARNING'
  | 'SYNC_RECOVERY'
  | 'AUDIO_ERROR';

export interface PianistRuntimeLogEntry {
  readonly type: PianistRuntimeLogType;
  readonly musicalTime: number;
  readonly eventId?: string;
  readonly message?: string;
}

export interface SyncDiagnosticFrame {
  readonly frameTimestampMs: number;
  readonly audioTime: number;
  readonly musicalTime: number;
  readonly visualTime: number;
  readonly scheduledEvents: number;
  readonly activeNotes: number;
  readonly expectedEventId?: string;
  readonly actualEventId?: string;
}

export interface SyncDiagnosticSnapshot extends SyncDiagnosticFrame {
  readonly fps: number;
  readonly frameTimeMs: number;
  /** Signed visual-minus-musical offset. Positive values mean visuals lead. */
  readonly avOffsetMs: number;
  readonly avDriftMs: number;
}

export interface SyncRecovery {
  readonly required: boolean;
  readonly driftMs: number;
  readonly thresholdMs: number;
  readonly expectedMusicalTime: number;
  readonly observedVisualTime: number;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

/** Assess visual drift without trying to gradually compensate it frame by frame. */
export function assessSyncRecovery(
  expectedMusicalTime: number,
  observedVisualTime: number,
  thresholdMs = DEFAULT_SYNC_DRIFT_THRESHOLD_MS,
): SyncRecovery {
  finite(expectedMusicalTime, 'expectedMusicalTime');
  finite(observedVisualTime, 'observedVisualTime');
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new RangeError('thresholdMs must be a non-negative finite number');
  }
  const driftMs = Math.abs(expectedMusicalTime - observedVisualTime) * 1000;
  return Object.freeze({
    required: driftMs > thresholdMs,
    driftMs,
    thresholdMs,
    expectedMusicalTime,
    observedVisualTime,
  });
}

/**
 * Bounded development diagnostics. It stores measurements and a small recent
 * event log, never an unbounded per-frame history during long performances.
 */
export class SyncDiagnostics {
  private previousFrameTimestampMs: number | undefined;
  private latest: SyncDiagnosticSnapshot = Object.freeze({
    frameTimestampMs: 0,
    audioTime: 0,
    musicalTime: 0,
    visualTime: 0,
    scheduledEvents: 0,
    activeNotes: 0,
    fps: 0,
    frameTimeMs: 0,
    avOffsetMs: 0,
    avDriftMs: 0,
  });
  private readonly entries: PianistRuntimeLogEntry[] = [];

  constructor(private readonly maxEntries = 128) {
    nonNegativeInteger(maxEntries, 'maxEntries');
  }

  get snapshot(): SyncDiagnosticSnapshot {
    return this.latest;
  }

  get logs(): readonly PianistRuntimeLogEntry[] {
    return Object.freeze([...this.entries]);
  }

  recordFrame(frame: SyncDiagnosticFrame): SyncDiagnosticSnapshot {
    finite(frame.frameTimestampMs, 'frameTimestampMs');
    finite(frame.audioTime, 'audioTime');
    finite(frame.musicalTime, 'musicalTime');
    finite(frame.visualTime, 'visualTime');
    nonNegativeInteger(frame.scheduledEvents, 'scheduledEvents');
    nonNegativeInteger(frame.activeNotes, 'activeNotes');
    const frameTimeMs = this.previousFrameTimestampMs === undefined
      ? 0
      : Math.max(0, frame.frameTimestampMs - this.previousFrameTimestampMs);
    this.previousFrameTimestampMs = frame.frameTimestampMs;
    this.latest = Object.freeze({
      ...frame,
      fps: frameTimeMs === 0 ? 0 : 1000 / frameTimeMs,
      frameTimeMs,
      // audioTime is the raw AudioContext clock, whereas musicalTime maps it
      // through seek/rate. Compare visual state against musical time so a
      // legitimate seek or rate change is not reported as A/V drift.
      avOffsetMs: (frame.visualTime - frame.musicalTime) * 1000,
      avDriftMs: Math.abs(frame.visualTime - frame.musicalTime) * 1000,
    });
    return this.latest;
  }

  assess(observedVisualTime: number, thresholdMs = DEFAULT_SYNC_DRIFT_THRESHOLD_MS): SyncRecovery {
    return assessSyncRecovery(this.latest.musicalTime, observedVisualTime, thresholdMs);
  }

  log(entry: PianistRuntimeLogEntry): void {
    finite(entry.musicalTime, 'entry.musicalTime');
    this.entries.push(Object.freeze({ ...entry }));
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }
}
