/**
 * Sample-pack data and deterministic sample selection.
 *
 * A pack deliberately receives loaders rather than URLs or fetch functions so
 * it remains usable in browser, worker, and unit-test environments without
 * bundling a specific asset transport.
 */

/** Sample roles can be mixed in one manifest without confusing attack selection. */
export type PianoSampleLayerKind = 'attack' | 'release' | 'resonance' | 'pedal-down' | 'pedal-up';

/** One recorded piano sample, captured at a root key and velocity layer. */
export interface PianoSampleLayer {
  /** Stable identifier used for deterministic tie-breaking and preload cache keys. */
  readonly id: string;
  /** MIDI note at which the recording plays at its native pitch. */
  readonly rootMidi: number;
  /** Normalized recording velocity from 0 through 1. */
  readonly velocity: number;
  /** Attack is the default and the only role used for ordinary note-on voices. */
  readonly kind?: PianoSampleLayerKind;
  /** Decode or otherwise provide the sample buffer for this layer. */
  readonly load: (context: BaseAudioContext) => Promise<AudioBuffer> | AudioBuffer;
}

/** A selected, preloaded layer ready to schedule through an AudioBufferSourceNode. */
export interface LoadedSampleSelection {
  readonly layer: PianoSampleLayer;
  readonly buffer: AudioBuffer;
  /** Playback-rate correction from the root recording to the requested MIDI note. */
  readonly playbackRate: number;
}

/** A MIDI/velocity pair that must be warmed before deterministic playback. */
export interface PianoSamplePreloadRequest {
  readonly midi: number;
  readonly velocity: number;
}

export interface PianoSamplePackOptions {
  /**
   * Optional decoded-buffer LRU cap. Leave undefined for a complete resident
   * pack. When set, callers must preload the score's needed samples before
   * playback and keep the cap large enough for that working set.
   */
  readonly maxCachedLayers?: number;
}

/** Thrown when a sample-pack engine is selected without an actual pack. */
export class MissingSamplePackError extends Error {
  constructor() {
    super('A sample-pack piano engine requires a sample pack');
    this.name = 'MissingSamplePackError';
  }
}

/** Thrown when playback begins before a pack was successfully preloaded. */
export class SamplePackNotReadyError extends Error {
  constructor() {
    super('The piano sample pack has not been preloaded');
    this.name = 'SamplePackNotReadyError';
  }
}

/** Wraps an individual sample loader failure with the layer that failed. */
export class SamplePackPreloadError extends Error {
  readonly layerId: string;

  constructor(layerId: string, cause: unknown) {
    super(`Failed to preload piano sample layer ${JSON.stringify(layerId)}`);
    this.name = 'SamplePackPreloadError';
    this.layerId = layerId;
    this.cause = cause;
  }
}

function assertLayer(layer: PianoSampleLayer): void {
  if (typeof layer.id !== 'string' || layer.id.length === 0) {
    throw new TypeError('Piano sample layers require a non-empty id');
  }
  if (!Number.isInteger(layer.rootMidi) || layer.rootMidi < 0 || layer.rootMidi > 127) {
    throw new RangeError(`Invalid piano sample root MIDI ${String(layer.rootMidi)}`);
  }
  if (!Number.isFinite(layer.velocity) || layer.velocity < 0 || layer.velocity > 1) {
    throw new RangeError(`Invalid piano sample velocity for layer ${JSON.stringify(layer.id)}`);
  }
  if (layer.kind !== undefined
    && layer.kind !== 'attack'
    && layer.kind !== 'release'
    && layer.kind !== 'resonance'
    && layer.kind !== 'pedal-down'
    && layer.kind !== 'pedal-up') {
    throw new RangeError(`Invalid piano sample layer kind ${JSON.stringify(layer.kind)}`);
  }
  if (typeof layer.load !== 'function') {
    throw new TypeError(`Piano sample layer ${JSON.stringify(layer.id)} requires a loader`);
  }
}

function normalizeVelocity(velocity: number): number {
  if (!Number.isFinite(velocity)) {
    throw new RangeError(`Invalid requested velocity ${String(velocity)}`);
  }
  return Math.min(1, Math.max(0, velocity));
}

function assertMidi(midi: number): void {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`Invalid requested MIDI ${String(midi)}`);
  }
}

/** Select the closest recorded velocity, breaking exact ties toward the softer layer. */
export function selectVelocityLayer(layers: readonly PianoSampleLayer[], velocity: number): PianoSampleLayer {
  if (layers.length === 0) {
    throw new RangeError('Cannot select a velocity layer from an empty sample pack');
  }
  const requested = normalizeVelocity(velocity);
  return [...layers].sort((left, right) => {
    const distance = Math.abs(left.velocity - requested) - Math.abs(right.velocity - requested);
    if (distance !== 0) return distance;
    const velocityOrder = left.velocity - right.velocity;
    if (velocityOrder !== 0) return velocityOrder;
    return left.id.localeCompare(right.id);
  })[0]!;
}

/**
 * Select the nearest root key first, then a velocity layer at that root.
 *
 * Pitch accuracy wins over velocity accuracy: selecting a distant root merely
 * because it has a closer velocity layer produces noticeably worse timbre.
 * Root-key ties choose the lower note, then `selectVelocityLayer` handles the
 * stable velocity/id ordering.
 */
export function selectSampleLayer(
  layers: readonly PianoSampleLayer[],
  midi: number,
  velocity: number,
): PianoSampleLayer {
  if (layers.length === 0) {
    throw new RangeError('Cannot select a sample layer from an empty sample pack');
  }
  assertMidi(midi);
  const nearestRoot = [...new Set(layers.map(layer => layer.rootMidi))]
    .sort((left, right) => Math.abs(left - midi) - Math.abs(right - midi) || left - right)[0]!;
  return selectVelocityLayer(layers.filter(layer => layer.rootMidi === nearestRoot), velocity);
}

/** Ratio that pitch-shifts a root recording to the requested MIDI note. */
export function samplePlaybackRate(midi: number, rootMidi: number): number {
  assertMidi(midi);
  assertMidi(rootMidi);
  return Math.pow(2, (midi - rootMidi) / 12);
}

/** Map the 88-key piano range onto a symmetric stereo field. */
export function pianoStereoPan(midi: number, spread = 0.8): number {
  assertMidi(midi);
  if (!Number.isFinite(spread) || spread < 0 || spread > 1) {
    throw new RangeError(`Invalid stereo spread ${String(spread)}`);
  }
  const normalized = (midi - 21) / (108 - 21);
  return Math.min(1, Math.max(-1, (normalized * 2 - 1) * spread));
}

/**
 * Immutable layer catalog plus an explicit preload cache.
 *
 * Preloading is all-or-nothing: a failed layer leaves the previous successful
 * cache untouched and reports its layer id. Playback therefore never quietly
 * swaps to generated audio when an advertised sample pack is unavailable.
 */
export class PianoSamplePack {
  readonly layers: readonly PianoSampleLayer[];
  readonly maxCachedLayers: number | undefined;

  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | undefined;
  private ready = false;

  constructor(layers: readonly PianoSampleLayer[], options: PianoSamplePackOptions = {}) {
    if (layers.length === 0) {
      throw new RangeError('A piano sample pack requires at least one layer');
    }
    const ids = new Set<string>();
    for (const layer of layers) {
      assertLayer(layer);
      if (ids.has(layer.id)) {
        throw new RangeError(`Duplicate piano sample layer id ${JSON.stringify(layer.id)}`);
      }
      ids.add(layer.id);
    }
    this.layers = Object.freeze([...layers]);
    if (options.maxCachedLayers !== undefined
      && (!Number.isInteger(options.maxCachedLayers) || options.maxCachedLayers < 1)) {
      throw new RangeError('maxCachedLayers must be a positive integer when provided');
    }
    this.maxCachedLayers = options.maxCachedLayers;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Load either the complete pack or the exact attack/release/resonance layers
   * required by a score. Concurrent callers share a single transaction so a
   * half-decoded pack is never exposed to playback.
   */
  async preload(
    context: BaseAudioContext,
    requests?: readonly PianoSamplePreloadRequest[],
    includePedalActions = false,
  ): Promise<void> {
    await this.preloadLayers(context, this.preloadTargets(requests, includePedalActions));
  }

  /** Load the attack samples required to produce the first audible notes. */
  async preloadAttacks(
    context: BaseAudioContext,
    requests?: readonly PianoSamplePreloadRequest[],
  ): Promise<void> {
    await this.preloadLayers(context, this.preloadTargets(requests, false, ['attack']));
  }

  /** Warm optional release, resonance, and pedal recordings after playback is ready. */
  async preloadAuxiliary(
    context: BaseAudioContext,
    requests?: readonly PianoSamplePreloadRequest[],
    includePedalActions = false,
  ): Promise<void> {
    await this.preloadLayers(
      context,
      this.preloadTargets(requests, includePedalActions, ['release', 'resonance']),
    );
  }

  private async preloadLayers(
    context: BaseAudioContext,
    targets: readonly PianoSampleLayer[],
  ): Promise<void> {
    if (targets.every(layer => this.buffers.has(layer.id))) {
      this.ready = this.buffers.size > 0;
      return;
    }
    if (this.loading !== undefined) {
      await this.loading;
      if (targets.every(layer => this.buffers.has(layer.id))) return;
      return this.preloadLayers(context, targets);
    }

    const pending = Promise.all(targets.map(async (layer) => {
      try {
        const buffer = await layer.load(context);
        if (buffer === null || buffer === undefined) {
          throw new TypeError('sample loader returned no AudioBuffer');
        }
        return [layer.id, buffer] as const;
      } catch (error) {
        throw new SamplePackPreloadError(layer.id, error);
      }
    })).then((entries) => {
      const next = new Map(this.buffers);
      for (const [id, buffer] of entries) {
        next.delete(id);
        next.set(id, buffer);
      }
      this.trimCache(next);
      this.buffers = next;
      this.ready = true;
    });

    this.loading = pending;
    try {
      await pending;
    } finally {
      if (this.loading === pending) {
        this.loading = undefined;
      }
    }
  }

  /** Resolve a requested MIDI note/velocity to a preloaded sample and pitch shift. */
  select(midi: number, velocity: number): LoadedSampleSelection {
    return this.selectKind('attack', midi, velocity, false)!;
  }

  /** Optional natural-release sample selection. Absent release layers are valid. */
  selectRelease(midi: number, velocity: number): LoadedSampleSelection | undefined {
    return this.selectKind('release', midi, velocity, true);
  }

  /** Optional sympathetic/soundboard resonance selection. */
  selectResonance(midi: number, velocity: number): LoadedSampleSelection | undefined {
    return this.selectKind('resonance', midi, velocity, true);
  }

  /** Optional recorded pedal-down action selected by pedal depth. */
  selectPedalDown(velocity: number): LoadedSampleSelection | undefined {
    return this.selectKind('pedal-down', 60, velocity, true);
  }

  /** Optional recorded pedal-up action selected by the prior pedal depth. */
  selectPedalUp(velocity: number): LoadedSampleSelection | undefined {
    return this.selectKind('pedal-up', 60, velocity, true);
  }

  /** Stable inspection hook for diagnostics and cache-pressure tests. */
  get cachedLayerIds(): readonly string[] {
    return [...this.buffers.keys()];
  }

  private preloadTargets(
    requests: readonly PianoSamplePreloadRequest[] | undefined,
    includePedalActions: boolean,
    kinds: readonly Extract<PianoSampleLayerKind, 'attack' | 'release' | 'resonance'>[] = ['attack', 'release', 'resonance'],
  ): readonly PianoSampleLayer[] {
    if (requests === undefined) {
      if (kinds.length === 3) return this.layers;
      return this.layers.filter((layer) => {
        const kind = layer.kind ?? 'attack';
        if (kind === 'pedal-down' || kind === 'pedal-up') return includePedalActions;
        return kinds.includes(kind);
      });
    }
    const selected = new Map<string, PianoSampleLayer>();
    for (const request of requests) {
      assertMidi(request.midi);
      normalizeVelocity(request.velocity);
      for (const kind of kinds) {
        const layers = this.layersFor(kind);
        if (layers.length === 0) continue;
        const layer = selectSampleLayer(layers, request.midi, request.velocity);
        selected.set(layer.id, layer);
      }
    }
    if (includePedalActions) {
      for (const kind of ['pedal-down', 'pedal-up'] as const) {
        for (const layer of this.layersFor(kind)) selected.set(layer.id, layer);
      }
    }
    return [...selected.values()];
  }

  private layersFor(kind: PianoSampleLayerKind): readonly PianoSampleLayer[] {
    return this.layers.filter(layer => (layer.kind ?? 'attack') === kind);
  }

  private selectKind(
    kind: PianoSampleLayerKind,
    midi: number,
    velocity: number,
    optional: boolean,
  ): LoadedSampleSelection | undefined {
    if (!this.ready) throw new SamplePackNotReadyError();
    const layers = this.layersFor(kind);
    if (layers.length === 0) {
      if (optional) return undefined;
      throw new SamplePackNotReadyError();
    }
    const layer = selectSampleLayer(layers, midi, velocity);
    const buffer = this.buffers.get(layer.id);
    if (buffer === undefined) {
      if (optional) return undefined;
      throw new SamplePackNotReadyError();
    }
    // Refresh LRU order only after a valid lookup, preserving deterministic
    // cache eviction for an equal stream of score events.
    this.buffers.delete(layer.id);
    this.buffers.set(layer.id, buffer);
    return { layer, buffer, playbackRate: samplePlaybackRate(midi, layer.rootMidi) };
  }

  private trimCache(buffers: Map<string, AudioBuffer>): void {
    if (this.maxCachedLayers === undefined) return;
    while (buffers.size > this.maxCachedLayers) {
      const oldest = buffers.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      buffers.delete(oldest);
    }
  }
}
