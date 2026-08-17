// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PianoSamplePack, type PianoSampleLayer } from '../src/audio/sample-pack.js';
import type { Score } from '../src/core/types.js';
import { DshPianoView, registerDshPianoView } from '../src/plugin/view.js';
import { DEFAULT_PIANIST_SETTINGS } from '../src/shared/pianist-settings.js';

const score: Score = {
  id: 'view',
  title: 'Gently',
  ppq: 960,
  tempoMap: [{ tick: 0n, bpm: 120 }],
  timeSignatureMap: [],
  tracks: [{
    id: 'piano',
    instrument: { id: 'grand' },
    voices: [{
      id: 'right',
      events: [
        { id: 'c4', type: 'note', midi: 60, startTick: 0n, durationTicks: 480n, velocity: 0.7, voiceId: 'right', trackId: 'piano' },
      ],
    }],
  }],
};

function pack(): PianoSamplePack {
  const layer: PianoSampleLayer = { id: 'c4', rootMidi: 60, velocity: 0.7, load: () => ({ duration: 1 } as AudioBuffer) };
  return new PianoSamplePack([layer]);
}

class FakeAudioParam {
  value = 1;
  setValueAtTime(v: number): this { this.value = v; return this; }
  linearRampToValueAtTime(v: number): this { this.value = v; return this; }
  setTargetAtTime(v: number): this { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number): this { this.value = v; return this; }
  cancelScheduledValues(): this { return this; }
}
class FakeAudioNode { connect<T>(d: T): T { return d; } disconnect(): void {} }
class FakeGainNode extends FakeAudioNode { readonly gain = new FakeAudioParam(); }
class FakeStereoPannerNode extends FakeAudioNode { readonly pan = new FakeAudioParam(); }
class FakeBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam();
  onended: (() => void) | null = null;
  start(): void {} stop(): void {}
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly sampleRate = 44_100;
  readonly destination = new FakeAudioNode();
  constructor() { FakeAudioContext.instances.push(this); }
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakeStereoPannerNode { return new FakeStereoPannerNode(); }
  createBufferSource(): FakeBufferSourceNode { return new FakeBufferSourceNode(); }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; }
}

let pendingFrames: FrameRequestCallback[] = [];

beforeEach(() => {
  pendingFrames = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback) => {
    pendingFrames.push(callback);
    return pendingFrames.length;
  }) as unknown as typeof requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  registerDshPianoView();
});

afterEach(() => {
  document.body.replaceChildren();
  FakeAudioContext.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountView(): DshPianoView {
  const view = document.createElement('dsh-piano-view') as DshPianoView;
  Object.defineProperty(view, 'getBoundingClientRect', {
    value: () => ({ bottom: 300, height: 300, left: 0, right: 500, top: 0, width: 500, x: 0, y: 0 }),
  });
  document.body.appendChild(view);
  view.setScore(score);
  view.setSamplePack(pack());
  view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
  return view;
}

/**
 * Drive the RAF-backed tick loop for a bounded number of frames so playback
 * transitions (especially end-of-playback return) can settle deterministically.
 */
async function flushFrames(n = 30): Promise<void> {
  let budget = n;
  while (budget > 0 && pendingFrames.length > 0) {
    const callback = pendingFrames.shift()!;
    budget -= 1;
    callback(performance.now());
  }
  await Promise.resolve();
}

/** Canvas2D recording context that counts method calls per canvas. */
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

describe('immersive mode', () => {
  it('opens and closes the full-viewport presentation and emits render-mode events', () => {
    const view = mountView();
    const events: string[] = [];
    view.addEventListener('pianist-render-mode', (event) => {
      events.push((event as CustomEvent<{ reason: string }>).detail.reason);
    });

    view.requestImmersive();
    expect(view.isImmersive).toBe(true);
    expect(view.renderMode).toBe('immersive');
    expect(view.getAttribute('data-pianist-immersive')).not.toBeNull();
    expect(view.dataset.pianistRenderMode).toBe('immersive');
    const ui = view.shadowRoot?.querySelector<HTMLElement>('[data-pianist-immersive-ui]');
    expect(ui?.hidden).toBe(false);

    view.requestExitImmersive('user');
    expect(view.isImmersive).toBe(false);
    expect(view.getAttribute('data-pianist-immersive')).toBeNull();
    expect(events).toEqual(['user', 'user']);
  });

  it('promotes the view to the browser top layer when its chat host clips fixed descendants', () => {
    const shell = document.createElement('div');
    shell.style.overflow = 'hidden';
    shell.style.transform = 'translateZ(0)';
    const view = mountView();
    shell.appendChild(view);
    document.body.appendChild(shell);

    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    Object.assign(view, { showPopover, hidePopover });

    view.requestImmersive();

    expect(view.getAttribute('popover')).toBe('manual');
    expect(showPopover).toHaveBeenCalledTimes(1);

    view.requestExitImmersive('user');
    expect(hidePopover).toHaveBeenCalledTimes(1);
  });

  it('provides a large tap target and a labelled close control', () => {
    const view = mountView();
    const close = view.shadowRoot?.querySelector<HTMLButtonElement>('[data-pianist-immersive-close]');
    if (close === null || close === undefined) throw new Error('close button missing');
    expect(close.getAttribute('aria-label')).toBeTruthy();
    const style = view.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(style).toContain('min-width: 44px');
    expect(style).toContain('min-height: 44px');

    view.requestImmersive();
    close.click();
    expect(view.isImmersive).toBe(false);
  });

  it('uses only the close button to leave immersive mode', () => {
    const view = mountView();
    expect(view.shadowRoot?.querySelector('[data-pianist-immersive-close]')).not.toBeNull();
    expect(view.shadowRoot?.querySelector('[data-pianist-immersive-return]')).toBeNull();
    const style = view.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(style).not.toContain('[data-pianist-immersive-return]');
  });

  it('closes on Escape without altering playback', () => {
    const view = mountView();
    view.requestImmersive();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(view.isImmersive).toBe(false);
  });

  it('honors reduced motion with a shorter transition', () => {
    const view = mountView();
    const style = view.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(style).toContain('(prefers-reduced-motion: reduce)');
  });

  it('auto-returns to the chat when an immersive performance ends', async () => {
    const view = mountView();
    const reasons: string[] = [];
    view.addEventListener('pianist-render-mode', (event) => {
      reasons.push((event as CustomEvent<{ reason: string }>).detail.reason);
    });
    view.requestImmersive();

    await view.play();
    expect(view.playbackState).toBe('playing');

    // Reach the end deterministically through the controller.
    view.seek(view.duration);
    expect(view.playbackState).toBe('ended');
    await flushFrames();

    expect(view.isImmersive).toBe(false);
    expect(reasons).toContain('ended');
  });

  it('does not auto-return when the user stops manually', async () => {
    const view = mountView();
    view.requestImmersive();
    await view.play();
    expect(view.playbackState).toBe('playing');

    view.stop();
    await flushFrames();

    expect(view.isImmersive).toBe(true);
  });

  it('clears audio-response energy when immersive playback is stopped', async () => {
    const view = mountView();
    view.requestImmersive();
    await view.play();
    await flushFrames(2);
    expect(view.audioAnalysis.energy).toBeGreaterThan(0);

    view.stop();

    expect(view.audioAnalysis.energy).toBe(0);
    expect(view.playbackState).toBe('ready');

    // The always-running RAF loop must not revive analyser tails after the
    // synchronous stopped frame has already been painted.
    await flushFrames(4);
    expect(view.audioAnalysis.energy).toBe(0);
  });

  it('clears audio-response energy while immersive playback is paused', async () => {
    const view = mountView();
    view.requestImmersive();
    await view.play();
    await flushFrames(2);
    expect(view.audioAnalysis.energy).toBeGreaterThan(0);

    view.pause();
    await flushFrames(4);

    expect(view.audioAnalysis.energy).toBe(0);
    expect(view.playbackState).toBe('paused');
  });

  it('does not auto-return when returnToEmbeddedOnEnd is disabled', async () => {
    const view = mountView();
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS, returnToEmbeddedOnEnd: false });
    view.requestImmersive();
    await view.play();

    view.seek(view.duration);
    expect(view.playbackState).toBe('ended');
    await flushFrames();

    expect(view.isImmersive).toBe(true);
  });

  it('falls back to event analysis when the AudioContext has no analyser', async () => {
    const view = mountView();
    view.requestImmersive();
    await view.play();
    // No createAnalyser on the double: the view keeps playing and reports event-driven analysis.
    expect(view.playbackState).toBe('playing');
    expect(view.audioAnalysis.usingAnalyser).toBe(false);
  });

  it('actually paints the immersive scene canvas while the card canvas is hidden', async () => {
    // Per-canvas call counters prove the fullscreen overlay really draws.
    const perCanvas = new Map<HTMLCanvasElement, Record<string, number>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, contextId: string) {
      if (contextId !== '2d') return null;
      let counts = perCanvas.get(this);
      if (counts === undefined) {
        counts = {};
        perCanvas.set(this, counts);
      }
      return trackingContext(counts);
    } as unknown as typeof HTMLCanvasElement.prototype.getContext);

    const view = mountView();
    const cardCanvas = view.shadowRoot?.querySelector<HTMLCanvasElement>('canvas');
    const immersiveCanvas = view.shadowRoot?.querySelector<HTMLCanvasElement>('[data-pianist-immersive-canvas]');
    if (cardCanvas === null || cardCanvas === undefined) throw new Error('card canvas missing');
    if (immersiveCanvas === null || immersiveCanvas === undefined) throw new Error('immersive canvas missing');
    // The immersive scene attached its own 2d context at construction.
    expect(perCanvas.has(immersiveCanvas)).toBe(true);

    const immersiveCalls = perCanvas.get(immersiveCanvas)!;
    for (const key of Object.keys(immersiveCalls)) delete immersiveCalls[key];

    view.requestImmersive();
    await flushFrames(6);

    // The scene blitted the pre-rendered piano body plus one sprite per key.
    expect(immersiveCalls.drawImage ?? 0).toBeGreaterThan(88);
    // Ribbons and glass use stroked paths.
    expect(immersiveCalls.stroke ?? 0).toBeGreaterThan(0);
    // While immersive, the old card canvas is hidden and no longer painted.
    expect(cardCanvas.style.visibility).toBe('hidden');

    view.requestExitImmersive('user');
    await flushFrames(6);
    expect(cardCanvas.style.visibility).toBe('');
  });
});
