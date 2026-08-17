import { describe, expect, it } from 'vitest';
import { sceneKeyAtPoint, type PianoKeyHitGeometry } from '../src/visual/key-geometry.js';

const geometry: PianoKeyHitGeometry = {
  keyTop: 100,
  whiteH: 84,
  blackH: 48,
  keys: [
    { midi: 60, isBlack: false, x: 20, w: 24, y: 100, h: 84 },
    { midi: 62, isBlack: false, x: 44, w: 24, y: 100, h: 84 },
    { midi: 61, isBlack: true, x: 38, w: 12, y: 106, h: 56 },
  ],
};

describe('scene key hit geometry', () => {
  it('keeps white-key front thickness clickable across adjacent keys', () => {
    expect(sceneKeyAtPoint(32, 180, geometry)?.midi).toBe(60);
    expect(sceneKeyAtPoint(56, 180, geometry)?.midi).toBe(62);
  });

  it('keeps raised black-key side and front faces clickable above whites', () => {
    expect(sceneKeyAtPoint(44, 160, geometry)?.midi).toBe(61);
    expect(sceneKeyAtPoint(44, 166, geometry)?.midi).toBe(60);
  });

  it('follows a key trapezoid instead of its overlapping outer bounds', () => {
    const perspective: PianoKeyHitGeometry = {
      keyTop: 100,
      whiteH: 90,
      blackH: 0,
      keys: [
        {
          midi: 60, isBlack: false, x: 20, w: 30, y: 100, h: 90,
          backX: 25, backW: 20, frontX: 20, frontW: 24, frontY: 180,
        },
        {
          midi: 62, isBlack: false, x: 44, w: 31, y: 100, h: 90,
          backX: 45, backW: 20, frontX: 44, frontW: 24, frontY: 180,
        },
      ],
    };
    expect(sceneKeyAtPoint(23, 105, perspective)).toBeUndefined();
    expect(sceneKeyAtPoint(23, 180, perspective)?.midi).toBe(60);
    expect(sceneKeyAtPoint(46, 105, perspective)?.midi).toBe(62);
  });
});
