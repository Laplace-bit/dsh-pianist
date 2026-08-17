import type { PianoSamplePack, PianoSamplePreloadRequest } from './sample-pack.js';

/** A sound already in progress that must be restored after a seek. */
export interface RestoredPianoNote {
  id: string;
  midi: number;
  velocity: number;
  when: number;
  /** How far into the original sounding source playback has progressed. */
  offsetSeconds: number;
  /** Whether the physical key remains down rather than being held by pedal. */
  keyDown: boolean;
}

export interface PianoEngine {
  readonly sampleRate: number;
  init(context: BaseAudioContext): Promise<void> | void;
  noteOn(id: string, midi: number, velocity: number, when: number, duration?: number): void;
  noteOff(id: string, when: number): void;
  setPedal(value: number, when: number): void;
  /** Optional seamless seek hook; implementations must not replay an attack. */
  restoreNote?(note: RestoredPianoNote): void;
  /** Optional live master output adjustment for a Host-accepted config change. */
  setGain?(gain: number, when?: number): void;
  /** Stop all active voices immediately; used on seek. */
  allNotesOff(when?: number): void;
  dispose(): void;
}

export interface PianoEngineOptions {
  /** Use a generated fallback sound when no sample pack is configured. */
  fallbackToGenerated?: boolean;
  /** Release time in seconds. */
  releaseSeconds?: number;
  /** Master gain (0..1). */
  gain?: number;
  /**
   * Optional AnalyserNode inserted between the engine's master gain and the
   * context destination. Used by the immersive shell to read master-output
   * loudness for visual intensity; never used as a musical clock.
   */
  analyser?: AnalyserNode;
  /** Target sample rate when creating a generated engine before init. */
  sampleRate?: number;
}

/** Select the generated fallback explicitly or a preloaded sample pack. */
export type PianoEngineSource = 'generated' | 'sample-pack';

/**
 * Factory-only options for choosing a piano implementation.
 *
 * `source: 'sample-pack'` requires `samplePack`; it never silently creates a
 * generated engine. The generated engine remains the explicit default for
 * callers that do not select a source.
 */
export interface PianoEngineFactoryOptions extends PianoEngineOptions {
  source?: PianoEngineSource;
  samplePack?: PianoSamplePack;
  /** Maximum concurrently sounding sample voices. */
  maxVoices?: number;
  /** Stereo panning spread, from 0 (centre) through 1 (full keyboard width). */
  stereoSpread?: number;
  /** Per-note attack time in seconds. */
  attackSeconds?: number;
  /** Extra release multiplier applied while the sustain pedal is partially down. */
  halfPedalReleaseMultiplier?: number;
  /** Short anti-click release used when a voice is stolen. */
  voiceStealReleaseSeconds?: number;
  /** Exact samples to decode before playback for a score-backed sample pack. */
  preload?: readonly PianoSamplePreloadRequest[];
  /** Load global pedal-action recordings when the timeline contains pedal events. */
  preloadPedalActions?: boolean;
  resonanceGain?: number;
  releaseLayerGain?: number;
  roomGain?: number;
}
