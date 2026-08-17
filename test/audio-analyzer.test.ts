import { describe, expect, it } from 'vitest';
import { PianoAudioAnalyzer, createMasterAnalyser } from '../src/audio/audio-analyzer.js';
import type { PianoAudioAnalysis } from '../src/audio/audio-analyzer.js';

/** Minimal AnalyserNode double that writes into the supplied buffers. */
function fakeAnalyser(overrides: Partial<{
  timeDomain: (data: Uint8Array<ArrayBuffer>) => void;
  frequency: (data: Uint8Array<ArrayBuffer>) => void;
}> = {}) {
  return {
    fftSize: 256,
    frequencyBinCount: 128,
    getByteTimeDomainData: overrides.timeDomain ?? ((data: Uint8Array<ArrayBuffer>) => { data.fill(128); }),
    getByteFrequencyData: overrides.frequency ?? ((data: Uint8Array<ArrayBuffer>) => { data.fill(0); }),
    connect: () => undefined,
  } as unknown as AnalyserNode;
}

function readFrame(analysis: PianoAudioAnalysis): PianoAudioAnalysis {
  return {
    loudness: analysis.loudness,
    low: analysis.low,
    mid: analysis.mid,
    high: analysis.high,
    energy: analysis.energy,
    noteActivity: analysis.noteActivity,
    usingAnalyser: analysis.usingAnalyser,
  };
}

describe('PianoAudioAnalyzer', () => {
  it('is deterministic and never a musical clock (no per-call time mapping)', () => {
    const analysis = readFrame(new PianoAudioAnalyzer(undefined).read());
    expect(analysis).toEqual({ loudness: 0, low: 0, mid: 0, high: 0, energy: 0, noteActivity: 0, usingAnalyser: false });
  });

  it('reads master output loudness and low-band energy from the analyser', () => {
    const analyser = fakeAnalyser({
      timeDomain: (data) => { data.fill(128); for (let i = 0; i < data.length; i += 4) data[i] = 220; },
      frequency: (data) => { data.fill(0); data[8] = 220; }, // low band only
    });
    const analyzer = new PianoAudioAnalyzer(analyser, null, { readIntervalMs: 0, attack: 1, release: 1 });
    const frame = readFrame(analyzer.read());
    expect(frame.usingAnalyser).toBe(true);
    expect(frame.loudness).toBeGreaterThan(0.5);
    expect(frame.low).toBeGreaterThan(0.01);
    expect(frame.low).toBeGreaterThan(frame.high);
    expect(frame.mid).toBeLessThan(0.02);
    expect(frame.high).toBeLessThan(0.02);
    // Energy blends loudness + band energy and stays in [0,1].
    expect(frame.energy).toBeGreaterThanOrEqual(0);
    expect(frame.energy).toBeLessThanOrEqual(1);
  });

  it('throttles reads so a fast frame loop does not re-read or allocate a new object', () => {
    let reads = 0;
    const analyser = fakeAnalyser({
      timeDomain: (data) => { reads += 1; data.fill(128); data[0] = 200; },
    });
    const analyzer = new PianoAudioAnalyzer(analyser, null, { readIntervalMs: 1000, attack: 1, release: 1 });
    const first = readFrame(analyzer.read());
    const second = readFrame(analyzer.read());
    // Only one physical read occurred, and the second frame is the cached object.
    expect(reads).toBe(1);
    expect(second).toEqual(first);
  });

  it('falls back to event velocity/density when no analogue analyser is available', () => {
    const analyzer = new PianoAudioAnalyzer(undefined, null, { readIntervalMs: 0, attack: 1, release: 1 });
    expect(analyzer.available).toBe(false);
    analyzer.pushNote(0.8);
    const frame = readFrame(analyzer.read());
    expect(frame.usingAnalyser).toBe(false);
    expect(frame.noteActivity).toBeCloseTo(0.8, 5);
    expect(frame.loudness).toBeCloseTo(0.4, 5); // 0.8 * 0.5 fallback gain
  });

  it('clears the smoothed energy immediately when playback stops', () => {
    const analyzer = new PianoAudioAnalyzer(undefined, null, { readIntervalMs: 0, attack: 1, release: 0.01 });
    analyzer.pushNote(1);
    expect(analyzer.read().energy).toBe(1);

    analyzer.reset();

    expect(readFrame(analyzer.read())).toEqual({
      loudness: 0,
      low: 0,
      mid: 0,
      high: 0,
      energy: 0,
      noteActivity: 0,
      usingAnalyser: false,
    });
  });

  it('returns undefined when the runtime cannot build an analyser node', () => {
    const context = {} as unknown as BaseAudioContext;
    expect(createMasterAnalyser(context)).toBeUndefined();
  });
});
