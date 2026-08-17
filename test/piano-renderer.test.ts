import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/core/timeline.js';
import type { Score } from '../src/core/types.js';
import { createPianoRenderer } from '../src/visual/piano-renderer.js';
import { computeVisualState } from '../src/visual/visual-state.js';
import { VisualTimeline } from '../src/visual/visual-timeline.js';

interface FillRectCall {
  x: number;
  y: number;
  width: number;
  height: number;
}

class FakeCanvasContext {
  fillStyle = '';
  readonly fillRects: FillRectCall[] = [];
  readonly scales: Array<[number, number]> = [];

  save(): void {}
  restore(): void {}
  clearRect(): void {}
  scale(x: number, y: number): void { this.scales.push([x, y]); }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.fillRects.push({ x, y, width, height });
  }
}

function score(): Score {
  return {
    id: 'renderer',
    title: 'Renderer',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 120 }],
    timeSignatureMap: [],
    tracks: [{
      id: 'piano',
      instrument: { id: 'grand' },
      voices: [{
        id: 'right',
        events: [{
          id: 'future-c4',
          type: 'note',
          midi: 60,
          startTick: 1_920n,
          durationTicks: 960n,
          velocity: 0.8,
          voiceId: 'right',
          trackId: 'piano',
        }],
      }],
    }],
  };
}

describe('PianoRenderer Canvas fallback', () => {
  it('renders deterministic note primitives at a fixed size, DPR, and musical time', () => {
    const context = new FakeCanvasContext();
    const canvas = {
      getContext: (kind: string) => kind === 'webgl2' ? null : context,
    } as unknown as HTMLCanvasElement;
    const timeline = buildTimeline(score());
    const visualTimeline = new VisualTimeline(timeline);
    const renderer = createPianoRenderer(canvas);
    renderer.resize(520, 200, 2);

    renderer.render({
      musicalTime: 0,
      state: computeVisualState(timeline, 0),
      timeline: visualTimeline,
      showWaterfall: true,
      showKeyboard: false,
      particles: true,
      quality: 'low',
    });

    expect(renderer.backend).toBe('canvas2d');
    expect(context.scales).toEqual([[2, 2]]);
    // Background plus the note visible eight seconds before its note-on. Low
    // quality deliberately omits glow and particle primitives.
    expect(context.fillRects).toHaveLength(2);
    expect(context.fillRects[1]).toMatchObject({ x: 225.5, y: 20, width: 9, height: 60 });

    context.fillRects.length = 0;
    renderer.render({
      musicalTime: 1,
      state: computeVisualState(timeline, 1),
      timeline: visualTimeline,
      showWaterfall: true,
      showKeyboard: false,
      particles: true,
      quality: 'medium',
    });

    // The primary note is derived directly from the same timeline at its
    // note-on position; medium quality adds deterministic glow/particles.
    expect(context.fillRects[1]).toMatchObject({ x: 225.5, y: 140, width: 9, height: 60 });
    expect(context.fillRects.length).toBeGreaterThan(2);
  });
});
