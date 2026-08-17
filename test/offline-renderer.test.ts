import { describe, expect, it, vi } from 'vitest';
import {
  encodeAudioBufferAsWav,
  renderPianoScoreOffline,
  type OfflineAudioContextFactory,
} from '../src/audio/offline-renderer.js';
import type { PianoEngine } from '../src/audio/types.js';
import type { Score } from '../src/core/types.js';

const score: Score = {
  id: 'offline-score',
  title: 'Offline score',
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

function fakeAudioBuffer(): AudioBuffer {
  const channels = [new Float32Array([0, -1, 1]), new Float32Array([0.5, -0.5, 0])];
  return {
    numberOfChannels: channels.length,
    sampleRate: 8_000,
    length: channels[0]!.length,
    getChannelData(channel: number) { return channels[channel]!; },
  } as AudioBuffer;
}

describe('offline piano rendering', () => {
  it('schedules the canonical timeline into OfflineAudioContext and returns WAV bytes', async () => {
    const events: string[] = [];
    const engine: PianoEngine = {
      sampleRate: 8_000,
      init: vi.fn(),
      noteOn: (id, _midi, _velocity, when) => { events.push(`on:${id}:${when}`); },
      noteOff: (id, when) => { events.push(`off:${id}:${when}`); },
      setPedal: (value, when) => { events.push(`pedal:${value}:${when}`); },
      allNotesOff: vi.fn(),
      dispose: vi.fn(),
    };
    const rendered = fakeAudioBuffer();
    const context = { startRendering: vi.fn(async () => rendered) } as unknown as OfflineAudioContext;
    const createContext = vi.fn(() => context) as unknown as OfflineAudioContextFactory;

    const result = await renderPianoScoreOffline(score, {
      sampleRate: 8_000,
      tailSeconds: 0.25,
      createContext,
      createEngine: () => engine,
    });

    expect(events).toEqual(['on:c4:0', 'pedal:1:0', 'off:c4:0.25', 'pedal:0:0.25']);
    expect(context.startRendering).toHaveBeenCalledOnce();
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(result.durationSeconds).toBe(0.5);
    expect(new TextDecoder().decode(result.wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(result.wav.slice(8, 12))).toBe('WAVE');
    expect(new DataView(result.wav.buffer).getUint16(22, true)).toBe(2);
  });

  it('encodes interleaved signed 16-bit PCM samples', () => {
    const wav = encodeAudioBufferAsWav(fakeAudioBuffer());
    const view = new DataView(wav.buffer);
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16_384);
    expect(view.getInt16(48, true)).toBe(-32_768);
    expect(view.getInt16(50, true)).toBe(-16_384);
    expect(view.getInt16(52, true)).toBe(32_767);
  });
});
