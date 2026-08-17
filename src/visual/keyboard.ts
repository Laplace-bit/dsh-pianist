export const MIN_PIANO_MIDI = 21;
export const MAX_PIANO_MIDI = 108;
export const PIANO_KEY_COUNT = 88;
export const PIANO_KEYBOARD_HEIGHT = 60;
/** Larger keyboard used by the full-viewport immersive presentation. */
export const PIANO_IMMERSIVE_KEYBOARD_HEIGHT = 150;
export const PIANO_BLACK_KEY_HEIGHT_RATIO = 0.62;
export const PIANO_BLACK_KEY_WIDTH_RATIO = 0.52;

export interface PianoKey {
  midi: number;
  index: number;
  name: string;
  octave: number;
  isBlack: boolean;
  /** 0..1 position on a standard 88-key keyboard. */
  normalizedPosition: number;
}

const BLACK_MIDI_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function isBlackKey(midi: number): boolean {
  return BLACK_MIDI_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

export function keyName(midi: number): string {
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NAMES[pitchClass]}${octave}`;
}

export function createKeyboardLayout(): PianoKey[] {
  const keys: PianoKey[] = [];
  for (let midi = MIN_PIANO_MIDI; midi <= MAX_PIANO_MIDI; midi += 1) {
    const whiteIndexBefore = keys.filter((key) => key.isBlack === false).length;
    keys.push({
      midi,
      index: midi - MIN_PIANO_MIDI,
      name: keyName(midi),
      octave: Math.floor(midi / 12) - 1,
      isBlack: isBlackKey(midi),
      normalizedPosition: whiteIndexBefore / 52,
    });
  }
  return keys;
}

export const KEYBOARD_LAYOUT = createKeyboardLayout();
const WHITE_KEYS = KEYBOARD_LAYOUT.filter((key) => !key.isBlack);
const BLACK_KEYS = KEYBOARD_LAYOUT.filter((key) => key.isBlack);

/** Resolve one canvas-space point to the topmost physical piano key. */
export function pianoKeyAtPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  keyboardHeight = PIANO_KEYBOARD_HEIGHT,
): PianoKey | undefined {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || keyboardHeight <= 0) {
    return undefined;
  }
  if (x < 0 || x >= width || y < height - keyboardHeight || y >= height) {
    return undefined;
  }

  const keyboardTop = height - keyboardHeight;
  const whiteWidth = width / WHITE_KEYS.length;
  if (y < keyboardTop + keyboardHeight * PIANO_BLACK_KEY_HEIGHT_RATIO) {
    const blackWidth = whiteWidth * PIANO_BLACK_KEY_WIDTH_RATIO;
    for (const key of BLACK_KEYS) {
      const left = key.normalizedPosition * width - blackWidth / 2;
      if (x >= left && x < left + blackWidth) return key;
    }
  }

  return WHITE_KEYS[Math.min(WHITE_KEYS.length - 1, Math.floor(x / whiteWidth))];
}

/**
 * Returns the normalized x position of a note on a standard 88-key piano.
 * Black keys are positioned between their neighbouring white keys.
 */
export function noteXPosition(midi: number): number {
  if (midi < MIN_PIANO_MIDI || midi > MAX_PIANO_MIDI) {
    throw new RangeError(`midi ${midi} is outside piano range`);
  }
  const isBlack = isBlackKey(midi);
  const previousWhiteCount = KEYBOARD_LAYOUT.filter(
    (key) => key.midi < midi && key.isBlack === false,
  ).length;
  if (isBlack) {
    const whiteBefore = previousWhiteCount;
    const whiteAfter = KEYBOARD_LAYOUT.filter(
      (key) => key.midi > midi && key.isBlack === false,
    ).length;
    const position = whiteBefore - 0.5;
    return position / (whiteBefore + whiteAfter);
  }
  return previousWhiteCount / 52;
}
