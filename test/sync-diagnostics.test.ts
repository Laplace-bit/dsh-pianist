import { describe, expect, it } from 'vitest';
import { assessSyncRecovery, SyncDiagnostics } from '../src/sync/diagnostics.js';

describe('sync diagnostics', () => {
  it('measures frame information and keeps a bounded recent-event log', () => {
    const diagnostics = new SyncDiagnostics(2);
    diagnostics.recordFrame({
      frameTimestampMs: 100,
      audioTime: 2,
      musicalTime: 2,
      visualTime: 2,
      scheduledEvents: 4,
      activeNotes: 2,
      expectedEventId: 'c4:on',
      actualEventId: 'c4:on',
    });
    const snapshot = diagnostics.recordFrame({
      frameTimestampMs: 116,
      audioTime: 2.016,
      musicalTime: 2.016,
      visualTime: 2.01,
      scheduledEvents: 5,
      activeNotes: 1,
    });
    diagnostics.log({ type: 'PLAY', musicalTime: 0 });
    diagnostics.log({ type: 'NOTE_ON', musicalTime: 0, eventId: 'c4:on' });
    diagnostics.log({ type: 'STOP', musicalTime: 1 });

    expect(snapshot.frameTimeMs).toBe(16);
    expect(snapshot.fps).toBe(62.5);
    expect(snapshot.avDriftMs).toBeCloseTo(6, 10);
    expect(snapshot.avOffsetMs).toBeCloseTo(-6, 10);
    expect(diagnostics.logs.map(entry => entry.type)).toEqual(['NOTE_ON', 'STOP']);
  });

  it('measures A/V drift in musical time rather than raw AudioContext time after a seek', () => {
    const diagnostics = new SyncDiagnostics();
    const snapshot = diagnostics.recordFrame({
      frameTimestampMs: 1,
      audioTime: 42,
      musicalTime: 1.25,
      visualTime: 1.257,
      scheduledEvents: 0,
      activeNotes: 0,
    });

    expect(snapshot.avOffsetMs).toBeCloseTo(7, 10);
    expect(snapshot.avDriftMs).toBeCloseTo(7, 10);
  });

  it('requests immediate reconstructed state when drift crosses the threshold', () => {
    expect(assessSyncRecovery(1, 1.01, 16).required).toBe(false);
    const recovery = assessSyncRecovery(1, 1.02, 16);
    expect(recovery).toMatchObject({ required: true, expectedMusicalTime: 1, observedVisualTime: 1.02 });
    expect(recovery.driftMs).toBeCloseTo(20, 10);
  });
});
