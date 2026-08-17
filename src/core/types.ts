/**
 * Standard Music AST for dsh-pianist.
 *
 * The core uses integer ticks (bigint) as the only musical time source.
 * Floating-point seconds are derived exclusively through the TempoMap.
 */

export const DEFAULT_PPQ = 960;

/** Integer tick offset from the start of the score. */
export type Tick = bigint;

export interface ScoreMetadata {
  composer?: string;
  copyright?: string;
  description?: string;
  source?: string;
}

export interface TempoEvent {
  tick: Tick;
  bpm: number;
}

export interface TimeSignatureEvent {
  tick: Tick;
  numerator: number;
  denominator: number;
}

export interface PianoInstrument {
  id: string;
  name?: string;
  samplePack?: string;
}

export interface NoteEvent {
  id: string;
  type: 'note';
  midi: number;
  startTick: Tick;
  durationTicks: Tick;
  velocity: number;
  voiceId: string;
  trackId: string;
}

export interface RestEvent {
  id: string;
  type: 'rest';
  startTick: Tick;
  durationTicks: Tick;
  voiceId: string;
  trackId: string;
}

export interface ChordNote {
  midi: number;
  durationTicks: Tick;
  velocity: number;
}

export interface ChordEvent {
  id: string;
  type: 'chord';
  startTick: Tick;
  notes: ChordNote[];
  voiceId: string;
  trackId: string;
}

export interface PedalEvent {
  id: string;
  type: 'pedal';
  startTick: Tick;
  endTick: Tick;
  /** 0 = up, 1 = fully down; intermediate values are allowed for half-pedal. */
  value: number;
  voiceId: string;
  trackId: string;
}

export interface TupletEvent {
  id: string;
  type: 'tuplet';
  actual: number;
  normal: number;
  startTick: Tick;
  durationTicks: Tick;
  events: MusicEvent[];
  voiceId: string;
  trackId: string;
}

export type MusicEvent =
  | NoteEvent
  | RestEvent
  | ChordEvent
  | PedalEvent
  | TupletEvent;

export interface Voice {
  id: string;
  events: MusicEvent[];
}

export interface Track {
  id: string;
  channel?: number;
  instrument: PianoInstrument;
  voices: Voice[];
}

export interface Score {
  id: string;
  title: string;
  ppq: number;
  tracks: Track[];
  tempoMap: TempoEvent[];
  timeSignatureMap: TimeSignatureEvent[];
  metadata?: ScoreMetadata;
}

export type PerformanceEventType =
  | 'noteOn'
  | 'noteOff'
  | 'pedalDown'
  | 'pedalUp'
  | 'tempoChange';

export interface PerformanceEvent {
  id: string;
  type: PerformanceEventType;
  /** Absolute seconds according to the score's TempoMap. */
  time: number;
  tick: Tick;
  midi?: number;
  velocity?: number;
  /** Used by noteOn/noteOff to match a note. */
  noteId?: string;
  /** BPM value for tempoChange events. */
  bpm?: number;
  /** Pedal position for pedal events: 0 = up, 1 = fully down. */
  pedalValue?: number;
}

export interface TimelineData {
  ppq: number;
  /**
   * A timeline is a durable musical fact. Playback and rendering may retain
   * cursors into this array, but must never mutate its events or ordering.
   */
  events: readonly PerformanceEvent[];
  durationTicks: Tick;
  durationSeconds: number;
}
