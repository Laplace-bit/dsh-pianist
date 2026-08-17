import { buildTimeline } from '../core/timeline.js';
import type { PerformanceEvent, Score, TimelineData } from '../core/types.js';
import { createPianoEngine } from './index.js';
import { samplePreloadRequests } from './sample-preload.js';
import type { PianoEngine, PianoEngineFactoryOptions } from './types.js';

/** An OfflineAudioContext factory is injectable so deterministic scheduling is testable in Node. */
export type OfflineAudioContextFactory = (
  channels: number,
  frameCount: number,
  sampleRate: number,
) => OfflineAudioContext;

export type OfflinePianoEngineFactory = (options: PianoEngineFactoryOptions) => PianoEngine;

export interface OfflinePianoRenderOptions {
  readonly sampleRate?: number;
  readonly channels?: number;
  /** Extra time reserved for natural release/reverb tails. */
  readonly tailSeconds?: number;
  readonly engineOptions?: PianoEngineFactoryOptions;
  readonly createContext?: OfflineAudioContextFactory;
  readonly createEngine?: OfflinePianoEngineFactory;
}

export interface OfflinePianoRenderResult {
  readonly audioBuffer: AudioBuffer;
  readonly wav: Uint8Array;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channels: number;
}

export class OfflineRenderingUnavailableError extends Error {
  constructor() {
    super('OfflineAudioContext is unavailable in this environment');
    this.name = 'OfflineRenderingUnavailableError';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function defaultContextFactory(channels: number, frameCount: number, sampleRate: number): OfflineAudioContext {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new OfflineRenderingUnavailableError();
  }
  return new OfflineAudioContext(channels, frameCount, sampleRate);
}

function scheduleEvent(engine: PianoEngine, event: PerformanceEvent): void {
  switch (event.type) {
    case 'noteOn':
      if (event.noteId !== undefined && event.midi !== undefined && event.velocity !== undefined) {
        engine.noteOn(event.noteId, event.midi, event.velocity, event.time);
      }
      return;
    case 'noteOff':
      if (event.noteId !== undefined) {
        engine.noteOff(event.noteId, event.time);
      }
      return;
    case 'pedalDown':
    case 'pedalUp':
      engine.setPedal(event.pedalValue ?? (event.type === 'pedalDown' ? 1 : 0), event.time);
      return;
    case 'tempoChange':
      return;
    default:
      return;
  }
}

/**
 * Encode an AudioBuffer as an interleaved 16-bit PCM RIFF/WAV file. The
 * encoder is deterministic and does not make any timing decisions.
 */
export function encodeAudioBufferAsWav(audioBuffer: AudioBuffer): Uint8Array {
  const channels = positiveInteger(audioBuffer.numberOfChannels, 'audioBuffer.numberOfChannels');
  const sampleRate = positiveInteger(audioBuffer.sampleRate, 'audioBuffer.sampleRate');
  const frames = positiveInteger(audioBuffer.length, 'audioBuffer.length');
  const bytesPerSample = 2;
  const dataLength = frames * channels * bytesPerSample;
  const totalLength = 44 + dataLength;
  if (!Number.isSafeInteger(totalLength) || totalLength > 0xffff_ffff) {
    throw new RangeError('audio buffer is too large to encode as a WAV file');
  }

  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  const samples = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const raw = samples[channel]![frame] ?? 0;
      const normalized = Number.isFinite(raw) ? Math.min(1, Math.max(-1, raw)) : 0;
      const pcm = normalized < 0 ? Math.round(normalized * 0x8000) : Math.round(normalized * 0x7fff);
      view.setInt16(offset, pcm, true);
      offset += bytesPerSample;
    }
  }
  return output;
}

/**
 * Render the same immutable timeline used for interactive playback through an
 * OfflineAudioContext, then return a portable WAV payload. It intentionally
 * has no dependence on requestAnimationFrame or a live AudioContext clock.
 */
export async function renderPianoTimelineOffline(
  timeline: TimelineData,
  options: OfflinePianoRenderOptions = {},
): Promise<OfflinePianoRenderResult> {
  const sampleRate = positiveInteger(options.sampleRate ?? 44_100, 'sampleRate');
  const channels = positiveInteger(options.channels ?? 2, 'channels');
  const tailSeconds = nonNegativeFinite(options.tailSeconds ?? 1.2, 'tailSeconds');
  const durationSeconds = nonNegativeFinite(timeline.durationSeconds, 'timeline.durationSeconds') + tailSeconds;
  const frameCount = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const context = (options.createContext ?? defaultContextFactory)(channels, frameCount, sampleRate);
  const engineOptions: PianoEngineFactoryOptions = {
    ...options.engineOptions,
    preload: options.engineOptions?.preload ?? samplePreloadRequests(timeline),
  };
  const engine = (options.createEngine ?? createPianoEngine)(engineOptions);

  try {
    await engine.init(context);
    for (const event of timeline.events) {
      scheduleEvent(engine, event);
    }
    const audioBuffer = await context.startRendering();
    return {
      audioBuffer,
      wav: encodeAudioBufferAsWav(audioBuffer),
      durationSeconds,
      sampleRate,
      channels,
    };
  } finally {
    // Disposal happens only after startRendering resolves, so it cannot cancel
    // sources that the offline context has yet to render.
    engine.dispose();
  }
}

/** Convenience entry point for callers holding a Score rather than a TimelineData. */
export function renderPianoScoreOffline(
  score: Score,
  options: OfflinePianoRenderOptions = {},
): Promise<OfflinePianoRenderResult> {
  return renderPianoTimelineOffline(buildTimeline(score), options);
}
