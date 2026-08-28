import { describe, expect, it } from 'vitest';
import { computeLayout, keyCenterX, type PianoLayout } from '../src/visual/immersive-scene.js';
import {
  KEYBOARD_LAYOUT,
  MAX_PIANO_MIDI,
  MIN_PIANO_MIDI,
  isBlackKey,
} from '../src/visual/keyboard.js';

function keyboardSpan(L: PianoLayout): { left: number; right: number } {
  return { left: L.keyLeft, right: L.keyLeft + L.whiteW * 52 };
}

describe('note effect coordinates', () => {
  const cases: Array<[number, number, boolean]> = [
    [1920, 1080, false],
    [2560, 1440, false],
    [900, 620, false],
    [520, 300, true],
    [380, 260, true],
  ];

  for (const [width, height, compact] of cases) {
    it(`lands every note inside the drawn keyboard at ${width}x${height} (compact=${compact})`, () => {
      const L = computeLayout(width, height, compact);
      const span = keyboardSpan(L);
      for (let midi = MIN_PIANO_MIDI; midi <= MAX_PIANO_MIDI; midi += 1) {
        const x = keyCenterX(L, midi);
        expect(x).toBeGreaterThanOrEqual(span.left - 0.001);
        expect(x).toBeLessThanOrEqual(span.right + 0.001);
      }
    });
  }

  it('keeps pitch order strictly monotonic across the keyboard on a wide fullscreen', () => {
    // Regression: effects used full-canvas normalization, so low notes
    // clustered at the far left edge while the instrument sat centered.
    // The corrected layout leaves every key center strictly right of its
    // lower neighbor — even with the real-piano ebony lean, whose ±0.13-key
    // offset never closes the gap to the adjacent white center.
    const L = computeLayout(2560, 1440, false);
    let previous = Number.NEGATIVE_INFINITY;
    for (let midi = MIN_PIANO_MIDI; midi <= MAX_PIANO_MIDI; midi += 1) {
      const x = keyCenterX(L, midi);
      expect(x).toBeGreaterThan(previous);
      previous = x;
    }
    expect(keyCenterX(L, MIN_PIANO_MIDI)).toBeGreaterThan(L.keyLeft);
    expect(keyCenterX(L, MAX_PIANO_MIDI)).toBeLessThan(keyboardSpan(L).right);
  });

  it('places black keys at their real-piano offset from the neighbouring-white boundary', () => {
    // Regression: black keys were anchored a half white-key too far right —
    // the formula stacked a white-center half unit on top of an offset that
    // is already measured from the boundary, pushing every ebony key onto
    // its right-hand white. The lean table below mirrors pitchNudge and is
    // asserted exactly against the midpoint between the neighbour centers.
    const NUDGES: Record<number, number> = { 1: -0.1, 3: 0.1, 6: -0.13, 8: 0, 10: 0.13 };
    const L = computeLayout(1280, 720, false);
    for (let midi = MIN_PIANO_MIDI + 1; midi < MAX_PIANO_MIDI; midi += 1) {
      if (!isBlackKey(midi)) continue;
      const beforeWhite = keyCenterX(L, midi - 1);
      const afterWhite = keyCenterX(L, midi + 1);
      const gapMid = (beforeWhite + afterWhite) / 2;
      // Neighbor centers are one projected white-key width apart.
      const whiteWProjected = afterWhite - beforeWhite;
      expect(whiteWProjected).toBeGreaterThan(0);
      const nudge = NUDGES[((midi % 12) + 12) % 12]!;
      expect(keyCenterX(L, midi) - gapMid).toBeCloseTo(nudge * whiteWProjected, 6);
    }
  });

  it('keeps the keyboard perspective symmetric: zero skew, converging insets', () => {
    // Regression: the key plane used to skew sideways with depth, which
    // leaned the keys away from the case. The elevated frontal view needs
    // one-point perspective — insets converge symmetrically, never laterally.
    for (const [width, height, compact] of [[1920, 1080, false], [900, 620, false], [520, 300, true], [380, 260, true]] as const) {
      const L = computeLayout(width, height, compact);
      expect(L.keyboardSkewX).toBe(0);
      expect(L.keyboardBackInset).toBeGreaterThan(L.keyboardFrontInset);
      expect(L.keyboardFrontDrop).toBeLessThan(L.whiteH * 0.2);
      // Mid-plane key centers stay strictly ordered; the deliberate ±0.13-key
      // ebony lean of the black rows never breaks the pitch ordering.
      let previous = Number.NEGATIVE_INFINITY;
      for (let midi = MIN_PIANO_MIDI; midi <= MAX_PIANO_MIDI; midi += 1) {
        const x = keyCenterX(L, midi);
        expect(x).toBeGreaterThan(previous);
        previous = x;
      }
    }
  });

  it('supports a straight-on keyboard for the pearl-white reference skin', () => {
    const L = computeLayout(1920, 1080, false, undefined, { tallLid: true, flatKeyboard: true });
    expect(L.keyboardSkewX).toBe(0);
    expect(L.keyboardBackInset).toBe(L.keyboardFrontInset);
    expect(keyCenterX(L, 21)).toBeGreaterThan(L.keyLeft);
    expect(keyCenterX(L, 108)).toBeLessThan(L.keyLeft + L.whiteW * 52);
  });

  it('grounds the key plane directly on the front rail', () => {
    for (const compact of [false, true]) {
      const L = computeLayout(900, compact ? 520 : 620, compact);
      expect(L.frontRailY).toBe(L.keyboardFrontY);
      expect(L.frontRailY - L.keyboardBackY).toBeCloseTo(L.whiteH + L.keyboardFrontDrop, 8);
    }
  });

  it('gives the black concert skin an elevated player-height view', () => {
    const reference = computeLayout(1920, 1080, false, undefined, { tallLid: true, referenceView: true });
    const standard = computeLayout(1920, 1080, false, undefined, { tallLid: true });
    expect(reference.backH).toBeGreaterThan(standard.backH * 2.5);
    expect(reference.keyboardFrontY - reference.keyboardBackY).toBeGreaterThan(reference.whiteH);
    expect(reference.keyboardFrontDrop).toBeGreaterThan(reference.whiteH * 0.2);
    expect(reference.keyboardBackInset).toBeGreaterThan(reference.keyboardFrontInset);
    expect(reference.frontRailY).toBe(reference.keyboardFrontY);
  });
});
