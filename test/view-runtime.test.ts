// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PianoSamplePack, type PianoSampleLayer } from '../src/audio/sample-pack.js';
import type { Score } from '../src/core/types.js';
import {
  DshPianoView,
  registerDshPianoView,
  type PianistAudioRuntimeErrorDetail,
} from '../src/plugin/view.js';
import { DEFAULT_PIANIST_SETTINGS } from '../src/shared/pianist-settings.js';

const score: Score = {
  id: 'view',
  title: 'View',
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
        { id: 'pedal', type: 'pedal', startTick: 0n, endTick: 480n, value: 1, voiceId: 'right', trackId: 'piano' },
      ],
    }],
  }],
};

function pack(): PianoSamplePack {
  const layer: PianoSampleLayer = {
    id: 'c4', rootMidi: 60, velocity: 0.7, load: () => ({ duration: 1 } as AudioBuffer),
  };
  return new PianoSamplePack([layer]);
}

class FakeAudioParam {
  value = 1;

  setValueAtTime(value: number): this { this.value = value; return this; }
  linearRampToValueAtTime(value: number): this { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number): this { this.value = value; return this; }
  setTargetAtTime(value: number): this { this.value = value; return this; }
  cancelScheduledValues(): this { return this; }
}

class FakeAudioNode {
  connect<T>(destination: T): T { return destination; }
  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam();
  onended: (() => void) | null = null;
  readonly starts: number[] = [];
  readonly stops: number[] = [];

  start(when = 0): void { this.starts.push(when); }
  stop(when = 0): void { this.stops.push(when); }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  state: AudioContextState = 'running';
  readonly sampleRate = 44_100;
  readonly destination = new FakeAudioNode();
  readonly sources: FakeBufferSourceNode[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGainNode { return new FakeGainNode(); }
  createStereoPanner(): FakeStereoPannerNode { return new FakeStereoPannerNode(); }
  createBufferSource(): FakeBufferSourceNode {
    const source = new FakeBufferSourceNode();
    this.sources.push(source);
    return source;
  }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; }
}

class SuspendedAudioContext extends FakeAudioContext {
  override state: AudioContextState = 'suspended';

  override async resume(): Promise<void> {
    // Some browsers resolve resume() without unlocking until a valid gesture.
  }
}

function pointerEvent(
  type: 'pointerdown' | 'pointerup',
  init: { pointerId: number; clientX: number; clientY: number; button?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    button: { value: init.button ?? 0 },
  });
  return event;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  registerDshPianoView();
});

afterEach(() => {
  document.body.replaceChildren();
  FakeAudioContext.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DshPianoView runtime settings', () => {
  it('changes from an explicit missing-pack fallback to a configured sample source', () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    const status = vi.fn();
    view.addEventListener('pianist-audio-source-status', status);

    const missing = view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    expect(missing.audioSource).toEqual({
      requested: 'sample-pack', effective: 'generated', fallbackReason: 'sample-pack-unavailable',
    });

    const configured = view.setSamplePack(pack());
    expect(configured.audioSource).toEqual({ requested: 'sample-pack', effective: 'sample-pack' });
    expect(view.dataset.pianistAudioSource).toBe('sample-pack');
    expect(view.dataset.pianistAudioSourceFallback).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('preloads the registered pack and schedules its decoded sample during playback', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    const decoded = { duration: 1 } as AudioBuffer;
    const load = vi.fn(() => decoded);
    view.setSamplePack(new PianoSamplePack([{
      id: 'recorded-c4', rootMidi: 60, velocity: 0.7, load,
    }]));
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);

    await view.play();

    expect(load).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.sources[0]?.buffer).toBe(decoded);
    expect(view.dataset.pianistAudioSource).toBe('sample-pack');
  });

  it('sounds a visible key for exactly the pointer hold instead of using a click', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    Object.defineProperty(view, 'getBoundingClientRect', {
      value: () => ({ bottom: 200, height: 200, left: 0, right: 520, top: 0, width: 520, x: 0, y: 0 }),
    });
    document.body.appendChild(view);
    view.setScore(score);
    view.setSamplePack(pack());
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const canvas = view.shadowRoot?.querySelector('canvas');
    if (canvas === null || canvas === undefined) throw new Error('expected piano canvas');
    const auditions: unknown[] = [];
    view.addEventListener('pianist-key-audition', (event) => {
      auditions.push((event as CustomEvent).detail);
    });

    canvas.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 7,
      clientX: 235,
      clientY: 190,
    }));

    await vi.waitFor(() => {
      expect(FakeAudioContext.instances[0]?.sources).toHaveLength(1);
    });
    const source = FakeAudioContext.instances[0]!.sources[0]!;
    expect(source.starts).toEqual([0]);
    expect(view.dataset.pianistLastAudition).toBe('pressed:60');

    FakeAudioContext.instances[0]!.currentTime = 0.75;
    canvas.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 7,
      clientX: 235,
      clientY: 190,
    }));

    expect(source.stops[0]).toBeGreaterThan(0.75);
    expect(view.dataset.pianistLastAudition).toBe('released:60');
    expect(auditions).toEqual([
      { midi: 60, state: 'pressed', source: 'pointer' },
      { midi: 60, state: 'released', source: 'pointer' },
    ]);
  });

  it('resolves pointer coordinates against the canvas rather than the host shell', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    Object.defineProperty(view, 'getBoundingClientRect', {
      value: () => ({ bottom: 300, height: 200, left: 180, right: 700, top: 100, width: 520, x: 180, y: 100 }),
    });
    document.body.appendChild(view);
    view.setScore(score);
    view.setSamplePack(pack());
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const canvas = view.shadowRoot?.querySelector('canvas');
    if (canvas === null || canvas === undefined) throw new Error('expected piano canvas');
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      value: () => ({ bottom: 200, height: 200, left: 0, right: 520, top: 0, width: 520, x: 0, y: 0 }),
    });

    const auditions: unknown[] = [];
    view.addEventListener('pianist-key-audition', (event) => auditions.push((event as CustomEvent).detail));
    canvas.dispatchEvent(pointerEvent('pointerdown', { pointerId: 17, clientX: 235, clientY: 190 }));

    await vi.waitFor(() => { expect(view.dataset.pianistLastAudition).toBe('pressed:60'); });
    expect(auditions).toContainEqual({ midi: 60, state: 'pressed', source: 'pointer' });
    canvas.dispatchEvent(pointerEvent('pointerup', { pointerId: 17, clientX: 235, clientY: 190 }));
  });

  it('preserves a cold quick tap until the recorded sample finishes loading', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    Object.defineProperty(view, 'getBoundingClientRect', {
      value: () => ({ bottom: 200, height: 200, left: 0, right: 520, top: 0, width: 520, x: 0, y: 0 }),
    });
    document.body.appendChild(view);
    view.setScore(score);
    let resolveSample!: (buffer: AudioBuffer) => void;
    const load = vi.fn(() => new Promise<AudioBuffer>((resolve) => { resolveSample = resolve; }));
    view.setSamplePack(new PianoSamplePack([{
      id: 'recorded-c4', rootMidi: 60, velocity: 0.7, load,
    }]));
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const canvas = view.shadowRoot?.querySelector('canvas');
    if (canvas === null || canvas === undefined) throw new Error('expected piano canvas');
    const auditions: unknown[] = [];
    view.addEventListener('pianist-key-audition', (event) => {
      auditions.push((event as CustomEvent).detail);
    });

    canvas.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 9,
      clientX: 235,
      clientY: 190,
    }));
    await vi.waitFor(() => { expect(load).toHaveBeenCalledTimes(1); });
    canvas.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 9,
      clientX: 235,
      clientY: 190,
    }));
    expect(view.dataset.pianistActiveAuditions).toBe('0');

    resolveSample({ duration: 1 } as AudioBuffer);

    await vi.waitFor(() => {
      expect(FakeAudioContext.instances[0]?.sources).toHaveLength(1);
    });
    const source = FakeAudioContext.instances[0]!.sources[0]!;
    expect(source.starts).toEqual([0]);
    expect(source.stops[0]).toBeGreaterThan(0.08);
    expect(view.dataset.pianistLastAudition).toBe('released:60');
    expect(auditions).toEqual([
      { midi: 60, state: 'pressed', source: 'pointer' },
      { midi: 60, state: 'released', source: 'pointer' },
    ]);
  });

  it('coalesces concurrent play requests into one audio initialization', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    view.setSamplePack(pack());
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);

    await Promise.all([view.play(), view.play()]);

    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('keeps audio playing across page visibility changes without replaying', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    view.setSamplePack(pack());
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);

    await view.play();
    expect(view.playbackState).toBe('playing');
    const context = FakeAudioContext.instances[0];
    if (context === undefined) throw new Error('expected audio context');
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(view.playbackState).toBe('playing');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(view.playbackState).toBe('playing');
    expect(context.state).toBe('running');
    if (visibility !== undefined) {
      Object.defineProperty(document, 'visibilityState', visibility);
    }
  });

  it('preloads a new recorded working set before immediately playing a replacement score', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    const c4 = { duration: 1 } as AudioBuffer;
    const d4 = { duration: 1 } as AudioBuffer;
    const loadC4 = vi.fn(() => c4);
    const loadD4 = vi.fn(() => d4);
    view.setSamplePack(new PianoSamplePack([
      { id: 'recorded-c4', rootMidi: 60, velocity: 0.7, load: loadC4 },
      { id: 'recorded-d4', rootMidi: 62, velocity: 0.7, load: loadD4 },
    ]));
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    view.setScore(score);
    await view.play();

    const replacement = structuredClone(score);
    replacement.id = 'replacement';
    const replacementNote = replacement.tracks[0]?.voices[0]?.events[0];
    if (replacementNote?.type !== 'note') throw new Error('expected replacement note');
    replacementNote.id = 'd4';
    replacementNote.midi = 62;
    view.setScore(replacement);
    await view.play();

    expect(loadC4).toHaveBeenCalledTimes(1);
    expect(loadD4).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.sources.at(-1)?.buffer).toBe(d4);
  });

  it('preloads newly streamed pitches without stopping voices from the playing prefix', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    const c4 = { duration: 1 } as AudioBuffer;
    const d4 = { duration: 1 } as AudioBuffer;
    const loadC4 = vi.fn(() => c4);
    const loadD4 = vi.fn(() => d4);
    view.setSamplePack(new PianoSamplePack([
      { id: 'recorded-c4', rootMidi: 60, velocity: 0.7, load: loadC4 },
      { id: 'recorded-d4', rootMidi: 62, velocity: 0.7, load: loadD4 },
    ]));
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    view.setScore(score);
    await view.play();
    const activePrefixSource = FakeAudioContext.instances[0]!.sources[0]!;
    const extended = structuredClone(score);
    extended.id = 'stream-extended';
    extended.tracks[0]!.voices[0]!.events.push({
      id: 'd4', type: 'note', midi: 62, startTick: 960n, durationTicks: 480n,
      velocity: 0.7, voiceId: 'right', trackId: 'piano',
    });

    await view.updateScore(extended);

    expect(loadD4).toHaveBeenCalledTimes(1);
    expect(activePrefixSource.stops).toEqual([]);
    expect(view.playbackState).toBe('playing');
  });

  it('supports stop, runtime volume, mute, and deterministic seek without profile writes', () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);

    view.seek(0.2);
    expect(view.currentTime).toBeCloseTo(0.2, 12);
    expect(view.pedal).toBe(1);
    view.setVolume(0.45);
    view.setMuted(true);
    expect(view.isMuted).toBe(true);
    view.stop();
    expect(view.currentTime).toBe(0);
    expect(view.pedal).toBe(0);
    expect(() => view.setVolume(1.1)).toThrow(RangeError);
  });

  it('clamps pre-audio seeks before writing the placeholder clock', () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);

    view.seek(Number.POSITIVE_INFINITY);
    expect(view.currentTime).toBeCloseTo(view.duration, 12);
    view.seek(Number.NEGATIVE_INFINITY);
    expect(view.currentTime).toBe(0);
    view.seek(Number.NaN);
    expect(view.currentTime).toBe(0);
  });

  it('keeps the visual state empty after replacing a score until playback or seek reconstructs it', () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);

    view.seek(0.2);
    expect(view.pedal).toBe(1);

    view.setScore(score);
    expect(view.currentTime).toBe(0);
    expect(view.pedal).toBe(0);

    view.seek(0);
    expect(view.pedal).toBe(1);
  });

  it('exposes bounded sync diagnostics and reconstructs visual state after drift', () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    view.seek(0.2);
    view.setDebugOverlay(true);

    const recovery = view.checkSync(0.3, 16);
    const overlay = view.shadowRoot?.querySelector<HTMLOutputElement>('[data-pianist-debug-overlay]');

    expect(recovery).toMatchObject({ required: true, expectedMusicalTime: 0.2, observedVisualTime: 0.3 });
    expect(view.pedal).toBe(1);
    expect(view.syncDiagnosticSnapshot.visualTime).toBeCloseTo(0.2, 12);
    expect(overlay?.hidden).toBe(false);
    expect(overlay?.textContent).toContain('Musical Time: 0.200');
    expect(view.syncRuntimeLog.map(entry => entry.type)).toContain('SYNC_WARNING');
    expect(view.syncRuntimeLog.map(entry => entry.type)).toContain('SYNC_RECOVERY');
  });

  it('keeps the explicit reset visual state when sync is checked after stop', () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    view.seek(0.2);
    view.stop();

    const recovery = view.checkSync(0.1, 16);

    expect(recovery.required).toBe(true);
    expect(view.pedal).toBe(0);
    expect(view.syncRuntimeLog.map(entry => entry.type)).not.toContain('SYNC_RECOVERY');
  });

  it('reports AudioContext failures instead of starting a visual-only performance', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    vi.stubGlobal('AudioContext', undefined);
    const errors: PianistAudioRuntimeErrorDetail[] = [];
    view.addEventListener('pianist-audio-error', (event) => {
      errors.push((event as CustomEvent<PianistAudioRuntimeErrorDetail>).detail);
    });

    await expect(view.play()).rejects.toMatchObject({ code: 'audio-context-unavailable' });

    expect(view.currentTime).toBe(0);
    expect(view.audioErrorCode).toBe('audio-context-unavailable');
    expect(view.dataset.pianistAudioError).toBe('audio-context-unavailable');
    expect(errors).toEqual([{ code: 'audio-context-unavailable' }]);
  });

  it('does not report playback when a resolved resume leaves audio suspended', async () => {
    const view = document.createElement('dsh-piano-view') as DshPianoView;
    document.body.appendChild(view);
    view.setScore(score);
    view.setSamplePack(pack());
    view.setPianistSettings({ ...DEFAULT_PIANIST_SETTINGS });
    vi.stubGlobal('AudioContext', SuspendedAudioContext);

    await expect(view.play()).rejects.toMatchObject({ code: 'audio-resume-failed' });

    expect(view.currentTime).toBe(0);
    expect(view.audioErrorCode).toBe('audio-resume-failed');
    expect(view.dataset.pianistAudioError).toBe('audio-resume-failed');
  });
});
