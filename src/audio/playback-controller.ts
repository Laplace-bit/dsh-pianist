import type { TimelineData } from '../core/types.js';
import { MusicalClock } from './musical-clock.js';
import { Scheduler } from './scheduler.js';
import type { PianoEngine } from './types.js';

/** The single authoritative playback state exposed to UI and visual consumers. */
export type PlaybackControllerState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'ended'
  | 'error';

/** The narrow scheduler surface the controller needs to coordinate playback. */
export interface PlaybackScheduler {
  update(): void;
  seek(musicalTime: number, restoreActiveVoices?: boolean): void;
  updateTimeline?(timeline: TimelineData): void;
  setLookaheadSeconds?(seconds: number): void;
  readonly scheduledCount?: number;
}

const FOREGROUND_LOOKAHEAD_SECONDS = 0.12;
const BACKGROUND_LOOKAHEAD_SECONDS = 90;

export type PlaybackSchedulerFactory = (
  timeline: TimelineData,
  engine: PianoEngine,
  clock: MusicalClock,
) => PlaybackScheduler;

export interface PlaybackControllerOptions {
  clock: MusicalClock;
  engine: PianoEngine;
  timeline?: TimelineData;
  schedulerFactory?: PlaybackSchedulerFactory;
  /**
   * Optional browser wake-up cadence for refreshing the audio lookahead.
   * This timer never measures musical time: Scheduler always reads the
   * AudioContext-backed MusicalClock. Keeping it opt-in preserves the manual
   * update surface used by non-browser consumers and focused tests.
   */
  schedulerWakeupMilliseconds?: number;
}

function defaultSchedulerFactory(
  timeline: TimelineData,
  engine: PianoEngine,
  clock: MusicalClock,
): PlaybackScheduler {
  return new Scheduler(timeline, engine, clock);
}

function clampTime(time: number, duration: number): number {
  if (Number.isNaN(time)) {
    return 0;
  }
  return Math.min(Math.max(time, 0), duration);
}

/**
 * Coordinates one clock, scheduler, engine, and timeline.
 *
 * Event indexing and scheduling remain inside Scheduler. The controller only
 * owns state transitions, time bounds, and voice cleanup.
 */
export class PlaybackController {
  private timeline: TimelineData | undefined;
  private scheduler: PlaybackScheduler | undefined;
  private readonly schedulerFactory: PlaybackSchedulerFactory;
  private readonly schedulerWakeupMilliseconds: number | undefined;
  private schedulerWakeup: ReturnType<typeof setTimeout> | undefined;
  private _state: PlaybackControllerState = 'idle';
  private _lastError: unknown;

  constructor(private readonly options: PlaybackControllerOptions) {
    this.schedulerFactory = options.schedulerFactory ?? defaultSchedulerFactory;
    if (options.schedulerWakeupMilliseconds !== undefined
      && (!Number.isFinite(options.schedulerWakeupMilliseconds) || options.schedulerWakeupMilliseconds <= 0)) {
      throw new RangeError('schedulerWakeupMilliseconds must be a positive finite number');
    }
    this.schedulerWakeupMilliseconds = options.schedulerWakeupMilliseconds;
    if (options.timeline !== undefined) {
      this.installTimeline(options.timeline);
      this._state = 'ready';
    }
  }

  get state(): PlaybackControllerState {
    return this._state;
  }

  get lastError(): unknown {
    return this._lastError;
  }

  get playbackRate(): number {
    return this.options.clock.rate;
  }

  get duration(): number {
    return this.timeline?.durationSeconds ?? 0;
  }

  get currentTime(): number {
    return this.getCurrentTime();
  }

  /** Number of timeline events currently handed to the audio scheduler. */
  get scheduledEvents(): number {
    return this.scheduler?.scheduledCount ?? 0;
  }

  /** Replace the active timeline and discard scheduled audio from the old one. */
  load(timeline: TimelineData): void {
    this.stopSchedulerWakeups();
    this._state = 'loading';
    this._lastError = undefined;

    try {
      this.releaseAllVoices();
      this.resetClock();
      this.installTimeline(timeline);
      this._state = 'ready';
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Replace an immutable score prefix while preserving the playing clock and
   * voices already scheduled from an earlier prefix.
   */
  updateTimeline(timeline: TimelineData): void {
    if (!Number.isFinite(timeline.durationSeconds) || timeline.durationSeconds < 0) {
      throw new Error('timeline duration must be a non-negative finite number');
    }
    const previousState = this._state;
    const currentTime = this.getCurrentTime();
    this.timeline = timeline;
    if (this.scheduler?.updateTimeline === undefined) {
      this.installTimeline(timeline);
      this.options.clock.seek(Math.min(currentTime, timeline.durationSeconds));
      this._state = previousState === 'playing' ? 'paused' : previousState;
      return;
    }
    this.scheduler.updateTimeline(timeline);
    if (previousState === 'ended' && currentTime < timeline.durationSeconds) {
      this.options.clock.seek(currentTime);
      this._state = 'paused';
    }
    if (this._state === 'playing') this.scheduler.update();
  }

  /** Keep Web Audio fed when background-tab timer throttling becomes coarse. */
  setSchedulingMode(mode: 'foreground' | 'background'): void {
    this.scheduler?.setLookaheadSeconds?.(
      mode === 'background' ? BACKGROUND_LOOKAHEAD_SECONDS : FOREGROUND_LOOKAHEAD_SECONDS,
    );
    if (this._state === 'playing') this.scheduler?.update();
  }

  play(): void {
    if (this.timeline === undefined || this.scheduler === undefined || this._state === 'error') {
      return;
    }
    if (this._state === 'playing') {
      return;
    }

    try {
      if (this.duration === 0) {
        this.end();
        return;
      }
      if (this._state === 'ended' || this.getCurrentTime() >= this.duration) {
        this.seek(0);
      }

      const startTime = this.getCurrentTime();
      // A timeline may be positioned before its first play(), for example
      // after an explicit seek or after recreating an audio graph. In either
      // case, notes spanning startTime must be restored without replaying
      // their attacks, just as they are after an ordinary pause/resume.
      if (this._state === 'paused' || startTime > 0) {
        this.scheduler.seek(startTime, true);
      }

      this.options.clock.play();
      this._state = 'playing';
      this.scheduler.update();
      this.startSchedulerWakeups();
    } catch (error) {
      this.fail(error);
    }
  }

  pause(): void {
    this.stopSchedulerWakeups();
    if (this._state !== 'playing' || this.scheduler === undefined) {
      return;
    }

    try {
      this.options.clock.pause();
      const currentTime = this.getCurrentTime();
      this.options.clock.seek(currentTime);
      // Cancels lookahead audio and lets Scheduler choose the next event.
      this.scheduler.seek(currentTime);
      this._state = 'paused';
    } catch (error) {
      this.fail(error);
    }
  }

  seek(time: number): void {
    if (this.timeline === undefined || this.scheduler === undefined || this._state === 'error') {
      return;
    }

    const previousState = this._state;
    const target = clampTime(time, this.duration);
    this._state = 'seeking';

    try {
      this.options.clock.seek(target);
      if (target >= this.duration) {
        this.end();
        return;
      }

      // Scheduler owns event lookup and any implementation-specific index.
      this.scheduler.seek(target, previousState === 'playing');

      this._state = previousState === 'playing' ? 'playing' : previousState === 'paused' ? 'paused' : 'ready';
      if (this._state === 'playing') {
        this.scheduler.update();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  stop(): void {
    this.stopSchedulerWakeups();
    try {
      this.resetClock();
      if (this.scheduler !== undefined) {
        this.scheduler.seek(0);
      } else {
        this.releaseAllVoices();
      }
      this._state = this.timeline === undefined ? 'idle' : 'ready';
    } catch (error) {
      this.fail(error);
    }
  }

  setPlaybackRate(rate: number): void {
    try {
      const currentTime = this.getCurrentTime();
      if (this.scheduler !== undefined) {
        this.options.clock.seek(currentTime);
        this.scheduler.seek(currentTime, this._state === 'playing');
      }
      this.options.clock.setRate(rate);
      // Re-anchor explicitly so rate changes preserve time across clock versions.
      this.options.clock.seek(currentTime);

      if (this._state === 'playing') {
        this.scheduler?.update();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** Call from the rendering or audio update loop while playback is active. */
  update(): void {
    if (this._state !== 'playing' || this.scheduler === undefined) {
      return;
    }

    try {
      if (this.getCurrentTime() >= this.duration) {
        this.end();
        return;
      }
      this.scheduler.update();
    } catch (error) {
      this.fail(error);
    }
  }

  getCurrentTime(): number {
    if (this.timeline === undefined) {
      return 0;
    }
    return clampTime(this.options.clock.currentTime, this.duration);
  }

  private installTimeline(timeline: TimelineData): void {
    if (!Number.isFinite(timeline.durationSeconds) || timeline.durationSeconds < 0) {
      throw new Error('timeline duration must be a non-negative finite number');
    }
    this.timeline = timeline;
    this.scheduler = this.schedulerFactory(timeline, this.options.engine, this.options.clock);
  }

  private end(): void {
    if (this._state === 'ended') {
      return;
    }
    this.stopSchedulerWakeups();
    this.options.clock.seek(this.duration);
    this.options.clock.end();
    this.releaseAllVoices();
    this._state = 'ended';
  }

  private resetClock(): void {
    const rate = this.options.clock.rate;
    this.options.clock.reset();
    if (rate !== 1) {
      this.options.clock.setRate(rate);
    }
  }

  private releaseAllVoices(): void {
    this.options.engine.allNotesOff(this.options.clock.toContextTime(this.getCurrentTime()));
  }

  private fail(error: unknown): never {
    this.stopSchedulerWakeups();
    this._lastError = error;
    this._state = 'error';
    throw error;
  }

  private startSchedulerWakeups(): void {
    if (this.schedulerWakeupMilliseconds === undefined
      || this.schedulerWakeup !== undefined
      || this._state !== 'playing') {
      return;
    }
    this.schedulerWakeup = setTimeout(() => {
      this.schedulerWakeup = undefined;
      this.update();
      this.startSchedulerWakeups();
    }, this.schedulerWakeupMilliseconds);
  }

  private stopSchedulerWakeups(): void {
    if (this.schedulerWakeup === undefined) {
      return;
    }
    clearTimeout(this.schedulerWakeup);
    this.schedulerWakeup = undefined;
  }
}
