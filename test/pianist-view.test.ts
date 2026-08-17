/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DshPianoView,
  registerDshPianoView,
  type PianistAudioSourceStatus,
} from '../src/plugin/view.js';
import type { Score } from '../src/core/types.js';
import { DEFAULT_PIANIST_SETTINGS, type PianistSettings } from '../src/shared/pianist-settings.js';

function settings(overrides: Partial<PianistSettings> = {}): PianistSettings {
  return {
    ...DEFAULT_PIANIST_SETTINGS,
    ...overrides,
    events: { ...DEFAULT_PIANIST_SETTINGS.events, ...overrides.events },
  };
}

/**
 * The immersive scene renderer drives Canvas2D directly (gradients, sprites,
 * strokes), so the fake context records method calls instead of painting.
 */
function trackingContext(counts: Record<string, number>): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (property === 'createLinearGradient' || property === 'createRadialGradient') return () => gradient;
      if (property === 'measureText') return () => ({ width: 0 });
      if (property === 'createPattern') return () => ({}) as unknown as CanvasPattern;
      if (property === 'canvas') return { width: 0, height: 0 };
      return (..._args: unknown[]) => {
        const key = String(property);
        counts[key] = (counts[key] ?? 0) + 1;
      };
    },
    set() { return true; },
  }) as unknown as CanvasRenderingContext2D;
}

let counts: Record<string, number>;
let getContext: ReturnType<typeof vi.fn>;

beforeEach(() => {
  counts = {};
  const context = trackingContext(counts);
  getContext = vi.fn((contextId: string) => (contextId === '2d' ? context : null));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(getContext as never);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mountView(): DshPianoView {
  registerDshPianoView();
  const view = document.createElement('dsh-piano-view') as DshPianoView;
  Object.defineProperty(view, 'getBoundingClientRect', {
    value: () => ({ bottom: 50, height: 50, left: 0, right: 100, top: 0, width: 100, x: 0, y: 0 }),
  });
  document.body.appendChild(view);
  return view;
}

describe('DshPianoView profile settings', () => {
  it('applies durable visual and audio settings without pretending an unavailable sample pack loaded', () => {
    const view = mountView();

    const statuses: PianistAudioSourceStatus[] = [];
    view.addEventListener('pianist-audio-source-status', (event) => {
      statuses.push((event as CustomEvent<PianistAudioSourceStatus>).detail);
    });

    const fallback = view.setPianistSettings(settings({
      skin: 'lacquer-gold',
      enabled: false,
      showWaterfall: false,
      visualQuality: 'low',
      volume: 0.25,
    }));
    const canvas = view.shadowRoot?.querySelector('canvas');

    expect(canvas?.style.visibility).toBe('hidden');
    // Quality "low" caps the device pixel ratio at 1, so a 100px card paints 100px.
    expect(canvas?.width).toBe(100);
    expect(fallback.audioSource).toEqual({
      requested: 'sample-pack',
      effective: 'generated',
      fallbackReason: 'sample-pack-unavailable',
    });
    expect(statuses).toEqual([fallback.audioSource]);
    expect(view.dataset.pianistAudioSourceFallback).toBe('sample-pack-unavailable');
    expect(view.skin).toBe('lacquer-gold');
    expect(view.dataset.pianistEmbeddedSkin).toBe('lacquer-gold');
    expect(view.dataset.pianistImmersiveSkin).toBe('lacquer-gold');

    for (const key of Object.keys(counts)) delete counts[key];
    view.setPianistSettings(settings({ visualQuality: 'high', showWaterfall: false }));

    expect(canvas?.style.visibility).toBe('');
    // Quality "high" allows the full 2x device pixel ratio.
    expect(canvas?.width).toBe(200);
    // The scene renderer blits the pre-rendered piano body plus one sprite per
    // physical key, so at least 88 key sprites were drawn through the 2d
    // context - proving the always-visible keyboard reaches the renderer
    // rather than remaining card-only state.
    expect(counts.drawImage ?? 0).toBeGreaterThan(88);
  });

  it('renders upcoming notes from VisualTimeline through the scene renderer', () => {
    const view = mountView();
    view.setScore(futureNoteScore());

    for (const key of Object.keys(counts)) delete counts[key];
    view.setPianistSettings(settings({
      showWaterfall: true,
      visualQuality: 'high',
    }));

    // The scene renders through a Canvas2D context, not WebGL.
    expect(getContext.mock.calls.some(([contextId]) => contextId === '2d')).toBe(true);
    expect(getContext.mock.calls.some(([contextId]) => contextId === 'webgl2')).toBe(false);
    // A future note (starting 1s ahead) becomes a falling light ribbon, which
    // the scene strokes twice (glow pass + core pass). The note is not active
    // yet, so this proves rendering reads VisualTimeline rather than only the
    // current VisualState.activeNotes collection.
    expect(counts.stroke ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.drawImage ?? 0).toBeGreaterThan(88);
  });

  it('recreates its renderer after a disconnect and reattach', () => {
    const view = mountView();
    document.body.removeChild(view);
    document.body.appendChild(view);

    // Reattaching rebuilds the scene renderer: fresh 2d contexts are requested
    // for the card canvas, the immersive canvas, and their sprite layers.
    const twoDeeRequests = getContext.mock.calls.filter(([contextId]) => contextId === '2d');
    expect(twoDeeRequests.length).toBeGreaterThanOrEqual(2);
    expect(view.renderMode).toBe('embedded');
  });
});

function futureNoteScore(): Score {
  return {
    id: 'future-note',
    title: 'Future note',
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
          durationTicks: 480n,
          velocity: 0.8,
          voiceId: 'right',
          trackId: 'piano',
        }],
      }],
    }],
  };
}
