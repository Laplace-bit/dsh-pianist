/**
 * Real-time audio-response analysis for the immersive shell.
 *
 * This is a *visual-only* intensity signal. It is never a musical clock:
 * `MusicalClock` remains the single source of musical time. The analyser taps
 * the engine's master output (not a microphone), so no permission is required,
 * and it only feeds water/ribbon/particle/reflection intensity.
 *
 * Numbers are smoothed with attack/release so loudness changes cannot make the
 * scene twitch. Reading is throttled, and buffers are reused instead of
 * allocating per frame.
 */

/** Smoothed visual-intensity snapshot derived from the master output. */
export interface PianoAudioAnalysis {
  /** Normalised overall loudness (RMS) 0..1, attack/release smoothed. */
  loudness: number;
  /** Normalised low-frequency energy 0..1. */
  low: number;
  /** Normalised mid-frequency energy 0..1. */
  mid: number;
  /** Normalised high-frequency energy 0..1. */
  high: number;
  /** Combined envelope used to drive ripples and ribbon amplitude. */
  energy: number;
  /** Event-driver fallback activity 0..1 (velocity/density) while paused/muted. */
  noteActivity: number;
  /** Whether an AnalyserNode is actually supplying this frame. */
  usingAnalyser: boolean;
}

export interface PianoAudioAnalyzerOptions {
  /** ms between real `getByte*Data` reads; keeps the callback cheap. */
  readIntervalMs?: number;
  /**
   * Attack and release smoothing coefficients in the 0..1 range. Higher value =
   * faster response to that direction. A faster attack / slower release gives a
   * breath-like swell that avoids shimmering.
   */
  attack?: number;
  release?: number;
}

const DEFAULT_OPTIONS: Required<PianoAudioAnalyzerOptions> = {
  readIntervalMs: 60,
  attack: 0.5,
  release: 0.12,
};

const EMPTY_FRAME: Readonly<PianoAudioAnalysis> = Object.freeze({ loudness: 0, low: 0, mid: 0, high: 0, energy: 0, noteActivity: 0, usingAnalyser: false });

function smooth(current: number, target: number, coefficient: number): number {
  if (!Number.isFinite(target) || target < 0) return 0;
  if (!Number.isFinite(current) || current < 0) return target;
  return current + (target - current) * coefficient;
}

/**
 * Creates an AnalyserNode ready to be inserted between an engine's master gain
 * and the destination. Returns `undefined` when the runtime cannot provide one
 * (headless, very old WebKit, some test doubles), in which case callers fall
 * back to `pushNote` velocity/density signals.
 */
export function createMasterAnalyser(context: BaseAudioContext): AnalyserNode | undefined {
  try {
    const analyser = context.createAnalyser();
    if (analyser === undefined) return undefined;
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    return analyser;
  } catch {
    return undefined;
  }
}

export class PianoAudioAnalyzer {
  private readonly options: Required<PianoAudioAnalyzerOptions>;
  private readonly analyser: AnalyserNode | undefined;
  private readonly timeDomain: Uint8Array<ArrayBuffer>;
  private readonly frequency: Uint8Array<ArrayBuffer>;
  private readonly frame: PianoAudioAnalysis;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private activity = 0;
  private activityDecayAt = 0;
  private readonly fftSize: number;

  /**
   * @param analyser The node wired between master gain and destination, or
   *   undefined to run in event-fallback mode.
   * @param context AudioContext to read `currentTime` from for throttling.
   */
  constructor(analyser: AnalyserNode | undefined, private readonly context: BaseAudioContext | null = null, options: PianoAudioAnalyzerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.analyser = analyser;
    this.fftSize = analyser?.fftSize ?? 0;
    this.timeDomain = new Uint8Array(analyser?.fftSize ?? 0);
    this.frequency = new Uint8Array(analyser?.frequencyBinCount ?? 0);
    this.frame = {
      loudness: 0,
      low: 0,
      mid: 0,
      high: 0,
      energy: 0,
      noteActivity: 0,
      usingAnalyser: analyser !== undefined,
    };
  }

  get available(): boolean {
    return this.analyser !== undefined;
  }

  /** Feed an event signal (velocity + event density) as an activity source. */
  pushNote(velocity: number): void {
    const safe = Math.min(1, Math.max(0, velocity));
    this.activity = Math.max(this.activity, safe);
    // Exponential-ish decay handled in read(): each new note re-arms the peak.
    this.activityDecayAt = Math.max(this.activityDecayAt, this.now());
  }

  /** Drop all smoothed activity immediately when transport returns to stop. */
  reset(): void {
    this.activity = 0;
    this.activityDecayAt = 0;
    this.lastReadAt = Number.NEGATIVE_INFINITY;
    this.frame.loudness = 0;
    this.frame.low = 0;
    this.frame.mid = 0;
    this.frame.high = 0;
    this.frame.energy = 0;
    this.frame.noteActivity = 0;
  }

  /**
   * Advance analysis and return the shared, mutated analysis object. The
   * returned object is reused; do not retain it across frames.
   */
  read(): PianoAudioAnalysis {
    const now = this.now();
    const analyser = this.analyser;

    if (analyser !== undefined && now - this.lastReadAt >= this.options.readIntervalMs) {
      this.lastReadAt = now;
      try {
        analyser.getByteTimeDomainData(this.timeDomain);
        analyser.getByteFrequencyData(this.frequency);
        this.frame.loudness = smooth(this.frame.loudness, timeDomainRms(this.timeDomain), this.options.attack);
        const { low, mid, high } = frequencyBands(this.frequency);
        this.frame.low = smooth(this.frame.low, low, this.options.attack);
        this.frame.mid = smooth(this.frame.mid, mid, this.options.attack);
        this.frame.high = smooth(this.frame.high, high, this.options.attack);
      } catch {
        // A detached/closed analyser must not throw into the render loop.
        this.frame.loudness = smooth(this.frame.loudness, 0, this.options.release);
        this.frame.low = smooth(this.frame.low, 0, this.options.release);
        this.frame.mid = smooth(this.frame.mid, 0, this.options.release);
        this.frame.high = smooth(this.frame.high, 0, this.options.release);
      }
      this.frame.energy = clamp01(
        this.frame.loudness * 0.5 + this.frame.low * 0.25 + this.frame.mid * 0.18 + this.frame.high * 0.07,
      );
      this.frame.noteActivity = smooth(this.frame.noteActivity, this.activity, this.options.attack);
      if (now >= this.activityDecayAt) {
        this.activity = smooth(this.activity, 0, this.options.release);
      }
    } else if (analyser === undefined) {
      // Fallback mode: smooth the event activity toward decay.
      this.frame.loudness = smooth(this.frame.loudness, this.activity * 0.5, this.options.attack);
      this.frame.energy = smooth(this.frame.energy, this.activity, this.options.attack);
      this.frame.noteActivity = smooth(this.frame.noteActivity, this.activity, this.options.attack);
      this.frame.low = smooth(this.frame.low, this.activity * 0.4, this.options.attack);
      this.frame.mid = smooth(this.frame.mid, this.activity * 0.35, this.options.attack);
      this.frame.high = smooth(this.frame.high, this.activity * 0.2, this.options.attack);
      if (now >= this.activityDecayAt) {
        this.activity = smooth(this.activity, 0, this.options.release);
      }
    }
    return this.frame;
  }

  /** Reusable read-only empty frame for consumers that construct one once. */
  static get emptyFrame(): Readonly<PianoAudioAnalysis> {
    return EMPTY_FRAME;
  }

  private now(): number {
    if (this.context !== null && typeof this.context.currentTime === 'number') {
      // currentTime only advances while playing/authored; use wall clock for
      // throttling so background tabs still throttle predictably.
      return typeof performance === 'undefined' ? Date.now() : performance.now();
    }
    return typeof performance === 'undefined' ? Date.now() : performance.now();
  }
}

function timeDomainRms(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = (samples[index]! - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / samples.length);
  return clamp01(rms * 2.2);
}

/** Split the frequency bins into rough low/mid/high thirds and normalise. */
function frequencyBands(frequency: Uint8Array): { low: number; mid: number; high: number } {
  const count = frequency.length;
  if (count === 0) return { low: 0, mid: 0, high: 0 };
  const third = Math.max(1, Math.floor(count / 3));
  const low = mean(frequency, 0, Math.min(third, count));
  const mid = mean(frequency, third, Math.min(third * 2, count));
  const high = mean(frequency, third * 2, count);
  return { low, mid, high };
}

function mean(values: Uint8Array, start: number, end: number): number {
  if (start >= end) return 0;
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += values[index]!;
  return clamp01(sum / (end - start) / 255);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
