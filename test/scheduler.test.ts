import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/audio/scheduler.js';
import { MusicalClock } from '../src/audio/musical-clock.js';
import { buildTimeline } from '../src/core/timeline.js';
import type { RestoredPianoNote } from '../src/audio/types.js';
import type { PerformanceEvent, Score, TimelineData } from '../src/core/types.js';

class FakeContext {
  now = 0;
  get currentTime(): number {
    return this.now;
  }
}

class FakeEngine {
  sampleRate = 44100;
  noteOnCalls: Array<{ id: string; midi: number; velocity: number; when: number }> = [];
  noteOffCalls: Array<{ id: string; when: number }> = [];
  pedalCalls: Array<{ value: number; when: number }> = [];
  restoredNotes: RestoredPianoNote[] = [];

  noteOn(id: string, midi: number, velocity: number, when: number): void {
    this.noteOnCalls.push({ id, midi, velocity, when });
  }
  noteOff(id: string, when: number): void {
    this.noteOffCalls.push({ id, when });
  }
  setPedal(value: number, when: number): void {
    this.pedalCalls.push({ value, when });
  }
  restoreNote(note: RestoredPianoNote): void {
    this.restoredNotes.push(note);
  }
  allNotesOff(): void {
    // no-op fake
  }
  init(): void {
    // no-op fake
  }
  dispose(): void {
    // no-op fake
  }
}

function score(): Score {
  return {
    id: 's',
    title: 'Scheduler',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 120 }],
    timeSignatureMap: [],
    tracks: [
      {
        id: 't',
        instrument: { id: 'piano' },
        voices: [
          {
            id: 'v',
            events: [
              { id: 'n1', type: 'note', midi: 60, startTick: 0n, durationTicks: 480n, velocity: 0.8, voiceId: 'v', trackId: 't' },
              { id: 'n2', type: 'note', midi: 64, startTick: 480n, durationTicks: 480n, velocity: 0.7, voiceId: 'v', trackId: 't' },
            ],
          },
        ],
      },
    ],
  };
}

function halfPedalScore(): Score {
  return {
    id: 'pedal',
    title: 'Half pedal',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 120 }],
    timeSignatureMap: [],
    tracks: [{
      id: 't',
      instrument: { id: 'piano' },
      voices: [{
        id: 'v',
        events: [
          { id: 'pedal', type: 'pedal', startTick: 0n, endTick: 480n, value: 0.5, voiceId: 'v', trackId: 't' },
        ],
      }],
    }],
  };
}

describe('Scheduler', () => {
  it('schedules lookahead events exactly once', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    clock.play();
    const engine = new FakeEngine();
    const timeline = buildTimeline(score());
    const scheduler = new Scheduler(timeline, engine, clock, 0.1);
    scheduler.update();
    expect(engine.noteOnCalls).toHaveLength(1);
    expect(engine.noteOnCalls[0].midi).toBe(60);
    expect(engine.noteOffCalls).toHaveLength(0);
    scheduler.update();
    expect(engine.noteOnCalls).toHaveLength(1);
    context.now = 0.3;
    scheduler.update();
    expect(engine.noteOnCalls).toHaveLength(2);
    expect(engine.noteOffCalls).toHaveLength(1);
    expect(engine.noteOffCalls[0].id).toBe('n1');
  });

  it('seeks to the right event index', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    const engine = new FakeEngine();
    const timeline = buildTimeline(score());
    const scheduler = new Scheduler(timeline, engine, clock);
    scheduler.seek(0.25);
    expect(scheduler.currentIndex).toBe(2);
  });

  it('does not schedule while paused', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    const engine = new FakeEngine();
    const scheduler = new Scheduler(buildTimeline(score()), engine, clock);

    scheduler.update();
    expect(engine.noteOnCalls).toEqual([]);

    clock.play();
    scheduler.update();
    expect(engine.noteOnCalls).toHaveLength(1);
  });

  it('passes a half-pedal value and the subsequent pedal-up to the engine', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    const engine = new FakeEngine();
    const scheduler = new Scheduler(buildTimeline(halfPedalScore()), engine, clock, 0.1);

    clock.play();
    scheduler.update();
    expect(engine.pedalCalls).toEqual([{ value: 0.5, when: 0 }]);

    context.now = 0.2;
    scheduler.update();
    expect(engine.pedalCalls).toEqual([
      { value: 0.5, when: 0 },
      { value: 0, when: 0.25 },
    ]);
  });

  it('reconstructs an active note without dispatching its attack after seek', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    const engine = new FakeEngine();
    const scheduler = new Scheduler(buildTimeline(score()), engine, clock);

    scheduler.seek(0.1, true);

    expect(engine.noteOnCalls).toEqual([]);
    expect(engine.restoredNotes).toEqual([
      expect.objectContaining({ id: 'n1', midi: 60, offsetSeconds: 0.1, keyDown: true }),
    ]);
    expect(engine.pedalCalls).toEqual([
      { value: 0, when: 0 },
      { value: 0, when: 0 },
    ]);
  });

  it('does not replay a note-on that occurs exactly at a restoring seek boundary', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    const engine = new FakeEngine();
    const scheduler = new Scheduler(buildTimeline(score()), engine, clock);

    scheduler.seek(0, true);
    clock.play();
    scheduler.update();

    expect(engine.restoredNotes).toEqual([
      expect.objectContaining({ id: 'n1', offsetSeconds: 0, keyDown: true }),
    ]);
    expect(engine.noteOnCalls).toEqual([]);
  });

  it('keeps an initial note-on for a non-restoring seek before playback starts', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    const engine = new FakeEngine();
    const scheduler = new Scheduler(buildTimeline(score()), engine, clock);

    scheduler.seek(0);
    clock.play();
    scheduler.update();

    expect(engine.restoredNotes).toEqual([]);
    expect(engine.noteOnCalls).toHaveLength(1);
  });

  it('does not drop one-per-second events across a 60-minute deterministic timeline', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    const engine = new FakeEngine();
    const timeline = longTimeline(60 * 60);
    const scheduler = new Scheduler(timeline, engine, clock, 0.12);

    clock.play();
    for (let second = 0; second < 60 * 60; second += 1) {
      context.now = second;
      scheduler.update();
    }

    expect(engine.noteOnCalls).toHaveLength(60 * 60);
    expect(engine.noteOffCalls).toHaveLength(60 * 60);
    expect(scheduler.scheduledCount).toBe(timeline.events.length);
  });
});

function longTimeline(seconds: number): TimelineData {
  const events: PerformanceEvent[] = [];
  for (let second = 0; second < seconds; second += 1) {
    const id = `long-${String(second)}`;
    events.push(
      { id: `${id}:on`, type: 'noteOn', time: second, tick: BigInt(second), noteId: id, midi: 60, velocity: 0.7 },
      { id: `${id}:off`, type: 'noteOff', time: second + 0.05, tick: BigInt(second) + 1n, noteId: id, midi: 60 },
    );
  }
  return {
    ppq: 960,
    durationTicks: BigInt(seconds),
    durationSeconds: seconds,
    events,
  };
}
