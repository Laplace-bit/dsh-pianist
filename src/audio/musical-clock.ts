export type PlaybackState = 'idle' | 'playing' | 'paused' | 'ended';

export interface AudioClockLike {
  readonly currentTime: number;
}

/**
 * Unified musical clock.
 *
 * All consumers read `currentTime`; nobody maintains a second musical clock.
 * The clock is anchored to AudioContext.currentTime while playing, so audio and
 * visual consumers stay on the same timeline.
 */
export class MusicalClock {
  private anchorContextTime = 0;
  private anchorMusicalTime = 0;
  private _rate = 1;
  private _state: PlaybackState = 'paused';

  constructor(private readonly context: AudioClockLike) {}

  get currentTime(): number {
    if (this._state === 'playing') {
      return this.anchorMusicalTime + (this.context.currentTime - this.anchorContextTime) * this._rate;
    }
    return this.anchorMusicalTime;
  }

  get state(): PlaybackState {
    return this._state;
  }

  get rate(): number {
    return this._rate;
  }

  /** Current AudioContext time backing this musical clock. */
  get contextTime(): number {
    return this.context.currentTime;
  }

  play(): void {
    if (this._state === 'playing') {
      return;
    }
    this.anchorContextTime = this.context.currentTime;
    this.anchorMusicalTime = this.currentTime;
    this._state = 'playing';
  }

  pause(): void {
    if (this._state !== 'playing') {
      return;
    }
    this.anchorMusicalTime = this.currentTime;
    this._state = 'paused';
  }

  seek(time: number): void {
    if (time < 0) {
      time = 0;
    }
    this.anchorMusicalTime = time;
    this.anchorContextTime = this.context.currentTime;
  }

  setRate(rate: number): void {
    if (Number.isFinite(rate) === false || rate <= 0) {
      throw new Error('rate must be a positive finite number');
    }
    if (this._state === 'playing') {
      // Read musical time before moving the context anchor. Reversing these
      // assignments discards elapsed playback whenever the rate changes.
      const musicalTime = this.currentTime;
      this.anchorContextTime = this.context.currentTime;
      this.anchorMusicalTime = musicalTime;
    }
    this._rate = rate;
  }

  /** Convert a musical-time value to AudioContext time under the current rate. */
  toContextTime(musicalTime: number): number {
    return this.anchorContextTime + (musicalTime - this.anchorMusicalTime) / this._rate;
  }

  end(): void {
    this.anchorMusicalTime = this.currentTime;
    this._state = 'ended';
  }

  reset(): void {
    this.anchorMusicalTime = 0;
    this.anchorContextTime = this.context.currentTime;
    this._rate = 1;
    this._state = 'paused';
  }
}
