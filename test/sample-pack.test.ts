import { describe, expect, it, vi } from 'vitest';
import {
  MissingSamplePackError,
  PianoSamplePack,
  SamplePackNotReadyError,
  SamplePackPreloadError,
  pianoStereoPan,
  samplePlaybackRate,
  selectSampleLayer,
  selectVelocityLayer,
} from '../src/audio/sample-pack.js';
import { SamplePackPianoEngine } from '../src/audio/sample-piano-engine.js';
import { GeneratedPianoEngine } from '../src/audio/generated-piano-engine.js';
import { createPianoEngine } from '../src/audio/index.js';
import { createPianoSamplePackFromManifest } from '../src/audio/sample-manifest.js';
import type { PianoSampleLayer } from '../src/audio/sample-pack.js';
import { createBundledSalamanderPianoSamplePack } from '../src/audio/bundled-sample-pack.js';
import { SALAMANDER_SAMPLE_ASSETS } from '../src/shared/salamander-samples.js';

class FakeAudioParam {
  value: number;
  readonly calls: Array<{ method: string; value?: number; when: number }> = [];

  constructor(value = 1) {
    this.value = value;
  }

  setValueAtTime(value: number, when: number): this {
    this.value = value;
    this.calls.push({ method: 'set', value, when });
    return this;
  }

  linearRampToValueAtTime(value: number, when: number): this {
    this.value = value;
    this.calls.push({ method: 'linear', value, when });
    return this;
  }

  exponentialRampToValueAtTime(value: number, when: number): this {
    this.value = value;
    this.calls.push({ method: 'exponential', value, when });
    return this;
  }

  cancelScheduledValues(when: number): this {
    this.calls.push({ method: 'cancel', when });
    return this;
  }

  cancelAndHoldAtTime(when: number): this {
    // Real engines pin the computed curve value here; the fake keeps the
    // current value, which tests assign explicitly to simulate mid-fade.
    this.calls.push({ method: 'cancel-hold', when });
    return this;
  }
}

class FakeNode {
  readonly connections: unknown[] = [];
  disconnected = false;

  connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGainNode extends FakeNode {
  readonly gain = new FakeAudioParam();
}

class FakeStereoPannerNode extends FakeNode {
  readonly pan = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeAudioParam(1);
  readonly startCalls: Array<{ when: number; offset: number | undefined }> = [];
  readonly stopCalls: number[] = [];
  onended: (() => void) | null = null;

  start(when: number, offset?: number): void {
    this.startCalls.push({ when, offset });
  }

  stop(when: number): void {
    this.stopCalls.push(when);
  }

  finish(): void {
    this.onended?.();
  }
}

class FakeAudioContext {
  readonly sampleRate = 48_000;
  currentTime = 0;
  readonly destination = new FakeNode();
  readonly sources: FakeBufferSourceNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly panners: FakeStereoPannerNode[] = [];

  createBufferSource(): FakeBufferSourceNode {
    const source = new FakeBufferSourceNode();
    this.sources.push(source);
    return source;
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createStereoPanner(): FakeStereoPannerNode {
    const panner = new FakeStereoPannerNode();
    this.panners.push(panner);
    return panner;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      duration: length / sampleRate,
      copyToChannel: () => undefined,
    } as unknown as AudioBuffer;
  }

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return { id: `decoded-${data.byteLength}`, duration: 2 } as unknown as AudioBuffer;
  }
}

function fakeBuffer(id: string): AudioBuffer {
  return { id, duration: 8 } as unknown as AudioBuffer;
}

function layer(
  id: string,
  rootMidi: number,
  velocity: number,
  load: PianoSampleLayer['load'] = () => fakeBuffer(id),
): PianoSampleLayer {
  return { id, rootMidi, velocity, load };
}

function defaultPack(): PianoSamplePack {
  return new PianoSamplePack([
    layer('c4-soft', 60, 0.25),
    layer('c4-loud', 60, 0.8),
    layer('c5-loud', 72, 0.8),
  ]);
}

describe('piano sample pack selection', () => {
  it('selects the nearest root before selecting its closest velocity layer', () => {
    const layers = [
      layer('c4-soft', 60, 0.25),
      layer('c4-loud', 60, 0.8),
      layer('c5-loud', 72, 0.8),
      layer('d4-loud', 62, 0.8),
    ];

    expect(selectSampleLayer(layers, 61, 0.8).id).toBe('c4-loud');
    expect(selectVelocityLayer([layers[0]!, layers[1]!], 0.525).id).toBe('c4-soft');
  });

  it('calculates pitch shift and keyboard stereo position deterministically', () => {
    expect(samplePlaybackRate(72, 60)).toBeCloseTo(2, 12);
    expect(samplePlaybackRate(48, 60)).toBeCloseTo(0.5, 12);
    expect(pianoStereoPan(21)).toBeCloseTo(-0.8, 12);
    expect(pianoStereoPan(108)).toBeCloseTo(0.8, 12);
    expect(pianoStereoPan(64)).toBeLessThan(0);
    expect(pianoStereoPan(65)).toBeGreaterThan(0);
  });

  it('preloads all layers once and refuses playback selection before preload', async () => {
    const load = vi.fn(() => fakeBuffer('only'));
    const pack = new PianoSamplePack([layer('only', 60, 0.5, load)]);
    const context = new FakeAudioContext();

    expect(() => pack.select(60, 0.5)).toThrow(SamplePackNotReadyError);
    await Promise.all([
      pack.preload(context as unknown as BaseAudioContext),
      pack.preload(context as unknown as BaseAudioContext),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(pack.isReady).toBe(true);
    expect(pack.select(60, 0.5).buffer).toEqual(fakeBuffer('only'));
  });

  it('reports a failed layer instead of falling back to generated audio', async () => {
    const pack = new PianoSamplePack([
      layer('broken', 60, 0.5, () => { throw new Error('missing asset'); }),
    ]);
    const context = new FakeAudioContext();

    await expect(pack.preload(context as unknown as BaseAudioContext)).rejects.toMatchObject({
      name: 'SamplePackPreloadError',
      layerId: 'broken',
    } satisfies Partial<SamplePackPreloadError>);
    expect(pack.isReady).toBe(false);
  });

  it('preloads only score-selected attack, release, and resonance layers', async () => {
    const pack = new PianoSamplePack([
      layer('attack-c4', 60, 0.5),
      { ...layer('release-c4', 60, 0.5), kind: 'release' as const },
      { ...layer('resonance-c4', 60, 0.5), kind: 'resonance' as const },
      layer('attack-d4', 62, 0.5),
    ]);
    const context = new FakeAudioContext();

    await pack.preload(context as unknown as BaseAudioContext, [{ midi: 60, velocity: 0.5 }]);

    expect(pack.cachedLayerIds).toEqual(['attack-c4', 'release-c4', 'resonance-c4']);
    expect(pack.select(60, 0.5).layer.id).toBe('attack-c4');
    expect(pack.selectRelease(60, 0.5)?.layer.id).toBe('release-c4');
    expect(pack.selectResonance(60, 0.5)?.layer.id).toBe('resonance-c4');
    expect(() => pack.select(62, 0.5)).toThrow(SamplePackNotReadyError);
  });

  it('makes attack samples ready before optional layers finish warming', async () => {
    let finishAuxiliary: (() => void) | undefined;
    const auxiliaryReady = new Promise<void>(resolve => { finishAuxiliary = resolve; });
    const pack = new PianoSamplePack([
      layer('attack-c4', 60, 0.5),
      { ...layer('release-c4', 60, 0.5, async () => {
        await auxiliaryReady;
        return fakeBuffer('release-c4');
      }), kind: 'release' as const },
    ]);
    const context = new FakeAudioContext();

    await pack.preloadAttacks(context as unknown as BaseAudioContext, [{ midi: 60, velocity: 0.5 }]);
    const warming = pack.preloadAuxiliary(context as unknown as BaseAudioContext, [{ midi: 60, velocity: 0.5 }]);

    expect(pack.select(60, 0.5).layer.id).toBe('attack-c4');
    expect(pack.selectRelease(60, 0.5)).toBeUndefined();
    finishAuxiliary?.();
    await warming;
    expect(pack.selectRelease(60, 0.5)?.layer.id).toBe('release-c4');
  });

  it('evicts decoded layers by deterministic LRU order when configured', async () => {
    const pack = new PianoSamplePack([
      layer('c4', 60, 0.5),
      layer('d4', 62, 0.5),
    ], { maxCachedLayers: 1 });
    const context = new FakeAudioContext();

    await pack.preload(context as unknown as BaseAudioContext, [{ midi: 60, velocity: 0.5 }]);
    expect(pack.select(60, 0.5).layer.id).toBe('c4');
    await pack.preload(context as unknown as BaseAudioContext, [{ midi: 62, velocity: 0.5 }]);

    expect(pack.cachedLayerIds).toEqual(['d4']);
    expect(() => pack.select(60, 0.5)).toThrow(SamplePackNotReadyError);
  });

  it('constructs decode loaders from a serializable asset manifest', async () => {
    const fetchSample = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(12) }));
    const pack = createPianoSamplePackFromManifest({
      id: 'recorded-grand',
      version: '1.0.0',
      layers: [{ id: 'recorded-c4', url: '/samples/c4.ogg', rootMidi: 60, velocity: 0.5 }],
    }, fetchSample);

    await pack.preload(new FakeAudioContext() as unknown as BaseAudioContext);

    expect(fetchSample).toHaveBeenCalledWith('/samples/c4.ogg');
    expect(pack.select(60, 0.5).buffer.duration).toBe(2);
  });

  it('ships six attack layers plus chromatic releases, three resonance layers, and pedal actions', () => {
    const kinds = SALAMANDER_SAMPLE_ASSETS.reduce<Record<string, number>>((counts, item) => {
      counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      return counts;
    }, {});
    const bundled = createBundledSalamanderPianoSamplePack();

    expect(kinds).toEqual({
      attack: 180,
      release: 88,
      resonance: 69,
      'pedal-down': 2,
      'pedal-up': 2,
    });
    expect(bundled.layers).toHaveLength(SALAMANDER_SAMPLE_ASSETS.length);
    expect(SALAMANDER_SAMPLE_ASSETS.find(item => item.fileName === 'D#4v10.mp3')?.url).toContain('D%234v10.mp3');
  });

  it('serializes concurrent warmups with different working sets', async () => {
    let finishFirst: (() => void) | undefined;
    const firstReady = new Promise<void>(resolve => { finishFirst = resolve; });
    const loadC4 = vi.fn(async () => { await firstReady; return fakeBuffer('c4'); });
    const loadD4 = vi.fn(() => fakeBuffer('d4'));
    const pack = new PianoSamplePack([
      layer('c4', 60, 0.5, loadC4),
      layer('d4', 62, 0.5, loadD4),
    ]);
    const context = new FakeAudioContext();

    const first = pack.preload(context as unknown as BaseAudioContext, [{ midi: 60, velocity: 0.5 }]);
    const second = pack.preload(context as unknown as BaseAudioContext, [{ midi: 62, velocity: 0.5 }]);
    finishFirst?.();
    await Promise.all([first, second]);

    expect(loadC4).toHaveBeenCalledTimes(1);
    expect(loadD4).toHaveBeenCalledTimes(1);
    expect(pack.select(60, 0.5).layer.id).toBe('c4');
    expect(pack.select(62, 0.5).layer.id).toBe('d4');
  });
});

describe('SamplePackPianoEngine', () => {
  it('preloads samples, pitch-shifts from the selected root, pans voices, and releases naturally', async () => {
    const context = new FakeAudioContext();
    const engine = new SamplePackPianoEngine({ samplePack: defaultPack(), releaseSeconds: 0.4 });
    expect(engine.sampleRate).toBe(44_100);
    await engine.init(context as unknown as BaseAudioContext);
    expect(engine.sampleRate).toBe(48_000);

    engine.noteOn('d-flat', 61, 0.8, 5);
    const source = context.sources[0]!;
    const panner = context.panners[0]!;
    const gain = context.gains.find(candidate => candidate.connections.includes(panner));
    expect(gain).toBeDefined();
    expect(source.startCalls).toEqual([{ when: 5, offset: undefined }]);
    expect(source.playbackRate.calls).toContainEqual({ method: 'set', value: samplePlaybackRate(61, 60), when: 5 });
    expect(panner.pan.calls).toContainEqual({ method: 'set', value: pianoStereoPan(61), when: 5 });

    engine.noteOff('d-flat', 5.2);
    const release = gain!.gain.calls.find(call => call.method === 'exponential');
    expect(release).toMatchObject({ method: 'exponential', value: 0.0001 });
    expect(release?.when).toBeCloseTo(5.6, 12);
    expect(source.stopCalls[0]).toBeCloseTo(5.62, 12);
  });

  it('holds a released note under full pedal and uses a longer tail at half pedal', async () => {
    const context = new FakeAudioContext();
    const engine = new SamplePackPianoEngine({
      samplePack: defaultPack(),
      releaseSeconds: 0.4,
      halfPedalReleaseMultiplier: 2,
    });
    await engine.init(context as unknown as BaseAudioContext);

    engine.setPedal(1, 1);
    engine.noteOn('held', 60, 0.6, 1);
    engine.noteOff('held', 2);
    expect(context.sources[0]!.stopCalls).toEqual([]);

    engine.setPedal(0.5, 3);
    expect(context.sources[0]!.stopCalls[0]).toBeCloseTo(3.82, 12);

    engine.noteOn('half-held', 60, 0.6, 4);
    engine.noteOff('half-held', 5);
    expect(context.sources[1]!.stopCalls[0]).toBeCloseTo(5.82, 12);
  });

  it('does not release a duration-defined note before its real key-up while pedaling changes', async () => {
    const context = new FakeAudioContext();
    const engine = new SamplePackPianoEngine({
      samplePack: defaultPack(),
      releaseSeconds: 0.4,
      halfPedalReleaseMultiplier: 2,
    });
    await engine.init(context as unknown as BaseAudioContext);

    engine.setPedal(1, 0);
    engine.noteOn('duration-held', 60, 0.6, 1, 2);
    engine.setPedal(0.5, 2);

    // The physical note-off is at 3, so lowering the pedal at 2 only prepares
    // a release at 3 instead of prematurely damping the note at 2.
    expect(context.sources[0]!.stopCalls[0]).toBeCloseTo(3.82, 12);

    engine.setPedal(0, 3);
    expect(context.sources[0]!.stopCalls).toHaveLength(1);
  });

  it('steals voices deterministically when capacity is exhausted', async () => {
    const context = new FakeAudioContext();
    const engine = new SamplePackPianoEngine({
      samplePack: defaultPack(),
      maxVoices: 2,
      voiceStealReleaseSeconds: 0.01,
    });
    await engine.init(context as unknown as BaseAudioContext);

    engine.noteOn('first', 60, 0.5, 1);
    engine.noteOn('second', 64, 0.5, 1);
    engine.noteOn('third', 67, 0.5, 2);

    expect(context.sources[0]!.stopCalls[0]).toBeCloseTo(2.03, 12);
    expect(context.sources[1]!.stopCalls).toEqual([]);
    expect(engine.activeVoiceCount).toBe(2);
  });

  it('can shorten an existing release for seek/reset and rejects bad notes before stealing', async () => {
    const context = new FakeAudioContext();
    const engine = new SamplePackPianoEngine({
      samplePack: defaultPack(),
      maxVoices: 1,
      releaseSeconds: 0.4,
      voiceStealReleaseSeconds: 0.01,
    });
    await engine.init(context as unknown as BaseAudioContext);

    engine.noteOn('kept', 60, 0.5, 1);
    expect(() => engine.noteOn('invalid', 128, 0.5, 2)).toThrow(RangeError);
    expect(context.sources[0]!.stopCalls).toEqual([]);

    engine.noteOff('kept', 2);
    engine.allNotesOff(2.1);
    expect(context.sources[0]!.stopCalls).toHaveLength(2);
    expect(context.sources[0]!.stopCalls[1]).toBeCloseTo(2.13, 12);
    expect(engine.activeVoiceCount).toBe(0);
  });

  it('anchors a seek during a fade at the faded level instead of jumping back to full gain', async () => {
    // Regression: stopVoiceImmediately used to anchor the shortened tail at
    // the sustain level, snapping a mid-release voice back up — an audible
    // pop whenever playback was seeked or stopped during a fade.
    const context = new FakeAudioContext();
    const engine = new SamplePackPianoEngine({
      samplePack: defaultPack(),
      releaseSeconds: 0.4,
      voiceStealReleaseSeconds: 0.01,
    });
    await engine.init(context as unknown as BaseAudioContext);

    engine.noteOn('fading', 60, 0.5, 1);
    const panner = context.panners[0]!;
    const gain = context.gains.find(candidate => candidate.connections.includes(panner))!;
    engine.noteOff('fading', 2);
    gain.gain.value = 0.08; // The computed curve value partway through the fade.

    engine.allNotesOff(2.05);
    expect(gain.gain.calls).toContainEqual({ method: 'cancel-hold', when: 2.05 });
    // No re-anchor above what the listener is currently hearing.
    for (const call of gain.gain.calls.filter(entry => entry.method === 'set')) {
      expect(call.value ?? 0).toBeLessThanOrEqual(0.081);
    }
    // The natural release tail (2.0 + 0.4) plus the shortened steal tail.
    const tails = gain.gain.calls.filter(call => call.method === 'exponential');
    expect(tails).toHaveLength(2);
    expect(tails[1]!.value).toBe(0.0001);
    expect(tails[1]!.when).toBeCloseTo(2.06, 12);
  });

  it('refuses a requested sample-pack source that has no configured pack', () => {
    expect(() => createPianoEngine({ source: 'sample-pack' })).toThrow(MissingSamplePackError);
  });

  it('routes optional recorded resonance and release layers without consuming note voices', async () => {
    const context = new FakeAudioContext();
    const pack = new PianoSamplePack([
      layer('attack', 60, 0.5),
      { ...layer('release', 60, 0.5), kind: 'release' as const },
      { ...layer('resonance', 60, 0.5), kind: 'resonance' as const },
    ]);
    const engine = new SamplePackPianoEngine({ samplePack: pack, releaseSeconds: 0.1 });
    await engine.init(context as unknown as BaseAudioContext);
    await pack.preloadAuxiliary(context as unknown as BaseAudioContext);

    engine.setPedal(1, 0);
    engine.noteOn('c4', 60, 0.5, 1);
    expect(context.sources).toHaveLength(2);
    expect(engine.activeVoiceCount).toBe(1);

    engine.setPedal(0, 2);
    engine.noteOff('c4', 2);
    expect(context.sources).toHaveLength(3);
    expect(engine.activeVoiceCount).toBe(1);
  });

  it('plays pedal-down and pedal-up actions only on zero crossings', async () => {
    const context = new FakeAudioContext();
    const pack = new PianoSamplePack([
      layer('attack', 60, 0.5),
      { ...layer('pedal-down-soft', 60, 0.35), kind: 'pedal-down' as const },
      { ...layer('pedal-down-hard', 60, 0.8), kind: 'pedal-down' as const },
      { ...layer('pedal-up-soft', 60, 0.35), kind: 'pedal-up' as const },
      { ...layer('pedal-up-hard', 60, 0.8), kind: 'pedal-up' as const },
    ]);
    const engine = new SamplePackPianoEngine({ samplePack: pack, preload: [], preloadPedalActions: true });
    await engine.init(context as unknown as BaseAudioContext);
    await pack.preloadAuxiliary(context as unknown as BaseAudioContext, [], true);

    engine.setPedal(1, 1);
    engine.setPedal(0.5, 2);
    engine.setPedal(0, 3);

    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]?.buffer).toEqual(fakeBuffer('pedal-down-hard'));
    expect(context.sources[0]?.startCalls).toEqual([{ when: 1, offset: undefined }]);
    expect(context.sources[1]?.buffer).toEqual(fakeBuffer('pedal-up-soft'));
    expect(context.sources[1]?.startCalls).toEqual([{ when: 3, offset: undefined }]);
  });
});

describe('GeneratedPianoEngine duration handling', () => {
  it('keeps a duration-defined key down until its scheduled note-off across a pedal change', async () => {
    const context = new FakeAudioContext();
    const engine = new GeneratedPianoEngine({ releaseSeconds: 0.4 });
    await engine.init(context as unknown as BaseAudioContext);

    engine.setPedal(1, 0);
    engine.noteOn('generated-duration', 60, 0.6, 1, 2);
    engine.setPedal(0.5, 2);

    expect(context.sources[0]!.stopCalls[0]).toBeCloseTo(3.82, 12);

    engine.setPedal(0, 3);
    expect(context.sources[0]!.stopCalls).toHaveLength(1);
  });

  it('pins the gain curve at the scheduled note-off instead of a stale current value', async () => {
    // Regression: scheduling a duration release used to anchor the future
    // ramp with setValueAtTime(param.value) read before the note even
    // sounded — a stale anchor that could snap the envelope mid-note.
    const context = new FakeAudioContext();
    const engine = new GeneratedPianoEngine({ releaseSeconds: 0.4 });
    await engine.init(context as unknown as BaseAudioContext);

    engine.noteOn('pinned', 60, 0.6, 5, 2);
    const gain = context.gains[context.gains.length - 1]!;
    const releaseStart = gain.gain.calls.find(call => call.when === 7);
    expect(releaseStart).toMatchObject({ method: 'cancel-hold', when: 7 });
    expect(gain.gain.calls.filter(call => call.method === 'set' && call.when === 7)).toEqual([]);
    expect(gain.gain.calls).toContainEqual({ method: 'linear', value: 0.0001, when: 7.4 });
  });

  it('loops the bounded generated buffer until a long note is actually released', async () => {
    const context = new FakeAudioContext();
    const engine = new GeneratedPianoEngine({ releaseSeconds: 0.4 });
    await engine.init(context as unknown as BaseAudioContext);

    engine.noteOn('long-generated', 48, 0.7, 1);
    const source = context.sources[0]!;
    expect(source.buffer?.duration).toBe(3);
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBeGreaterThan(0);
    expect(source.loopEnd).toBeLessThanOrEqual(source.buffer!.duration);
    expect(source.stopCalls).toEqual([]);

    engine.noteOff('long-generated', 9);
    expect(source.stopCalls[0]).toBeCloseTo(9.42, 12);
  });

  it('folds a long seek offset into the sustain loop without replaying the attack', async () => {
    const context = new FakeAudioContext();
    const engine = new GeneratedPianoEngine();
    await engine.init(context as unknown as BaseAudioContext);

    engine.restoreNote({
      id: 'restored-generated',
      midi: 60,
      velocity: 0.7,
      when: 20,
      offsetSeconds: 18,
      keyDown: true,
    });

    const source = context.sources[0]!;
    expect(source.startCalls).toHaveLength(1);
    expect(source.startCalls[0]!.when).toBe(20);
    expect(source.startCalls[0]!.offset).toBeGreaterThanOrEqual(source.loopStart);
    expect(source.startCalls[0]!.offset).toBeLessThan(source.loopEnd);
  });
});
