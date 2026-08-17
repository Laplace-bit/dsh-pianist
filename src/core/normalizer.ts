import type {
  MusicEvent,
  Score,
  TempoEvent,
  Tick,
  TimeSignatureEvent,
} from './types.js';
import { ScoreParseError } from './errors.js';

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScoreParseError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ScoreParseError(`${path} must be an array`);
  }
  return value;
}

function toBigInt(value: unknown, path: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new ScoreParseError(`${path} must be an integer tick (number or string)`);
}

function toNumber(value: unknown, path: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(number) === false) {
    throw new ScoreParseError(`${path} must be a finite number`);
  }
  return number;
}

function normalizeTickFields(input: unknown, path: string): Record<string, unknown> {
  const event = record(input, path);
  const result: Record<string, unknown> = { ...event };

  // Required scalar fields per event type. A missing required scalar is a
  // parse error, never a silent default (e.g. never defaulting a note to C4).
  const type = result.type;
  const requireField = (field: string): void => {
    if (field in result) {
      return;
    }
    throw new ScoreParseError(`${path}.${field} is required`);
  };
  if (type === 'note' || type === 'rest') {
    requireField('startTick');
    requireField('durationTicks');
  } else if (type === 'chord') {
    requireField('startTick');
  } else if (type === 'pedal') {
    requireField('startTick');
    requireField('endTick');
  } else if (type === 'tuplet') {
    requireField('actual');
    requireField('normal');
    requireField('startTick');
    requireField('durationTicks');
  }

  if ('startTick' in result) {
    result.startTick = toBigInt(result.startTick, `${path}.startTick`);
  }
  if ('durationTicks' in result) {
    result.durationTicks = toBigInt(result.durationTicks, `${path}.durationTicks`);
  }
  if ('endTick' in result) {
    result.endTick = toBigInt(result.endTick, `${path}.endTick`);
  }
  if ('tick' in result) {
    result.tick = toBigInt(result.tick, `${path}.tick`);
  }
  if ('notes' in result) {
    result.notes = array(result.notes, `${path}.notes`).map((note, index) => {
      const obj = record(note, `${path}.notes[${index}]`);
      const normalized: Record<string, unknown> = { ...obj };
      if ('durationTicks' in obj === false) {
        throw new ScoreParseError(`${path}.notes[${index}].durationTicks is required`);
      }
      normalized.durationTicks = toBigInt(obj.durationTicks, `${path}.notes[${index}].durationTicks`);
      return normalized;
    });
  }
  if ('events' in result) {
    result.events = array(result.events, `${path}.events`).map((child, index) =>
      normalizeTickFields(child, `${path}.events[${index}]`),
    );
  }
  return result;
}

export function normalizeScore(input: unknown): Score {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ScoreParseError('Score must be an object');
  }
  const raw = record(input, 'Score');
  const tempoMap = array(raw.tempoMap, 'tempoMap');
  const timeSignatureMap = raw.timeSignatureMap === undefined
    ? []
    : array(raw.timeSignatureMap, 'timeSignatureMap');
  const tracks = array(raw.tracks, 'tracks');
  const score: Record<string, unknown> = {
    ...raw,
    ppq: toNumber(raw.ppq, 'ppq'),
    tempoMap: tempoMap.map((event, index) => {
      const obj = record(event, `tempoMap[${index}]`);
      return {
        ...obj,
        tick: toBigInt(obj.tick, `tempoMap[${index}].tick`),
        bpm: toNumber(obj.bpm, `tempoMap[${index}].bpm`),
      } as TempoEvent;
    }),
    timeSignatureMap: timeSignatureMap.map((event, index) => {
      const obj = record(event, `timeSignatureMap[${index}]`);
      return {
        ...obj,
        tick: toBigInt(obj.tick, `timeSignatureMap[${index}].tick`),
        numerator: toNumber(obj.numerator, `timeSignatureMap[${index}].numerator`),
        denominator: toNumber(obj.denominator, `timeSignatureMap[${index}].denominator`),
      } as TimeSignatureEvent;
    }),
    tracks: tracks.map((track, trackIndex) => {
      const trackObj = record(track, `tracks[${trackIndex}]`);
      const voices = array(trackObj.voices, `tracks[${trackIndex}].voices`);
      return {
        ...trackObj,
        voices: voices.map((voice, voiceIndex) => {
          const voiceObj = record(voice, `tracks[${trackIndex}].voices[${voiceIndex}]`);
          const events = array(voiceObj.events, `tracks[${trackIndex}].voices[${voiceIndex}].events`);
          return {
            ...voiceObj,
            events: events.map((event, eventIndex) =>
              normalizeTickFields(event, `tracks[${trackIndex}].voices[${voiceIndex}].events[${eventIndex}]`),
            ),
          };
        }),
      };
    }),
  };
  return score as unknown as Score;
}

export function parseScoreJson(json: string): Score {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ScoreParseError(`Invalid JSON: ${(error as Error).message}`);
  }
  return normalizeScore(parsed);
}
