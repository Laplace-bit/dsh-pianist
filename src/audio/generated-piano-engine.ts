import { cancelAndHoldAutomation } from './cancel-and-hold.js';
import { generatePianoTone, midiToFrequency } from './generated-piano.js';
import type { PianoEngine, PianoEngineOptions } from './types.js';

interface ActiveVoice {
  source: AudioScheduledSourceNode;
  gain: GainNode;
  naturalStopAt: number;
  keyDown: boolean;
  releaseScheduled: boolean;
  durationNoteOffAt: number | undefined;
  pendingDurationRelease: boolean;
}

const FULL_PEDAL_THRESHOLD = 0.95;
const LOOP_START_SECONDS = 1;
const LOOP_END_SECONDS = 2.8;
const LOOP_CROSSFADE_SECONDS = 0.08;
const DEFERRED_STOP_SECONDS = 1_000_000_000;

function smoothLoopSeam(data: Float32Array, sampleRate: number): void {
  const start = Math.floor(LOOP_START_SECONDS * sampleRate);
  const end = Math.min(data.length, Math.floor(LOOP_END_SECONDS * sampleRate));
  const fade = Math.min(start, Math.floor(LOOP_CROSSFADE_SECONDS * sampleRate));
  if (fade < 2 || end - fade <= start) return;

  // Blend the loop tail into the waveform immediately preceding loopStart.
  // The last sample then continues into loopStart without a hard PCM edge.
  for (let index = 0; index < fade; index += 1) {
    const mix = (index + 1) / fade;
    const tailIndex = end - fade + index;
    const continuationIndex = start - fade + index;
    data[tailIndex] = data[tailIndex]! * (1 - mix) + data[continuationIndex]! * mix;
  }
}

/**
 * A Web Audio piano engine backed by generated PCM buffers.
 *
 * It intentionally does not use a raw oscillator for each note. Each note is
 * served from an AudioBuffer, with velocity shaping and a release gain ramp.
 */
export class GeneratedPianoEngine implements PianoEngine {
  readonly sampleRate: number;
  readonly options: Required<Omit<PianoEngineOptions, 'analyser'>>;

  private context: BaseAudioContext | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private activeVoices = new Map<string, ActiveVoice>();
  private masterGain: GainNode | null = null;
  private readonly analyser: AnalyserNode | undefined;
  private pedal = 0;
  private readonly bufferDurationSeconds = 3;

  constructor(options: PianoEngineOptions = {}) {
    this.sampleRate = options.sampleRate ?? 44100;
    this.options = {
      fallbackToGenerated: options.fallbackToGenerated ?? true,
      releaseSeconds: options.releaseSeconds ?? 0.35,
      gain: options.gain ?? 0.8,
      sampleRate: options.sampleRate ?? 44100,
    };
    this.analyser = options.analyser;
  }

  async init(context: BaseAudioContext): Promise<void> {
    this.context = context;
    this.masterGain = context.createGain();
    this.masterGain.gain.value = this.options.gain;
    if (this.analyser !== undefined) {
      this.masterGain.connect(this.analyser);
      this.analyser.connect(context.destination);
    } else {
      this.masterGain.connect(context.destination);
    }
  }

  private getBuffer(context: BaseAudioContext, midi: number, velocity: number): AudioBuffer {
    const cacheKey = midi * 128 + Math.round(velocity * 4);
    const cached = this.buffers.get(cacheKey);
    if (cached) {
      return cached;
    }
    const data = generatePianoTone({
      sampleRate: context.sampleRate,
      midi,
      velocity,
      durationSeconds: this.bufferDurationSeconds,
    });
    smoothLoopSeam(data, context.sampleRate);
    const buffer = context.createBuffer(1, data.length, context.sampleRate);
    buffer.copyToChannel(new Float32Array(data), 0);
    this.buffers.set(cacheKey, buffer);
    return buffer;
  }

  noteOn(id: string, midi: number, velocity: number, when: number, duration?: number): void {
    const voice = this.startVoice(id, midi, velocity, when, 0, true);
    if (voice === undefined) {
      return;
    }
    if (duration !== undefined) {
      if (Number.isFinite(duration) === false || duration <= 0) {
        throw new RangeError('duration must be a positive finite number');
      }
      voice.durationNoteOffAt = when + duration;
      this.scheduleDurationRelease(voice, when);
    }
  }

  restoreNote(note: import('./types.js').RestoredPianoNote): void {
    const offset = Math.max(0, note.offsetSeconds);
    this.startVoice(note.id, note.midi, note.velocity, note.when, offset, note.keyDown);
  }

  setGain(gain: number, when = this.context?.currentTime ?? 0): void {
    if (Number.isFinite(gain) === false || gain < 0 || gain > 1) {
      throw new RangeError('gain must be a finite number in [0, 1]');
    }
    this.masterGain?.gain.setTargetAtTime(gain, when, 0.015);
  }

  noteOff(id: string, when: number): void {
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

  setPedal(value: number, when: number): void {
    if (Number.isFinite(value) === false || value < 0 || value > 1) {
      throw new RangeError('pedal value must be a finite number in [0, 1]');
    }
    this.advanceDurationNoteOffs(when);
    const previous = this.pedal;
    this.pedal = value;
    for (const voice of this.activeVoices.values()) {
      if (voice.durationNoteOffAt !== undefined && voice.durationNoteOffAt > when) {
        this.scheduleDurationRelease(voice, when);
      }
    }
    if (value >= previous) {
      return;
    }
    for (const voice of this.activeVoices.values()) {
      if (voice.keyDown === false && voice.releaseScheduled === false) {
        this.releaseForPedal(voice, when);
      }
    }
  }

  allNotesOff(when?: number): void {
    for (const [id, voice] of this.activeVoices) {
      if (when !== undefined && this.context !== null) {
        this.releaseVoice(voice, when, Math.min(this.options.releaseSeconds, 0.01));
      } else {
        try {
          voice.source.stop();
        } catch {
          // Already stopped.
        }
      }
      this.activeVoices.delete(id);
    }
  }

  dispose(): void {
    this.allNotesOff();
    this.buffers.clear();
    this.masterGain = null;
    this.pedal = 0;
    this.context = null;
  }

  private releaseForPedal(voice: ActiveVoice, when: number): void {
    // A full sustain pedal holds a released key. Intermediate pedal values
    // retain a longer damped tail instead of behaving as on/off mute.
    if (this.pedal >= FULL_PEDAL_THRESHOLD) {
      return;
    }
    const release = this.releaseSecondsForPedal();
    this.releaseVoice(voice, when, release);
  }

  private releaseSecondsForPedal(): number {
    return this.options.releaseSeconds * (1 + this.pedal * 2);
  }

  private scheduleDurationRelease(voice: ActiveVoice, when: number): void {
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
        voice.pendingDurationRelease = false;
      } else {
        this.releaseForPedal(voice, noteOffAt);
      }
    }
  }

  private cancelPendingDurationRelease(voice: ActiveVoice, when: number): void {
    if (!voice.pendingDurationRelease) {
      return;
    }
    cancelAndHoldAutomation(voice.gain.gain, when, 0.0001);
    try {
      voice.source.stop(voice.naturalStopAt);
    } catch {
      // The source may have ended before a future release was canceled.
    }
    voice.releaseScheduled = false;
    voice.pendingDurationRelease = false;
  }

  private releaseVoice(
    voice: ActiveVoice,
    when: number,
    release: number,
    pendingDurationRelease = false,
  ): void {
    if (voice.releaseScheduled) {
      return;
    }
    voice.releaseScheduled = true;
    voice.pendingDurationRelease = pendingDurationRelease;
    cancelAndHoldAutomation(voice.gain.gain, when, 0.0001);
    voice.gain.gain.linearRampToValueAtTime(0.0001, when + release);
    try {
      voice.source.stop(when + release + 0.02);
    } catch {
      // AudioBufferSourceNode only accepts one stop call.
    }
  }

  private startVoice(
    id: string,
    midi: number,
    velocity: number,
    when: number,
    offsetSeconds: number,
    keyDown: boolean,
  ): ActiveVoice | undefined {
    const context = this.context;
    if (context === null || Number.isFinite(when) === false) {
      return undefined;
    }
    if (Number.isFinite(velocity) === false || velocity < 0 || velocity > 1) {
      throw new RangeError('velocity must be a finite number in [0, 1]');
    }
    const buffer = this.getBuffer(context, midi, velocity);
    const loopStart = Math.min(LOOP_START_SECONDS, buffer.duration * 0.4);
    const loopEnd = Math.min(LOOP_END_SECONDS, buffer.duration);
    const loopDuration = loopEnd - loopStart;
    const playbackOffset = offsetSeconds < loopEnd || loopDuration <= 0
      ? offsetSeconds
      : loopStart + ((offsetSeconds - loopStart) % loopDuration);

    this.advanceDurationNoteOffs(when);

    const previous = this.activeVoices.get(id);
    if (previous !== undefined) {
      this.releaseVoice(previous, when, 0.01);
      this.activeVoices.delete(id);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = loopStart;
    source.loopEnd = loopEnd;
    const gain = context.createGain();
    if (offsetSeconds === 0) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + 0.004);
    } else {
      // Restored notes start inside an existing sample buffer, so do not replay
      // its transient attack after a seek.
      gain.gain.setValueAtTime(1, when);
    }
    source.connect(gain);
    gain.connect(this.masterGain ?? context.destination);

    const voice: ActiveVoice = {
      source,
      gain,
      // AudioBufferSourceNode.stop() can replace a previously scheduled stop.
      // A far-future finite value therefore cancels a provisional duration
      // release while preserving the bounded looping source.
      naturalStopAt: when + DEFERRED_STOP_SECONDS,
      keyDown,
      releaseScheduled: false,
      durationNoteOffAt: undefined,
      pendingDurationRelease: false,
    };
    source.onended = () => {
      if (this.activeVoices.get(id) === voice) {
        this.activeVoices.delete(id);
      }
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // Nodes may already have been disconnected during disposal.
      }
    };
    this.activeVoices.set(id, voice);
    source.start(when, playbackOffset);
    return voice;
  }
}
