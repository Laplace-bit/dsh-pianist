import type {
  CompactPianoToolNoteInput,
  PianoToolInput,
  PianoToolNoteInput,
  PianoToolPedalInput,
  PianoToolTempoInput,
} from '../shared/piano-tool.js';

export interface PianoToolStreamOptions {
  /** Milliseconds since DSH first exposed this running tool call. */
  elapsedMs?: number;
}

export interface PianoToolStreamPreview {
  complete: boolean;
  title?: string;
  bpm?: number;
  input?: PianoToolInput;
  noteGroupCount: number;
  soundedNoteCount: number;
  bufferedUntilBeat: number;
  chronological: boolean;
  readyToPlay: boolean;
}

interface ScannedArguments {
  complete: boolean;
  values: Record<string, unknown>;
  notes: unknown[];
  notesSeen: boolean;
}

function skipWhitespace(source: string, index: number): number {
  while (index < source.length && /\s/.test(source[index]!)) index += 1;
  return index;
}

function stringEnd(source: string, start: number): number | undefined {
  if (source[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return undefined;
}

function compositeEnd(source: string, start: number): number | undefined {
  const opener = source[start];
  if (opener !== '{' && opener !== '[') return undefined;
  const stack = [opener];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.at(-1) !== expected) return undefined;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

function valueEnd(source: string, start: number): number | undefined {
  const character = source[start];
  if (character === '"') return stringEnd(source, start);
  if (character === '{' || character === '[') return compositeEnd(source, start);
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === ',' || source[index] === '}' || source[index] === ']') {
      const end = skipWhitespaceBack(source, index);
      return end > start ? end : undefined;
    }
  }
  return undefined;
}

function skipWhitespaceBack(source: string, index: number): number {
  while (index > 0 && /\s/.test(source[index - 1]!)) index -= 1;
  return index;
}

function parseSlice(source: string, start: number, end: number): unknown {
  try {
    return JSON.parse(source.slice(start, end)) as unknown;
  } catch {
    return undefined;
  }
}

function scanArrayItems(source: string, arrayStart: number): unknown[] {
  const items: unknown[] = [];
  let index = arrayStart + 1;
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === ']') return items;
    const end = valueEnd(source, index);
    if (end === undefined) return items;
    const parsed = parseSlice(source, index, end);
    if (parsed === undefined) return items;
    index = skipWhitespace(source, end);
    items.push(parsed);
    if (index >= source.length) return items;
    const delimiter = source[index];
    if (delimiter !== ',' && delimiter !== ']') return items;
    if (delimiter === ']') return items;
    index += 1;
  }
  return items;
}

function scanArguments(source: string): ScannedArguments {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const values = parsed as Record<string, unknown>;
      return {
        complete: true,
        values,
        notes: Array.isArray(values.notes) ? values.notes : [],
        notesSeen: Object.hasOwn(values, 'notes'),
      };
    }
  } catch {
    // Running tool arguments are expected to be incomplete JSON.
  }

  const values: Record<string, unknown> = {};
  const notes: unknown[] = [];
  let notesSeen = false;
  let index = skipWhitespace(source, 0);
  if (source[index] !== '{') return { complete: false, values, notes, notesSeen };
  index += 1;
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === '}') return { complete: true, values, notes, notesSeen };
    const keyEnd = stringEnd(source, index);
    if (keyEnd === undefined) break;
    const key = parseSlice(source, index, keyEnd);
    if (typeof key !== 'string') break;
    index = skipWhitespace(source, keyEnd);
    if (source[index] !== ':') break;
    index = skipWhitespace(source, index + 1);
    if (key === 'notes' && source[index] === '[') {
      notesSeen = true;
      notes.push(...scanArrayItems(source, index));
    }
    const end = valueEnd(source, index);
    if (end === undefined) break;
    const parsed = parseSlice(source, index, end);
    if (parsed === undefined) break;
    values[key] = parsed;
    if (key === 'notes' && Array.isArray(parsed)) {
      notes.length = 0;
      notes.push(...parsed);
    }
    index = skipWhitespace(source, end);
    if (source[index] === '}') return { complete: true, values, notes, notesSeen };
    if (source[index] !== ',') break;
    index += 1;
  }
  return { complete: false, values, notes, notesSeen };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function beat(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  const number = fraction === null ? Number(value) : Number(fraction[1]) / Number(fraction[2]);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function chronologicalNotes(notes: readonly unknown[]): { chronological: boolean; bufferedUntilBeat: number } {
  let previous = -1;
  for (const candidate of notes) {
    const note = record(candidate);
    const start = beat(note?.startBeat ?? note?.s);
    if (start === undefined || start < previous) return { chronological: false, bufferedUntilBeat: 0 };
    previous = start;
  }
  return { chronological: true, bufferedUntilBeat: Math.max(0, previous) };
}

function adaptiveBufferBeats(bpm: number, bufferedUntilBeat: number, elapsedMs: number): number {
  const elapsedSeconds = Math.max(0.25, elapsedMs / 1_000);
  const generationBeatsPerSecond = bufferedUntilBeat / elapsedSeconds;
  const playbackBeatsPerSecond = bpm / 60;
  // A short musical cushion gets sound on screen quickly while still leaving
  // enough room for one delayed argument delta. Increase it only when the
  // model is demonstrably slower than the player.
  if (generationBeatsPerSecond >= playbackBeatsPerSecond * 2) return 2;
  if (generationBeatsPerSecond >= playbackBeatsPerSecond * 1.25) return 3;
  return 4;
}

/**
 * Parse the structurally complete prefix of DSH's streaming tool arguments.
 * The parser never repairs JSON: incomplete strings/objects are ignored until
 * the next delta closes them.
 */
export function parsePianoToolStream(
  argsRaw: string,
  options: PianoToolStreamOptions = {},
): PianoToolStreamPreview {
  const scanned = scanArguments(argsRaw);
  const title = typeof scanned.values.title === 'string' ? scanned.values.title : undefined;
  const bpm = typeof scanned.values.bpm === 'number' && Number.isFinite(scanned.values.bpm)
    ? scanned.values.bpm
    : undefined;
  const noteRecords = scanned.notes.filter(candidate => record(candidate) !== undefined) as Array<
    PianoToolNoteInput | CompactPianoToolNoteInput
  >;
  const soundedNoteCount = noteRecords.reduce((count, candidate) => (
    count + ('pitches' in candidate
      ? (Array.isArray(candidate.pitches) ? candidate.pitches.length : 0)
      : Array.isArray(candidate.p) ? candidate.p.length : 1)
  ), 0);
  const order = chronologicalNotes(noteRecords);
  let input: PianoToolInput | undefined;
  if (title !== undefined && title.trim() !== '' && bpm !== undefined && noteRecords.length > 0) {
    input = {
      title,
      bpm,
      notes: noteRecords,
      ...record(scanned.values.timeSignature) === undefined
        ? {} : { timeSignature: scanned.values.timeSignature as PianoToolInput['timeSignature'] },
      ...Array.isArray(scanned.values.pedals)
        ? { pedals: scanned.values.pedals as PianoToolPedalInput[] } : {},
      ...Array.isArray(scanned.values.tempoChanges)
        ? { tempoChanges: scanned.values.tempoChanges as PianoToolTempoInput[] } : {},
      ...typeof scanned.values.autoplay === 'boolean'
        ? { autoplay: scanned.values.autoplay } : {},
    };
  }
  const requiredBuffer = bpm === undefined
    ? Number.POSITIVE_INFINITY
    : adaptiveBufferBeats(bpm, order.bufferedUntilBeat, options.elapsedMs ?? 0);
  return {
    complete: scanned.complete,
    title,
    bpm,
    input,
    noteGroupCount: noteRecords.length,
    soundedNoteCount,
    bufferedUntilBeat: order.bufferedUntilBeat,
    chronological: order.chronological,
    readyToPlay: input !== undefined
      && scanned.notesSeen
      && order.chronological
      && order.bufferedUntilBeat >= requiredBuffer,
  };
}
