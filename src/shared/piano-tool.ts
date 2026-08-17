import { createPianoPerformancePayload } from '../core/performance-payload.js';
import type {
  MusicEvent,
  Score,
  Track,
} from '../core/types.js';
import { validateScore } from '../core/validator.js';

export const PIANO_TOOL_NAME = 'piano_perform';
export const PIANO_TOOL_CONTRACT_VERSION = 1 as const;
export const PIANO_TOOL_PPQ = 960;

const MAX_NOTE_GROUPS = 4_096;
const MAX_SOUNDED_NOTES = 8_192;
const MAX_PITCHES_PER_GROUP = 16;
const MAX_PEDALS = 256;
const MAX_TEMPO_CHANGES = 128;
const MAX_BEATS = 100_000;

export type PianoToolBeat = number | string;
export type PianoToolPitch = number | string;
export type PianoToolHand = 'left' | 'right';

export interface PianoToolNoteInput {
  pitches: PianoToolPitch[];
  startBeat: PianoToolBeat;
  durationBeats: PianoToolBeat;
  hand?: PianoToolHand;
  velocity?: number;
}

/** Token-efficient alias accepted for long model-generated passages. */
export interface CompactPianoToolNoteInput {
  p: PianoToolPitch | PianoToolPitch[];
  s: PianoToolBeat;
  d: PianoToolBeat;
  h?: 'l' | 'r';
  v?: number;
}

export interface PianoToolPedalInput {
  startBeat: PianoToolBeat;
  endBeat: PianoToolBeat;
  value?: number;
}

export interface PianoToolTempoInput {
  beat: PianoToolBeat;
  bpm: number;
}

export interface PianoToolInput {
  title: string;
  bpm: number;
  notes: Array<PianoToolNoteInput | CompactPianoToolNoteInput>;
  timeSignature?: { numerator: number; denominator: number };
  pedals?: PianoToolPedalInput[];
  tempoChanges?: PianoToolTempoInput[];
  autoplay?: boolean;
}

type JsonMusicEvent = Omit<MusicEvent, 'startTick' | 'durationTicks' | 'endTick' | 'notes' | 'events'> & {
  startTick?: string;
  durationTicks?: string;
  endTick?: string;
  notes?: Array<{ midi: number; durationTicks: string; velocity: number }>;
  events?: JsonMusicEvent[];
};

export interface JsonScore extends Omit<Score, 'tempoMap' | 'timeSignatureMap' | 'tracks'> {
  tempoMap: Array<{ tick: string; bpm: number }>;
  timeSignatureMap: Array<{ tick: string; numerator: number; denominator: number }>;
  tracks: Array<Omit<Track, 'voices'> & {
    voices: Array<{ id: string; events: JsonMusicEvent[] }>;
  }>;
}

export interface PianoPerformanceWirePayload {
  version: 1;
  performanceId: string;
  score: JsonScore;
  duration: number;
  audio: {
    format: 'audioBuffer';
    sampleRate: number;
    channels: number;
  };
  metadata: {
    bpm: number;
    ppq: number;
  };
}

export interface PianoToolResult {
  version: 1;
  performanceId: string;
  title: string;
  noteCount: number;
  autoplay: boolean;
  payload: PianoPerformanceWirePayload;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Validate the shallow envelope crossing the Host/browser boundary.
 * Score contents are deliberately validated by `normalizeScore` and
 * `validateScore` at the playback boundary, where the consumer has context.
 */
export function parsePianoToolResult(value: unknown): PianoToolResult | undefined {
  const root = jsonRecord(value);
  if (root?.version !== PIANO_TOOL_CONTRACT_VERSION
    || typeof root.performanceId !== 'string'
    || root.performanceId.length === 0
    || typeof root.title !== 'string'
    || !Number.isInteger(root.noteCount)
    || (root.noteCount as number) < 0
    || typeof root.autoplay !== 'boolean') {
    return undefined;
  }
  const payload = jsonRecord(root.payload);
  const audio = jsonRecord(payload?.audio);
  const metadata = jsonRecord(payload?.metadata);
  if (payload?.version !== PIANO_TOOL_CONTRACT_VERSION
    || payload.performanceId !== root.performanceId
    || jsonRecord(payload.score) === undefined
    || typeof payload.duration !== 'number'
    || !Number.isFinite(payload.duration)
    || payload.duration < 0
    || audio?.format !== 'audioBuffer'
    || typeof audio.sampleRate !== 'number'
    || !Number.isFinite(audio.sampleRate)
    || typeof audio.channels !== 'number'
    || !Number.isInteger(audio.channels)
    || metadata === undefined
    || typeof metadata.bpm !== 'number'
    || typeof metadata.ppq !== 'number') {
    return undefined;
  }
  return root as unknown as PianoToolResult;
}

export class PianoToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PianoToolInputError';
  }
}

function inputRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PianoToolInputError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PianoToolInputError(`${path} must be a finite number`);
  }
  return value;
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  const number = finiteNumber(value, path);
  if (number < minimum || number > maximum) {
    throw new PianoToolInputError(`${path} must be in [${minimum}, ${maximum}]`);
  }
  return number;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  const number = finiteNumber(value, path);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new PianoToolInputError(`${path} must be an integer in [${minimum}, ${maximum}]`);
  }
  return number;
}

function beatNumber(value: unknown, path: string): number {
  let beat: number;
  if (typeof value === 'number') {
    beat = value;
  } else if (typeof value === 'string') {
    const fraction = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(value.trim());
    if (fraction !== null) {
      const denominator = Number(fraction[2]);
      if (denominator === 0) throw new PianoToolInputError(`${path} denominator must not be zero`);
      beat = Number(fraction[1]) / denominator;
    } else if (value.trim() !== '') {
      beat = Number(value);
    } else {
      beat = Number.NaN;
    }
  } else {
    beat = Number.NaN;
  }
  if (!Number.isFinite(beat) || beat < 0 || beat > MAX_BEATS) {
    throw new PianoToolInputError(`${path} must be a beat value in [0, ${MAX_BEATS}]`);
  }
  return beat;
}

function beatTicks(value: unknown, path: string, positive = false): bigint {
  const ticks = Math.round(beatNumber(value, path) * PIANO_TOOL_PPQ);
  if (!Number.isSafeInteger(ticks) || (positive ? ticks <= 0 : ticks < 0)) {
    throw new PianoToolInputError(`${path} is too small or too large for the ${PIANO_TOOL_PPQ} PPQ grid`);
  }
  return BigInt(ticks);
}

const PITCH_CLASS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Convert MIDI or scientific pitch notation (C4 = MIDI 60) to one piano key. */
export function pianoPitchToMidi(value: unknown, path = 'pitch'): number {
  let midi: number;
  if (typeof value === 'number') {
    midi = value;
  } else if (typeof value === 'string') {
    const match = /^([A-Ga-g])([#b]?)(-1|[0-9])$/.exec(value.trim());
    if (match === null) {
      throw new PianoToolInputError(`${path} must be MIDI 21-108 or scientific pitch notation such as C4, F#4, or Bb3`);
    }
    const letter = match[1]!.toUpperCase();
    const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
    const octave = Number(match[3]);
    midi = (octave + 1) * 12 + PITCH_CLASS[letter]! + accidental;
  } else {
    throw new PianoToolInputError(`${path} must be a MIDI number or scientific pitch string`);
  }
  if (!Number.isInteger(midi) || midi < 21 || midi > 108) {
    throw new PianoToolInputError(`${path} resolves to MIDI ${midi}; an 88-key piano accepts 21-108`);
  }
  return midi;
}

function serializeEvent(event: MusicEvent): JsonMusicEvent {
  if (event.type === 'note' || event.type === 'rest') {
    return { ...event, startTick: String(event.startTick), durationTicks: String(event.durationTicks) };
  }
  if (event.type === 'chord') {
    return {
      ...event,
      startTick: String(event.startTick),
      notes: event.notes.map(note => ({ ...note, durationTicks: String(note.durationTicks) })),
    };
  }
  if (event.type === 'pedal') {
    return { ...event, startTick: String(event.startTick), endTick: String(event.endTick) };
  }
  return {
    ...event,
    startTick: String(event.startTick),
    durationTicks: String(event.durationTicks),
    events: event.events.map(serializeEvent),
  };
}

export function serializePianoScore(score: Score): JsonScore {
  return {
    ...score,
    tempoMap: score.tempoMap.map(event => ({ ...event, tick: String(event.tick) })),
    timeSignatureMap: score.timeSignatureMap.map(event => ({ ...event, tick: String(event.tick) })),
    tracks: score.tracks.map(track => ({
      ...track,
      voices: track.voices.map(voice => ({
        ...voice,
        events: voice.events.map(serializeEvent),
      })),
    })),
  };
}

function trackFor(hand: PianoToolHand, events: MusicEvent[]): Track {
  const trackId = `${hand}-hand`;
  const voiceId = `${hand}-voice`;
  for (const event of events) {
    event.trackId = trackId;
    event.voiceId = voiceId;
  }
  events.sort((left, right) => {
    const tickOrder = Number(BigInt(left.startTick) - BigInt(right.startTick));
    return tickOrder === 0 ? left.id.localeCompare(right.id) : tickOrder;
  });
  return {
    id: trackId,
    channel: hand === 'left' ? 0 : 1,
    instrument: { id: 'acoustic-grand-piano', name: 'Acoustic Grand Piano' },
    voices: [{ id: voiceId, events }],
  };
}

function parseTimeSignature(value: unknown): { numerator: number; denominator: number } {
  if (value === undefined) return { numerator: 4, denominator: 4 };
  const record = inputRecord(value, 'timeSignature');
  const numerator = integer(record.numerator, 'timeSignature.numerator', 1, 32);
  const denominator = integer(record.denominator, 'timeSignature.denominator', 1, 64);
  if ((denominator & (denominator - 1)) !== 0) {
    throw new PianoToolInputError('timeSignature.denominator must be a power of two');
  }
  return { numerator, denominator };
}

function parseInput(input: unknown): PianoToolInput {
  const root = inputRecord(input, 'piano_perform arguments');
  const title = root.title;
  if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
    throw new PianoToolInputError('title must be a non-empty string no longer than 200 characters');
  }
  const bpm = boundedNumber(root.bpm, 'bpm', 20, 400);
  if (!Array.isArray(root.notes) || root.notes.length === 0 || root.notes.length > MAX_NOTE_GROUPS) {
    throw new PianoToolInputError(`notes must contain 1-${MAX_NOTE_GROUPS} note groups`);
  }
  if (root.pedals !== undefined && (!Array.isArray(root.pedals) || root.pedals.length > MAX_PEDALS)) {
    throw new PianoToolInputError(`pedals must be an array with at most ${MAX_PEDALS} entries`);
  }
  if (root.tempoChanges !== undefined
    && (!Array.isArray(root.tempoChanges) || root.tempoChanges.length > MAX_TEMPO_CHANGES)) {
    throw new PianoToolInputError(`tempoChanges must be an array with at most ${MAX_TEMPO_CHANGES} entries`);
  }
  if (root.autoplay !== undefined && typeof root.autoplay !== 'boolean') {
    throw new PianoToolInputError('autoplay must be a boolean');
  }
  return {
    title: title.trim(),
    bpm,
    notes: root.notes as PianoToolNoteInput[],
    timeSignature: parseTimeSignature(root.timeSignature),
    pedals: (root.pedals ?? []) as PianoToolPedalInput[],
    tempoChanges: (root.tempoChanges ?? []) as PianoToolTempoInput[],
    autoplay: root.autoplay ?? true,
  };
}

function parseNoteInput(candidate: unknown, index: number): PianoToolNoteInput {
  const note = inputRecord(candidate, `notes[${index}]`);
  const compact = Object.hasOwn(note, 'p') || Object.hasOwn(note, 's') || Object.hasOwn(note, 'd');
  if (!compact) return note as unknown as PianoToolNoteInput;
  const pitch = note.p;
  const pitches = Array.isArray(pitch) ? pitch : [pitch];
  const hand = note.h === undefined ? undefined : note.h === 'l' ? 'left' : note.h === 'r' ? 'right' : note.h;
  return {
    pitches: pitches as PianoToolPitch[],
    startBeat: note.s as PianoToolBeat,
    durationBeats: note.d as PianoToolBeat,
    ...(hand === undefined ? {} : { hand: hand as PianoToolHand }),
    ...(note.v === undefined ? {} : { velocity: note.v as number }),
  };
}

/** Compile model-friendly sheet events to the package's canonical Score and wire payload. */
export function compilePianoPerformance(input: unknown, performanceId: string): PianoToolResult {
  if (typeof performanceId !== 'string' || performanceId.trim() === '') {
    throw new PianoToolInputError('performanceId must be a non-empty string');
  }
  const parsed = parseInput(input);
  const handEvents: Record<PianoToolHand, MusicEvent[]> = { left: [], right: [] };
  let noteCount = 0;

  parsed.notes.forEach((candidate, index) => {
    const note = parseNoteInput(candidate, index) as unknown as Record<string, unknown>;
    if (!Array.isArray(note.pitches) || note.pitches.length === 0 || note.pitches.length > MAX_PITCHES_PER_GROUP) {
      throw new PianoToolInputError(`notes[${index}].pitches must contain 1-${MAX_PITCHES_PER_GROUP} pitches`);
    }
    noteCount += note.pitches.length;
    if (noteCount > MAX_SOUNDED_NOTES) {
      throw new PianoToolInputError(`the performance may contain at most ${MAX_SOUNDED_NOTES} sounded notes`);
    }
    const pitches = note.pitches.map((pitch, pitchIndex) =>
      pianoPitchToMidi(pitch, `notes[${index}].pitches[${pitchIndex}]`));
    const startTick = beatTicks(note.startBeat, `notes[${index}].startBeat`);
    const durationTicks = beatTicks(note.durationBeats, `notes[${index}].durationBeats`, true);
    const hand = note.hand === undefined ? 'right' : note.hand;
    if (hand !== 'left' && hand !== 'right') {
      throw new PianoToolInputError(`notes[${index}].hand must be "left" or "right"`);
    }
    const velocity = note.velocity === undefined
      ? 0.8
      : boundedNumber(note.velocity, `notes[${index}].velocity`, 0, 1);
    const trackId = `${hand}-hand`;
    const voiceId = `${hand}-voice`;
    if (pitches.length === 1) {
      handEvents[hand].push({
        id: `note-${index}`,
        type: 'note',
        midi: pitches[0]!,
        startTick,
        durationTicks,
        velocity,
        voiceId,
        trackId,
      });
    } else {
      handEvents[hand].push({
        id: `chord-${index}`,
        type: 'chord',
        startTick,
        notes: pitches.map(midi => ({ midi, durationTicks, velocity })),
        voiceId,
        trackId,
      });
    }
  });

  parsed.pedals?.forEach((candidate, index) => {
    const pedal = inputRecord(candidate, `pedals[${index}]`);
    const startTick = beatTicks(pedal.startBeat, `pedals[${index}].startBeat`);
    const endTick = beatTicks(pedal.endBeat, `pedals[${index}].endBeat`, true);
    if (endTick <= startTick) throw new PianoToolInputError(`pedals[${index}].endBeat must be after startBeat`);
    const value = pedal.value === undefined
      ? 1
      : boundedNumber(pedal.value, `pedals[${index}].value`, 0, 1);
    const hand: PianoToolHand = handEvents.left.length > 0 ? 'left' : 'right';
    handEvents[hand].push({
      id: `pedal-${index}`,
      type: 'pedal',
      startTick,
      endTick,
      value,
      voiceId: `${hand}-voice`,
      trackId: `${hand}-hand`,
    });
  });

  const tempoMap = [{ tick: 0n, bpm: parsed.bpm }];
  parsed.tempoChanges?.forEach((candidate, index) => {
    const change = inputRecord(candidate, `tempoChanges[${index}]`);
    const tick = beatTicks(change.beat, `tempoChanges[${index}].beat`, true);
    tempoMap.push({ tick, bpm: boundedNumber(change.bpm, `tempoChanges[${index}].bpm`, 20, 400) });
  });
  tempoMap.sort((left, right) => Number(left.tick - right.tick));
  for (let index = 1; index < tempoMap.length; index += 1) {
    if (tempoMap[index]!.tick === tempoMap[index - 1]!.tick) {
      throw new PianoToolInputError(`tempoChanges contains more than one tempo at beat ${Number(tempoMap[index]!.tick) / PIANO_TOOL_PPQ}`);
    }
  }

  const tracks = (['left', 'right'] as const)
    .filter(hand => handEvents[hand].length > 0)
    .map(hand => trackFor(hand, handEvents[hand]));
  const signature = parsed.timeSignature ?? { numerator: 4, denominator: 4 };
  const score: Score = {
    id: performanceId,
    title: parsed.title,
    ppq: PIANO_TOOL_PPQ,
    tempoMap,
    timeSignatureMap: [{ tick: 0n, ...signature }],
    tracks,
    metadata: { source: 'DeepSeek Harness piano_perform tool' },
  };
  validateScore(score);
  const payload = createPianoPerformancePayload(score, { performanceId });
  const { timeline: _derivedTimeline, ...compactPayload } = payload;

  return {
    version: PIANO_TOOL_CONTRACT_VERSION,
    performanceId,
    title: parsed.title,
    noteCount,
    autoplay: parsed.autoplay ?? true,
    payload: {
      ...compactPayload,
      score: serializePianoScore(payload.score),
    },
  };
}
