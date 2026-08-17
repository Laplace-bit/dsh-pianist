// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline } from '../src/core/timeline.js';
import type { Score } from '../src/core/types.js';
import type { PianoRenderOptions } from '../src/visual/piano-renderer.js';
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

function proxyContext(texts: string[] = []): CanvasRenderingContext2D {
  const gradient = {
    addColorStop: () => {},
    addColorStopAt: () => {},
  };
  const target = {
    canvas: { width: 0, height: 0 },
  };
  return new Proxy(target, {
    get(_target, property) {
      if (property === 'canvas') return target.canvas;
      if (property === 'createLinearGradient' || property === 'createRadialGradient') return () => gradient;
      if (property === 'measureText') return () => ({ width: 0 });
      if (property === 'createPattern') return () => ({} as unknown as CanvasPattern);
      if (property === 'fillText') return (text: string) => texts.push(text);
      return () => {};
    },
    set(target, property, value) {
      Reflect.set(target, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function stateTrackingContext(): {
  context: CanvasRenderingContext2D;
  resetDrawTracking: () => void;
  firstBackdropFill: { alpha: number; composite: string } | undefined;
  screenFillCount: number;
  screenDrawImageCount: number;
} {
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {
    canvas: { width: 0, height: 0 },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };
  const stateStack: Array<{ alpha: number; composite: string }> = [];
  let firstBackdropFill: { alpha: number; composite: string } | undefined;
  let screenFillCount = 0;
  let screenDrawImageCount = 0;
  const context = new Proxy(target, {
    get(_target, property) {
      if (property === 'canvas') return target.canvas;
      if (property === 'createLinearGradient' || property === 'createRadialGradient') return () => gradient;
      if (property === 'createPattern') return () => ({} as unknown as CanvasPattern);
      if (property === 'measureText') return () => ({ width: 0 });
      if (property === 'save') {
        return () => stateStack.push({
          alpha: Number(target.globalAlpha),
          composite: String(target.globalCompositeOperation),
        });
      }
      if (property === 'restore') {
        return () => {
          const state = stateStack.pop();
          if (state === undefined) return;
          target.globalAlpha = state.alpha;
          target.globalCompositeOperation = state.composite;
        };
      }
      if (property === 'fillRect') {
        return () => {
          if (target.globalCompositeOperation === 'screen') screenFillCount += 1;
          if (firstBackdropFill === undefined) {
            firstBackdropFill = {
              alpha: Number(target.globalAlpha),
              composite: String(target.globalCompositeOperation),
            };
          }
        };
      }
      if (property === 'drawImage') {
        return () => {
          if (target.globalCompositeOperation === 'screen') screenDrawImageCount += 1;
        };
      }
      return () => {};
    },
    set(_target, property, value) {
      Reflect.set(target, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    context,
    resetDrawTracking: () => {
      firstBackdropFill = undefined;
      screenFillCount = 0;
      screenDrawImageCount = 0;
    },
    get firstBackdropFill() { return firstBackdropFill; },
    get screenFillCount() { return screenFillCount; },
    get screenDrawImageCount() { return screenDrawImageCount; },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ImmersivePianoScene', () => {
  it('renders the glass scene deterministically across the timeline without throwing', () => {
    const texts: string[] = [];
    const fake = proxyContext(texts);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fake);
    const canvas = document.createElement('canvas');
    const scene = createImmersivePianoScene(canvas);
    const timeline = buildTimeline(score());
    const visual = new VisualTimeline(timeline);

    expect(scene.backend).toBe('canvas2d');
    scene.resize(900, 620, 2);
    for (const musicalTime of [0, 0.5, 1.2, 2.6, 4.1]) {
      expect(() => scene.render({
        musicalTime,
        state: computeVisualState(timeline, musicalTime),
        timeline: visual,
        showWaterfall: true,
        showKeyboard: true,
        particles: true,
        quality: musicalTime > 2 ? 'high' : 'medium',
        immersive: true,
        atmosphere: { loudness: 0.2, low: 0.1, mid: 0.1, high: 0.05, energy: 0.15, noteActivity: 0.2, usingAnalyser: true },
        nowSeconds: musicalTime,
        reducedMotion: false,
        keyboardHeight: 150,
      })).not.toThrow();
    }
    expect(texts).toContain('DSH · PIANIST');
  });

  it('honors reduced-motion and low quality, and re-layouts on resize', () => {
    const fake = proxyContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fake);
    const canvas = document.createElement('canvas');
    const scene = createImmersivePianoScene(canvas);
    const timeline = buildTimeline(score());
    const visual = new VisualTimeline(timeline);

    scene.resize(420, 760, 1);
    expect(() => scene.render({
      musicalTime: 0.3,
      state: computeVisualState(timeline, 0.3),
      timeline: visual,
      showWaterfall: false,
      showKeyboard: true,
      particles: false,
      quality: 'low',
      immersive: true,
      atmosphere: { loudness: 0, low: 0, mid: 0, high: 0, energy: 0, noteActivity: 0, usingAnalyser: false },
      nowSeconds: 0.3,
      reducedMotion: true,
      keyboardHeight: 150,
    })).not.toThrow();
    scene.resize(1024, 700, 2);
    expect(() => scene.render({
      musicalTime: 1,
      state: computeVisualState(timeline, 1),
      timeline: visual,
      showWaterfall: true,
      showKeyboard: true,
      particles: true,
      quality: 'medium',
      immersive: true,
      atmosphere: null,
      nowSeconds: 1,
      reducedMotion: true,
      keyboardHeight: 150,
    })).not.toThrow();
  });

  it('releases a key immediately while its sound is sustained by the pedal', () => {
    const fake = proxyContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fake);
    const scene = createImmersivePianoScene(document.createElement('canvas'));
    const timeline = buildTimeline(score());
    const visual = new VisualTimeline(timeline);
    const pressed = (scene as unknown as { pressed: Map<number, number> }).pressed;
    const activeNote = {
      noteId: 'sustained-c4',
      midi: 60,
      velocity: 0.8,
      startTime: 0,
      endTime: 0.1,
      x: 0.5,
    };
    const options: PianoRenderOptions = {
      musicalTime: 0,
      state: { musicalTime: 0, activeNotes: [activeNote], pressedMidi: new Set([60]), pedal: 1 },
      timeline: visual,
      showWaterfall: false,
      showKeyboard: true,
      particles: false,
      quality: 'medium',
      immersive: true,
      atmosphere: null,
      nowSeconds: 1,
      reducedMotion: false,
      keyboardHeight: 150,
    };

    scene.resize(900, 620, 1);
    scene.render(options);
    expect(pressed.get(60)).toBeGreaterThan(0);

    scene.render({
      ...options,
      musicalTime: 0.1,
      state: { ...options.state, musicalTime: 0.1, pressedMidi: new Set<number>() },
      nowSeconds: 1.1,
    });

    expect(pressed.has(60)).toBe(false);
  });

  it('falls back to a no-op renderer when a 2d context cannot be created', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const scene = createImmersivePianoScene(document.createElement('canvas'));
    expect(scene.backend).toBe('none');
    expect(() => scene.render({} as never)).not.toThrow();
  });

  it('resets compositing state before painting a paused frame', () => {
    const tracking = stateTrackingContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(tracking.context);
    const canvas = document.createElement('canvas');
    const scene = createImmersivePianoScene(canvas);
    const timeline = buildTimeline(score());
    const visual = new VisualTimeline(timeline);
    scene.resize(900, 620, 1);

    const options = {
      musicalTime: 0.5,
      state: computeVisualState(timeline, 0.5),
      timeline: visual,
      showWaterfall: false,
      showKeyboard: true,
      particles: false,
      quality: 'medium',
      immersive: true,
      atmosphere: null,
      nowSeconds: 0.5,
      reducedMotion: true,
      keyboardHeight: 150,
    } as const;
    scene.render(options);

    // Simulate a dynamic additive pass leaving the shared context dirty before
    // the pause-triggered repaint. The layout is already settled, so this
    // second render reaches the main scene directly.
    tracking.resetDrawTracking();
    tracking.context.globalAlpha = 0.18;
    tracking.context.globalCompositeOperation = 'screen';
    scene.render(options);

    expect(tracking.firstBackdropFill).toEqual({ alpha: 1, composite: 'source-over' });
  });

  it('does not regenerate note-impact pillars on the stopped frame at time zero', () => {
    const tracking = stateTrackingContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(tracking.context);
    const scene = createImmersivePianoScene(document.createElement('canvas'));
    const timeline = buildTimeline(score());
    const visual = new VisualTimeline(timeline);
    scene.setSkin?.('seaside-glass');
    scene.resize(900, 620, 1);
    scene.render({
      musicalTime: 0.65,
      state: computeVisualState(timeline, 0.65),
      timeline: visual,
      showWaterfall: true,
      showKeyboard: true,
      particles: false,
      quality: 'medium',
      immersive: true,
      atmosphere: null,
      nowSeconds: 0.5,
      reducedMotion: true,
      keyboardHeight: 150,
    });

    tracking.resetDrawTracking();
    scene.render({
      musicalTime: 0.5,
      state: computeVisualState(timeline, 0.5),
      timeline: visual,
      showWaterfall: true,
      showKeyboard: true,
      particles: false,
      quality: 'medium',
      immersive: true,
      atmosphere: null,
      nowSeconds: 0.7,
      reducedMotion: true,
      keyboardHeight: 150,
    });
    const activeScreenFillCount = tracking.screenFillCount;
    const activeScreenDrawImageCount = tracking.screenDrawImageCount;

    tracking.resetDrawTracking();
    scene.resetVisualState?.();
    scene.render({
      musicalTime: 0,
      state: { musicalTime: 0, activeNotes: [], pressedMidi: new Set(), pedal: 0 },
      timeline: visual,
      showWaterfall: true,
      showKeyboard: true,
      particles: false,
      quality: 'medium',
      immersive: true,
      atmosphere: null,
      nowSeconds: 0.6,
      reducedMotion: true,
      transientEffects: false,
      keyboardHeight: 150,
    });

    expect(activeScreenFillCount).toBeGreaterThan(0);
    expect(tracking.screenFillCount).toBe(0);
    expect(activeScreenDrawImageCount - tracking.screenDrawImageCount).toBeGreaterThanOrEqual(2);
  });
});
