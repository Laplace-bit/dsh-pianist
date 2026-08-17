import {
  MissingSamplePackError,
  PianoSamplePack,
  pianoStereoPan,
  type LoadedSampleSelection,
  type PianoSamplePreloadRequest,
} from './sample-pack.js';
import type { PianoEngine, PianoEngineOptions, RestoredPianoNote } from './types.js';

/** Options specific to the multi-layer sample-pack implementation. */
export interface SamplePackPianoEngineOptions extends PianoEngineOptions {
  /** Required, explicitly preloaded source of recorded piano samples. */
  samplePack: PianoSamplePack;
  /** Maximum concurrently sounding sources before deterministic stealing starts. */
  maxVoices?: number;
  /** Stereo spread across the physical piano keyboard, from 0 through 1. */
  stereoSpread?: number;
  /** Short fade-in that prevents clicks at sample start. */
  attackSeconds?: number;
  /** Extra release multiplier at partial sustain-pedal positions. */
  halfPedalReleaseMultiplier?: number;
  /** Short fade used to steal a voice without a hard discontinuity. */
  voiceStealReleaseSeconds?: number;
  /** Exact score samples to warm before playback; omitted means the full pack. */
  preload?: readonly PianoSamplePreloadRequest[];
  /** Warm and play the global pedal-action recordings for scores that use sustain. */
  preloadPedalActions?: boolean;
  /** Relative gain for optional recorded sympathetic/soundboard layers. */
  resonanceGain?: number;
  /** Relative gain for recorded release layers. */
  releaseLayerGain?: number;
  /** Relative gain for the pedal/room return bus. */
  roomGain?: number;
}

interface ActiveSampleVoice {
  readonly id: string;
  readonly sequence: number;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  readonly level: number;
  readonly midi: number;
  readonly velocity: number;
  readonly startedAt: number;
  /** Natural end of the unlooped source, used to replace a canceled future stop. */
  readonly naturalStopAt: number;
  keyDown: boolean;
  releaseScheduled: boolean;
  /** A duration overload scheduled a future physical key release. */
  durationNoteOffAt: number | undefined;
  /** The release automation is provisional until durationNoteOffAt is reached. */
  pendingDurationRelease: boolean;
  releaseLayerStarted: boolean;
}

interface NormalizedOptions {
  readonly samplePack: PianoSamplePack;
  readonly releaseSeconds: number;
  readonly gain: number;
  readonly analyser: AnalyserNode | undefined;
  readonly sampleRate: number;
  readonly maxVoices: number;
  readonly stereoSpread: number;
  readonly attackSeconds: number;
  readonly halfPedalReleaseMultiplier: number;
  readonly voiceStealReleaseSeconds: number;
  readonly preload: readonly PianoSamplePreloadRequest[] | undefined;
  readonly preloadPedalActions: boolean;
  readonly resonanceGain: number;
  readonly releaseLayerGain: number;
  readonly roomGain: number;
}

const FULL_PEDAL_THRESHOLD = 0.95;
const STOP_TAIL_SECONDS = 0.02;
const SILENCE = 0.0001;

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${String(min)} and ${String(max)}`);
  }
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeOptions(options: SamplePackPianoEngineOptions): NormalizedOptions {
  if (options.samplePack === undefined) {
    throw new MissingSamplePackError();
  }
  return {
    samplePack: options.samplePack,
    releaseSeconds: nonNegative(options.releaseSeconds ?? 0.35, 'releaseSeconds'),
    gain: bounded(options.gain ?? 0.8, 0, 1, 'gain'),
    analyser: options.analyser,
    sampleRate: positiveInteger(options.sampleRate ?? 44100, 'sampleRate'),
    maxVoices: positiveInteger(options.maxVoices ?? 64, 'maxVoices'),
    stereoSpread: bounded(options.stereoSpread ?? 0.8, 0, 1, 'stereoSpread'),
    attackSeconds: nonNegative(options.attackSeconds ?? 0.004, 'attackSeconds'),
    halfPedalReleaseMultiplier: nonNegative(
      options.halfPedalReleaseMultiplier ?? 2,
      'halfPedalReleaseMultiplier',
    ),
    voiceStealReleaseSeconds: nonNegative(options.voiceStealReleaseSeconds ?? 0.008, 'voiceStealReleaseSeconds'),
    preload: options.preload === undefined ? undefined : Object.freeze(options.preload.map(request => ({ ...request }))),
    preloadPedalActions: options.preloadPedalActions ?? false,
    resonanceGain: bounded(options.resonanceGain ?? 0.16, 0, 1, 'resonanceGain'),
    releaseLayerGain: bounded(options.releaseLayerGain ?? 0.22, 0, 1, 'releaseLayerGain'),
    roomGain: bounded(options.roomGain ?? 0.12, 0, 1, 'roomGain'),
  };
}

/**
 * Recorded-sample piano implementation.
 *
 * Sample selection is deterministic (nearest root, then nearest velocity
 * layer). A full sustain pedal holds released keys, a partial pedal starts a
 * longer damping release, and saturated voice capacity steals the oldest
 * released voice before the oldest held voice.
 */
export class SamplePackPianoEngine implements PianoEngine {
  readonly options: Readonly<NormalizedOptions>;

  private context: BaseAudioContext | null = null;
  private masterGain: GainNode | null = null;
  private resonanceBus: GainNode | null = null;
  private releaseBus: GainNode | null = null;
  private roomBus: GainNode | null = null;
  private readonly auxiliarySources = new Set<AudioBufferSourceNode>();
  private readonly activeVoices = new Map<string, ActiveSampleVoice>();
  private sequence = 0;
  private pedal = 0;

  constructor(options: SamplePackPianoEngineOptions) {
    this.options = normalizeOptions(options);
  }

  /** Use the actual device rate after initialization; never force 44.1 kHz. */
  get sampleRate(): number {
    return this.context?.sampleRate ?? this.options.sampleRate;
  }

  /** Number of physical sources still allocated, including scheduled releases. */
  get activeVoiceCount(): number {
    return this.activeVoices.size;
  }

  /** Preload score-relevant attacks and initialize the stable audio graph. */
  async init(context: BaseAudioContext): Promise<void> {
    await this.options.samplePack.preloadAttacks(context, this.options.preload);
    this.context = context;
    this.masterGain = context.createGain();
    this.masterGain.gain.value = this.options.gain;
    this.resonanceBus = context.createGain();
    this.resonanceBus.gain.value = this.options.resonanceGain;
    this.releaseBus = context.createGain();
    this.releaseBus.gain.value = this.options.releaseLayerGain;
    this.roomBus = context.createGain();
    this.roomBus.gain.value = this.options.roomGain;
    this.resonanceBus.connect(this.roomBus);
    this.releaseBus.connect(this.roomBus);
    this.roomBus.connect(this.masterGain);
    if (this.options.analyser !== undefined) {
      this.masterGain.connect(this.options.analyser);
      this.options.analyser.connect(context.destination);
    } else {
      this.masterGain.connect(context.destination);
    }
    // Release, resonance, and pedal recordings enrich the sound but are not
    // required for the first note. Missing layers are skipped until this
    // background warmup completes.
    void this.options.samplePack.preloadAuxiliary(
      context,
      this.options.preload,
      this.options.preloadPedalActions,
    ).catch(() => undefined);
  }

  noteOn(id: string, midi: number, velocity: number, when: number, duration?: number): void {
    const context = this.requireContext();
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('Sample piano voices require a non-empty note id');
    }
    if (!Number.isFinite(when)) {
      throw new RangeError(`Invalid note start time ${String(when)}`);
    }
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
      throw new RangeError(`Invalid note duration ${String(duration)}`);
    }

    // Validate selection before stealing or replacing an existing voice. A bad
    // scheduler event must never affect a note that was already sounding.
    const normalizedVelocity = bounded(velocity, 0, 1, 'velocity');
    const selected = this.options.samplePack.select(midi, normalizedVelocity);
    this.advanceDurationNoteOffs(when);

    const existing = this.activeVoices.get(id);
    if (existing !== undefined) {
      this.stopVoiceImmediately(existing, when);
      this.activeVoices.delete(id);
    }
    this.ensureVoiceCapacity(when);

    const source = context.createBufferSource();
    source.buffer = selected.buffer;
    source.playbackRate.setValueAtTime(selected.playbackRate, when);

    const gain = context.createGain();
    const level = 0.12 + normalizedVelocity * 0.88;
    gain.gain.setValueAtTime(SILENCE, when);
    gain.gain.linearRampToValueAtTime(level, when + this.options.attackSeconds);

    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(pianoStereoPan(midi, this.options.stereoSpread), when);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.masterGain ?? context.destination);

    const voice: ActiveSampleVoice = {
      id,
      sequence: this.sequence,
      source,
      gain,
      panner,
      level,
      midi,
      velocity: normalizedVelocity,
      startedAt: when,
      naturalStopAt: when + selected.buffer.duration / selected.playbackRate,
      keyDown: true,
      releaseScheduled: false,
      durationNoteOffAt: undefined,
      pendingDurationRelease: false,
      releaseLayerStarted: false,
    };
    this.sequence += 1;
    source.onended = () => {
      if (this.activeVoices.get(id) === voice) {
        this.activeVoices.delete(id);
      }
      this.disconnectVoice(voice);
    };
    this.activeVoices.set(id, voice);
    source.start(when);
    this.startSympatheticResonance(midi, normalizedVelocity, when);

    if (duration !== undefined) {
      // Keep the key physically down until its scheduled note-off. Pedal changes
      // before that point can therefore update the future release correctly.
      voice.durationNoteOffAt = when + duration;
      this.scheduleDurationRelease(voice, when);
    }
  }

  noteOff(id: string, when: number): void {
    if (!Number.isFinite(when)) {
      throw new RangeError(`Invalid note release time ${String(when)}`);
    }
    this.advanceDurationNoteOffs(when);
    const voice = this.activeVoices.get(id);
    if (voice === undefined) {
      return;
    }
    this.cancelPendingDurationRelease(voice, when);
    if (voice.releaseScheduled) {
      return;
    }
    voice.durationNoteOffAt = undefined;
    voice.keyDown = false;
    this.releaseForPedal(voice, when);
  }

  /** Resume an already-sounding sample after a seek without replaying attack. */
  restoreNote(note: RestoredPianoNote): void {
    const context = this.requireContext();
    if (typeof note.id !== 'string' || note.id.length === 0) {
      throw new TypeError('Restored sample piano voices require a non-empty note id');
    }
    if (!Number.isFinite(note.when) || !Number.isFinite(note.offsetSeconds) || note.offsetSeconds < 0) {
      throw new RangeError('Restored sample piano voice timing must be finite and non-negative');
    }
    const velocity = bounded(note.velocity, 0, 1, 'velocity');
    const selected = this.options.samplePack.select(note.midi, velocity);
    if (note.offsetSeconds >= selected.buffer.duration) {
      return;
    }
    this.advanceDurationNoteOffs(note.when);

    const existing = this.activeVoices.get(note.id);
    if (existing !== undefined) {
      this.stopVoiceImmediately(existing, note.when);
      this.activeVoices.delete(note.id);
    }
    this.ensureVoiceCapacity(note.when);

    const source = context.createBufferSource();
    source.buffer = selected.buffer;
    source.playbackRate.setValueAtTime(selected.playbackRate, note.when);
    const gain = context.createGain();
    const level = 0.12 + velocity * 0.88;
    gain.gain.setValueAtTime(level, note.when);
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(pianoStereoPan(note.midi, this.options.stereoSpread), note.when);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.masterGain ?? context.destination);

    const voice: ActiveSampleVoice = {
      id: note.id,
      sequence: this.sequence,
      source,
      gain,
      panner,
      level,
      midi: note.midi,
      velocity,
      startedAt: note.when - note.offsetSeconds,
      naturalStopAt: note.when + (selected.buffer.duration - note.offsetSeconds) / selected.playbackRate,
      keyDown: note.keyDown,
      releaseScheduled: false,
      durationNoteOffAt: undefined,
      pendingDurationRelease: false,
      releaseLayerStarted: false,
    };
    this.sequence += 1;
    source.onended = () => {
      if (this.activeVoices.get(note.id) === voice) {
        this.activeVoices.delete(note.id);
      }
      this.disconnectVoice(voice);
    };
    this.activeVoices.set(note.id, voice);
    source.start(note.when, note.offsetSeconds);
  }

  setGain(gain: number, when = this.context?.currentTime ?? 0): void {
    const next = bounded(gain, 0, 1, 'gain');
    this.masterGain?.gain.setTargetAtTime(next, when, 0.015);
  }

  /**
   * Sustain pedal value from 0 through 1. Full pedal holds released notes;
   * partial pedal starts a longer damped release, and lifting fully releases
   * every note that was waiting behind the pedal.
   */
  setPedal(value: number, when: number): void {
    if (!Number.isFinite(when)) {
      throw new RangeError(`Invalid pedal time ${String(when)}`);
    }
    const next = bounded(value, 0, 1, 'pedal value');
    // The prior pedal state governs duration note-offs at this exact time,
    // matching noteOff-before-pedal event ordering in the performance timeline.
    this.advanceDurationNoteOffs(when);
    const previous = this.pedal;
    this.pedal = next;
    if (previous === 0 && next > 0) {
      this.startPedalAction('down', next, when);
    } else if (previous > 0 && next === 0) {
      this.startPedalAction('up', previous, when);
    }
    this.roomBus?.gain.setValueAtTime(this.options.roomGain * (0.35 + next * 0.65), when);
    for (const voice of this.activeVoices.values()) {
      if (voice.durationNoteOffAt !== undefined && voice.durationNoteOffAt > when) {
        this.scheduleDurationRelease(voice, when);
      }
    }
    if (next >= previous) {
      return;
    }
    for (const voice of this.activeVoices.values()) {
      if (voice.keyDown || voice.releaseScheduled) {
        continue;
      }
      this.releaseForPedal(voice, when);
    }
  }

  /** Stop all sources promptly; scheduled calls use a short anti-click release. */
  allNotesOff(when?: number): void {
    const stopAt = when ?? this.context?.currentTime ?? 0;
    for (const voice of [...this.activeVoices.values()]) {
      this.stopVoiceImmediately(voice, stopAt);
      this.activeVoices.delete(voice.id);
    }
    this.stopAuxiliarySources(stopAt);
  }

  dispose(): void {
    this.allNotesOff();
    try {
      this.masterGain?.disconnect();
    } catch {
      // An already-disconnected graph has nothing left to clean up.
    }
    this.masterGain = null;
    for (const bus of [this.resonanceBus, this.releaseBus, this.roomBus]) {
      try {
        bus?.disconnect();
      } catch {
        // Nodes can already have been detached by a browser context shutdown.
      }
    }
    this.resonanceBus = null;
    this.releaseBus = null;
    this.roomBus = null;
    this.context = null;
  }

  private requireContext(): BaseAudioContext {
    if (this.context === null || this.masterGain === null) {
      throw new Error('SamplePackPianoEngine.init() must preload the sample pack before playback');
    }
    return this.context;
  }

  private ensureVoiceCapacity(when: number): void {
    while (this.activeVoices.size >= this.options.maxVoices) {
      const candidate = [...this.activeVoices.values()]
        .sort((left, right) => {
          // Prefer voices whose key has been released, then oldest source,
          // then insertion order/id so stealing is reproducible.
          const keyState = Number(left.keyDown) - Number(right.keyDown);
          if (keyState !== 0) return keyState;
          const startOrder = left.startedAt - right.startedAt;
          if (startOrder !== 0) return startOrder;
          const sequenceOrder = left.sequence - right.sequence;
          if (sequenceOrder !== 0) return sequenceOrder;
          return left.id.localeCompare(right.id);
        })[0];
      if (candidate === undefined) {
        return;
      }
      this.stopVoiceImmediately(candidate, when);
      this.activeVoices.delete(candidate.id);
    }
  }

  private releaseForPedal(voice: ActiveSampleVoice, when: number): void {
    if (voice.releaseScheduled) {
      return;
    }
    if (this.pedal >= FULL_PEDAL_THRESHOLD) {
      return;
    }
    const release = this.releaseSecondsForPedal();
    this.releaseVoice(voice, when, release);
  }

  private releaseSecondsForPedal(): number {
    return this.pedal === 0
      ? this.options.releaseSeconds
      : this.options.releaseSeconds * (1 + this.pedal * this.options.halfPedalReleaseMultiplier);
  }

  private scheduleDurationRelease(voice: ActiveSampleVoice, when: number): void {
    const noteOffAt = voice.durationNoteOffAt;
    if (noteOffAt === undefined || noteOffAt <= when) {
      return;
    }
    this.cancelPendingDurationRelease(voice, when);
    if (this.pedal >= FULL_PEDAL_THRESHOLD) {
      return;
    }
    this.releaseVoice(voice, noteOffAt, this.releaseSecondsForPedal(), true);
  }

  private advanceDurationNoteOffs(when: number): void {
    for (const voice of this.activeVoices.values()) {
      const noteOffAt = voice.durationNoteOffAt;
      if (noteOffAt === undefined || noteOffAt > when) {
        continue;
      }
      voice.durationNoteOffAt = undefined;
      voice.keyDown = false;
      if (voice.pendingDurationRelease) {
        // The release was already scheduled using the pedal state in effect at
        // the note-off time. It is no longer cancelable as a future action.
        voice.pendingDurationRelease = false;
        this.startReleaseLayer(voice, noteOffAt);
      } else {
        this.releaseForPedal(voice, noteOffAt);
      }
    }
  }

  private cancelPendingDurationRelease(voice: ActiveSampleVoice, when: number): void {
    if (!voice.pendingDurationRelease) {
      return;
    }
    voice.gain.gain.cancelScheduledValues(when);
    voice.gain.gain.setValueAtTime(Math.max(SILENCE, voice.level), when);
    try {
      // A later stop replaces the provisional release stop in Web Audio. The
      // source will then naturally end unless a later real note-off releases it.
      voice.source.stop(voice.naturalStopAt);
    } catch {
      // The source may already have ended in an unusually short recording.
    }
    voice.releaseScheduled = false;
    voice.pendingDurationRelease = false;
  }

  private releaseVoice(
    voice: ActiveSampleVoice,
    when: number,
    releaseSeconds: number,
    pendingDurationRelease = false,
    includeReleaseLayer = true,
  ): void {
    if (voice.releaseScheduled) {
      return;
    }
    voice.releaseScheduled = true;
    voice.pendingDurationRelease = pendingDurationRelease;
    if (includeReleaseLayer && !pendingDurationRelease) {
      this.startReleaseLayer(voice, when);
    }
    voice.gain.gain.cancelScheduledValues(when);
    voice.gain.gain.setValueAtTime(Math.max(SILENCE, voice.level), when);
    const end = when + Math.max(releaseSeconds, 0.001);
    voice.gain.gain.exponentialRampToValueAtTime(SILENCE, end);
    try {
      voice.source.stop(end + STOP_TAIL_SECONDS);
    } catch {
      // AudioBufferSourceNode rejects a second stop call; the voice is already ending.
    }
  }

  private stopVoiceImmediately(voice: ActiveSampleVoice, when: number): void {
    if (!voice.releaseScheduled) {
      this.releaseVoice(voice, when, this.options.voiceStealReleaseSeconds, false, false);
      return;
    }
    // A seek or voice steal must shorten an already-planned natural tail;
    // otherwise old samples continue sounding after they left the voice map.
    voice.gain.gain.cancelScheduledValues(when);
    voice.gain.gain.setValueAtTime(Math.max(SILENCE, voice.level), when);
    const end = when + Math.max(this.options.voiceStealReleaseSeconds, 0.001);
    voice.gain.gain.exponentialRampToValueAtTime(SILENCE, end);
    try {
      voice.source.stop(end + STOP_TAIL_SECONDS);
    } catch {
      // A source that already ended does not need another stop request.
    }
  }

  private disconnectVoice(voice: ActiveSampleVoice): void {
    try {
      voice.source.disconnect();
      voice.gain.disconnect();
      voice.panner.disconnect();
    } catch {
      // Cleanup is best-effort after a browser has already reclaimed a node.
    }
  }

  /** Start a short recorded release only after the physical key really releases. */
  private startReleaseLayer(voice: ActiveSampleVoice, when: number): void {
    if (voice.releaseLayerStarted) return;
    const selected = this.options.samplePack.selectRelease(voice.midi, voice.velocity);
    if (selected === undefined) return;
    voice.releaseLayerStarted = true;
    this.startAuxiliaryLayer(selected, voice.midi, when, this.releaseBus, voice.level);
  }

  /** Pedal-held notes may excite optional recorded sympathetic/soundboard layers. */
  private startSympatheticResonance(midi: number, velocity: number, when: number): void {
    if (this.pedal <= 0) return;
    const selected = this.options.samplePack.selectResonance(midi, velocity);
    if (selected === undefined) return;
    this.startAuxiliaryLayer(selected, midi, when, this.resonanceBus, 0.1 + velocity * 0.2);
  }

  private startPedalAction(action: 'down' | 'up', velocity: number, when: number): void {
    const selected = action === 'down'
      ? this.options.samplePack.selectPedalDown(velocity)
      : this.options.samplePack.selectPedalUp(velocity);
    if (selected === undefined) return;
    this.startAuxiliaryLayer(selected, 60, when, this.roomBus, 1);
  }

  private startAuxiliaryLayer(
    selected: LoadedSampleSelection,
    midi: number,
    when: number,
    bus: GainNode | null,
    level: number,
  ): void {
    const context = this.context;
    if (context === null || bus === null) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    source.buffer = selected.buffer;
    source.playbackRate.setValueAtTime(selected.playbackRate, when);
    gain.gain.setValueAtTime(Math.max(SILENCE, level), when);
    panner.pan.setValueAtTime(pianoStereoPan(midi, this.options.stereoSpread), when);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(bus);
    this.auxiliarySources.add(source);
    source.onended = () => {
      this.auxiliarySources.delete(source);
      try {
        source.disconnect();
        gain.disconnect();
        panner.disconnect();
      } catch {
        // Browser shutdown may already have released these auxiliary nodes.
      }
    };
    source.start(when);
  }

  private stopAuxiliarySources(when: number): void {
    for (const source of this.auxiliarySources) {
      try {
        source.stop(when + STOP_TAIL_SECONDS);
      } catch {
        // An already-ended source needs no further cleanup.
      }
    }
    this.auxiliarySources.clear();
  }
}
