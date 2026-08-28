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

/**
 * Real-piano ebony placement, in white-key widths from the white-key boundary
 * each black key lives on: C#/F# lean toward their flat side, D#/A# toward
 * their sharp side, G# stays centered. Single source shared by every
 * pitch→x mapping.
 */
const BLACK_KEY_LEAN: Readonly<Record<number, number>> = { 1: -0.1, 3: 0.1, 6: -0.13, 8: 0, 10: 0.13 };

export function blackKeyLean(pitchClass: number): number {
  return BLACK_KEY_LEAN[pitchClass] ?? 0;
}

/** White-key-width offset of each key's center from the keyboard's left edge. */
const KEY_CENTER_OFFSET_UNITS = new Map<number, number>();
{
  let whites = 0;
  for (const key of KEYBOARD_LAYOUT) {
    const lean = key.isBlack ? blackKeyLean(((key.midi % 12) + 12) % 12) : 0;
    KEY_CENTER_OFFSET_UNITS.set(key.midi, whites + (key.isBlack ? lean : 0.5));
    if (!key.isBlack) whites += 1;
  }
}

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
 * Returns the normalized x of a note's center on a standard 88-key piano, in
 * units of one white-key width: whites sit mid-key, blacks sit on the
 * boundary between their neighbouring whites with the shared real-piano lean
 * of blackKeyLean(). The immersive scene's keyCenterX uses the identical
 * convention, scaled to its layout.
 */
export function noteXPosition(midi: number): number {
  if (midi < MIN_PIANO_MIDI || midi > MAX_PIANO_MIDI) {
    throw new RangeError(`midi ${midi} is outside piano range`);
  }
  return KEY_CENTER_OFFSET_UNITS.get(midi)! / WHITE_KEYS.length;
}
