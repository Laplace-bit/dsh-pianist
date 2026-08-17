/**
 * Shared hit-test geometry between the immersive scene renderer and the view's
 * pointer/keyboard auditioning. Keeping it in a leaf module lets the scene and
 * the renderer interface reference it without import cycles.
 */

export interface PianoKeyHit {
  midi: number;
  isBlack: boolean;
  /** Absolute CSS-pixel left edge of the key on its canvas. */
  x: number;
  /** CSS-pixel width of the key. */
  w: number;
  /** Optional exact vertical bounds, including visible front/side faces. */
  y?: number;
  h?: number;
  /** Projected back/front edges for perspective-accurate trapezoid hits. */
  backX?: number;
  backW?: number;
  frontX?: number;
  frontW?: number;
  frontY?: number;
}

export interface PianoKeyHitGeometry {
  keys: readonly PianoKeyHit[];
  /** CSS-pixel top of the keyboard. */
  keyTop: number;
  whiteH: number;
  blackH: number;
}

/**
 * Resolve a canvas-space point to the topmost physical key of a scene layout.
 * Black keys sit above white keys, exactly as they are drawn.
 */
export function sceneKeyAtPoint(x: number, y: number, geometry: PianoKeyHitGeometry): PianoKeyHit | undefined {
  if (![x, y].every(Number.isFinite)) return undefined;
  const { keys, keyTop, whiteH, blackH } = geometry;
  if (y < keyTop || y >= keyTop + whiteH) return undefined;
  const contains = (key: PianoKeyHit, fallbackH: number): boolean => {
    const top = key.y ?? keyTop;
    const height = key.h ?? fallbackH;
    if (y < top || y >= top + height) return false;
    if (key.backX === undefined
      || key.backW === undefined
      || key.frontX === undefined
      || key.frontW === undefined
      || key.frontY === undefined) {
      return x >= key.x && x <= key.x + key.w;
    }
    const depth = Math.min(1, Math.max(0, (y - top) / Math.max(1, key.frontY - top)));
    const left = key.backX + (key.frontX - key.backX) * depth;
    const rightBack = key.backX + key.backW;
    const rightFront = key.frontX + key.frontW;
    const right = rightBack + (rightFront - rightBack) * depth;
    return x >= left && x <= right;
  };
  for (const key of keys) {
    if (key.isBlack && contains(key, blackH)) return key;
  }
  for (const key of keys) {
    if (!key.isBlack && contains(key, whiteH)) return key;
  }
  return undefined;
}
