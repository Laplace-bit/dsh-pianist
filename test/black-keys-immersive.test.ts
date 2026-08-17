// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline } from '../src/core/timeline.js';
import type { Score } from '../src/core/types.js';
import { computeVisualState } from '../src/visual/visual-state.js';
import { VisualTimeline } from '../src/visual/visual-timeline.js';
import { createImmersivePianoScene } from '../src/visual/immersive-scene.js';

function score(): Score {
  return {
    id: 'scene',
    title: 'Immersive',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 96 }],
    timeSignatureMap: [],
    tracks: [{
      id: 'piano',
      instrument: { id: 'grand' },
      voices: [{
        id: 'right',
        events: [0, 1, 2, 3].map(beat => ({
          id: `n${beat}`,
          type: 'note' as const,
          midi: 60 + beat * 3,
          startTick: BigInt(beat * 960),
          durationTicks: 840n,
          velocity: 0.6 + beat * 0.08,
          voiceId: 'right',
          trackId: 'piano',
        })),
      }],
    }],
  };
}

interface DrawCall {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Context proxy recording every drawImage destination rect. */
function recordingContext(draws: DrawCall[]): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = { canvas: { width: 0, height: 0 } };
  return new Proxy(target, {
    get(_t, property) {
      if (property === 'canvas') return target.canvas;
      if (property === 'drawImage') {
        return (_image: unknown, ...args: number[]) => {
          // Supports the 5-arg and 9-arg forms; take the destination quad.
          const k = args.length >= 4 ? args.length - 4 : 0;
          draws.push({ dx: args[k]!, dy: args[k + 1]!, dw: args[k + 2]!, dh: args[k + 3]! });
        };
      }
      if (property === 'createLinearGradient' || property === 'createRadialGradient') return () => gradient;
      if (property === 'createPattern') return () => ({});
      if (property === 'measureText') return () => ({ width: 0 });
      return () => {};
    },
    set(t, property, value) {
      Reflect.set(t, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('immersive black keys', () => {
  it('paints every black key on the first staged frame at fullscreen scale', () => {
    const draws: DrawCall[] = [];
    const ctx = recordingContext(draws);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

    const timeline = buildTimeline(score());
    const visual = new VisualTimeline(timeline);
    const state = computeVisualState(timeline, 1.2);

    const scene = createImmersivePianoScene(document.createElement('canvas'));
    expect(scene.backend).toBe('canvas2d');
    scene.resize(1920, 1080, 1.5);
    scene.render({
      musicalTime: 1.2,
      state,
      timeline: visual,
      showWaterfall: true,
      showKeyboard: true,
      particles: true,
      quality: 'medium',
      immersive: true,
      atmosphere: { loudness: 0.2, low: 0.1, mid: 0.1, high: 0.05, energy: 0.15, noteActivity: 0.2, usingAnalyser: true },
      nowSeconds: 1.2,
      reducedMotion: false,
      keyboardHeight: 150,
    });

    // Staged layout at 1920px: black keys are ~11x58 CSS px; whites ~20x88.
    const blackDraws = draws.filter(draw =>
      Number.isFinite(draw.dx) && Number.isFinite(draw.dy)
      && Number.isFinite(draw.dw) && Number.isFinite(draw.dh)
      && draw.dw > 6 && draw.dw < 16
      && draw.dh > 40 && draw.dh < 75);
    expect(blackDraws.length).toBeGreaterThanOrEqual(36);
  });

  it('still paints black keys after switching embedded -> immersive on one renderer', () => {
    const draws: DrawCall[] = [];
    const ctx = recordingContext(draws);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

    const timeline = buildTimeline(score());
    const visual = new VisualTimeline(timeline);

    const scene = createImmersivePianoScene(document.createElement('canvas'));
    scene.resize(520, 300, 1.5);
    scene.render({
      musicalTime: 0.5,
      state: computeVisualState(timeline, 0.5),
      timeline: visual,
      showWaterfall: true,
      showKeyboard: true,
      particles: false,
      quality: 'medium',
      immersive: false,
      atmosphere: null,
      nowSeconds: 0.5,
      reducedMotion: false,
      keyboardHeight: 60,
    });

    scene.render({
      musicalTime: 1.2,
      state: computeVisualState(timeline, 1.2),
      timeline: visual,
      showWaterfall: true,
      showKeyboard: true,
      particles: true,
      quality: 'medium',
      immersive: true,
      atmosphere: null,
      nowSeconds: 1.2,
      reducedMotion: false,
      keyboardHeight: 150,
    });

    const blackDraws = draws.filter(draw =>
      Number.isFinite(draw.dx) && Number.isFinite(draw.dy)
      && Number.isFinite(draw.dw) && Number.isFinite(draw.dh)
      && draw.dw > 6 && draw.dw < 16
      && draw.dh > 40 && draw.dh < 75);
    expect(blackDraws.length).toBeGreaterThanOrEqual(36);
  });
});
