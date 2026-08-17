import { describe, expect, it, vi } from 'vitest';
import { MusicalClock } from '../src/audio/musical-clock.js';
import {
  PlaybackController,
  type PlaybackControllerState,
  type PlaybackScheduler,
} from '../src/audio/playback-controller.js';
import type { PianoEngine, RestoredPianoNote } from '../src/audio/types.js';
import type { TimelineData } from '../src/core/types.js';

class FakeContext {
  now = 0;

  get currentTime(): number {
    return this.now;
  }

  advance(seconds: number): void {
    this.now += seconds;
  }
}

class FakeEngine implements PianoEngine {
  sampleRate = 44_100;
  noteOnCalls: Array<{ id: string; midi: number; velocity: number; when: number }> = [];
  noteOffCalls: Array<{ id: string; when: number }> = [];
  allNotesOffCalls: Array<number | undefined> = [];
  restoredNotes: RestoredPianoNote[] = [];

  init(_context: BaseAudioContext): void {
    // Test double.
  }

  noteOn(id: string, midi: number, velocity: number, when: number): void {
    this.noteOnCalls.push({ id, midi, velocity, when });
  }

  noteOff(id: string, when: number): void {
    this.noteOffCalls.push({ id, when });
  }

  setPedal(_value: number, _when: number): void {
    // Test double.
  }

  restoreNote(note: RestoredPianoNote): void {
    this.restoredNotes.push(note);
  }

  allNotesOff(when?: number): void {
    this.allNotesOffCalls.push(when);
  }

  dispose(): void {
    // Test double.
  }
}

function timeline(durationSeconds = 1): TimelineData {
  return {
    ppq: 960,
    durationTicks: 960n,
    durationSeconds,
    events: [
      {
        id: 'n1:on',
        type: 'noteOn',
        time: 0,
        tick: 0n,
        noteId: 'n1',
        midi: 60,
        velocity: 0.8,
      },
      {
        id: 'n1:off',
        type: 'noteOff',
        time: durationSeconds,
        tick: 960n,
        noteId: 'n1',
        midi: 60,
      },
    ],
  };
}

function createController(durationSeconds = 1): {
  context: FakeContext;
  engine: FakeEngine;
  controller: PlaybackController;
} {
  const context = new FakeContext();
  const engine = new FakeEngine();
  const controller = new PlaybackController({
    clock: new MusicalClock(context),
    engine,
    timeline: timeline(durationSeconds),
  });

  return { context, engine, controller };
}

describe('PlaybackController', () => {
  it('pauses without advancing and resumes from the same musical time', () => {
    const { context, controller, engine } = createController();

    expect(controller.state).toBe<PlaybackControllerState>('ready');
    controller.play();
    expect(controller.state).toBe('playing');
    expect(engine.noteOnCalls).toHaveLength(1);
    expect(engine.restoredNotes).toEqual([]);

    context.advance(0.3);
    controller.update();
    controller.pause();

    expect(controller.state).toBe('paused');
    expect(controller.getCurrentTime()).toBeCloseTo(0.3, 10);
    expect(engine.allNotesOffCalls).toHaveLength(1);
    expect(engine.allNotesOffCalls[0]).toBeCloseTo(0.3, 10);

    context.advance(5);
    controller.update();
    expect(controller.getCurrentTime()).toBeCloseTo(0.3, 10);

    controller.play();
    expect(controller.state).toBe('playing');
    expect(engine.noteOnCalls).toHaveLength(1);
    expect(engine.restoredNotes).toEqual([
      expect.objectContaining({ id: 'n1', offsetSeconds: 0.3, keyDown: true }),
    ]);
  });

  it('extends a playing timeline without releasing active voices or resetting musical time', () => {
    const { context, controller, engine } = createController(1);
    controller.play();
    context.advance(0.25);
    const releasesBefore = engine.allNotesOffCalls.length;

    controller.updateTimeline(timeline(2));

    expect(controller.state).toBe('playing');
    expect(controller.currentTime).toBeCloseTo(0.25, 12);
    expect(controller.duration).toBe(2);
    expect(engine.allNotesOffCalls).toHaveLength(releasesBefore);
  });

  it('seeks while active without replaying an earlier note attack', () => {
    const { context, controller, engine } = createController();

    controller.play();
    context.advance(0.25);
    controller.update();

    controller.seek(0.5);

    expect(controller.state).toBe('playing');
    expect(controller.getCurrentTime()).toBeCloseTo(0.5, 10);
    expect(engine.noteOnCalls).toHaveLength(1);
    expect(engine.allNotesOffCalls).toHaveLength(1);
    expect(engine.restoredNotes).toEqual([
      expect.objectContaining({ id: 'n1', offsetSeconds: 0.5, keyDown: true }),
    ]);

    controller.update();
    expect(engine.noteOnCalls).toHaveLength(1);
  });

  it('restores a held note when first starting from a nonzero seek position', () => {
    const { controller, engine } = createController();

    controller.seek(0.3);
    expect(controller.state).toBe('ready');
    expect(engine.restoredNotes).toEqual([]);

    controller.play();

    expect(controller.state).toBe('playing');
    expect(engine.noteOnCalls).toEqual([]);
    expect(engine.restoredNotes).toEqual([
      expect.objectContaining({ id: 'n1', offsetSeconds: 0.3, keyDown: true }),
    ]);
  });

  it('preserves musical time while changing the playback rate', () => {
    const { context, controller } = createController(2);

    controller.play();
    context.advance(0.25);
    controller.update();
    controller.setPlaybackRate(2);

    expect(controller.playbackRate).toBe(2);
    expect(controller.getCurrentTime()).toBeCloseTo(0.25, 10);

    context.advance(0.25);
    controller.update();
    expect(controller.getCurrentTime()).toBeCloseTo(0.75, 10);
  });

  it('stops at zero and releases scheduled voices', () => {
    const { context, controller, engine } = createController();

    controller.play();
    context.advance(0.2);
    controller.update();
    controller.stop();

    expect(controller.state).toBe('ready');
    expect(controller.getCurrentTime()).toBe(0);
    expect(engine.allNotesOffCalls).toHaveLength(1);

    controller.play();
    expect(engine.noteOnCalls).toHaveLength(2);
  });

  it('clamps explicit seeks to the playable timeline bounds', () => {
    const { controller, engine } = createController();

    controller.seek(-1);
    expect(controller.state).toBe('ready');
    expect(controller.getCurrentTime()).toBe(0);
    const releasesBeforeEndSeek = engine.allNotesOffCalls.length;

    controller.seek(5);
    expect(controller.state).toBe('ended');
    expect(controller.getCurrentTime()).toBe(1);
    expect(engine.allNotesOffCalls).toHaveLength(releasesBeforeEndSeek + 1);
  });

  it('clamps at the end and releases voices exactly once', () => {
    const { context, controller, engine } = createController();

    controller.play();
    context.advance(3);
    controller.update();

    expect(controller.state).toBe('ended');
    expect(controller.getCurrentTime()).toBe(1);
    expect(engine.allNotesOffCalls).toHaveLength(1);

    controller.update();
    expect(engine.allNotesOffCalls).toHaveLength(1);
  });

  it('refreshes the audio lookahead without relying on rendering frames', () => {
    vi.useFakeTimers();
    try {
      const context = new FakeContext();
      const engine = new FakeEngine();
      const scheduler: PlaybackScheduler = {
        update: vi.fn(),
        seek: vi.fn(),
      };
      const controller = new PlaybackController({
        clock: new MusicalClock(context),
        engine,
        timeline: timeline(),
        schedulerFactory: () => scheduler,
        schedulerWakeupMilliseconds: 25,
      });

      controller.play();
      expect(scheduler.update).toHaveBeenCalledTimes(1);

      // No controller.update() or requestAnimationFrame call occurs here.
      vi.advanceTimersByTime(25);
      expect(scheduler.update).toHaveBeenCalledTimes(2);

      controller.pause();
      vi.advanceTimersByTime(100);
      expect(scheduler.update).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
