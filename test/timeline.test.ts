import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/core/timeline.js';
import type { Score } from '../src/core/types.js';

function sampleScore(): Score {
  return {
    id: 's1',
    title: 'Test',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 120 }],
    timeSignatureMap: [{ tick: 0n, numerator: 4, denominator: 4 }],
    tracks: [
      {
        id: 't1',
        instrument: { id: 'grand' },
        voices: [
          {
            id: 'v1',
            events: [
              { id: 'n1', type: 'note', midi: 60, startTick: 0n, durationTicks: 480n, velocity: 0.8, voiceId: 'v1', trackId: 't1' },
              { id: 'n2', type: 'note', midi: 64, startTick: 480n, durationTicks: 480n, velocity: 0.7, voiceId: 'v1', trackId: 't1' },
              { id: 'ped1', type: 'pedal', startTick: 0n, endTick: 960n, value: 1, voiceId: 'v1', trackId: 't1' },
            ],
          },
        ],
      },
    ],
  };
}

function evenlyDividedTupletScore(actual: number, normal: number): Score {
  const durationTicks = 960n;
  const localNoteDuration = durationTicks / BigInt(normal);
  return {
    ...sampleScore(),
    tracks: [{
      id: 't1',
      instrument: { id: 'grand' },
      voices: [{
        id: 'v1',
        events: [{
          id: `${actual}-${normal}`,
          type: 'tuplet',
          actual,
          normal,
          startTick: 0n,
          // The tuplet occupies one quarter note in its parent timebase.
          durationTicks,
          voiceId: 'v1',
          trackId: 't1',
          events: Array.from({ length: actual }, (_, index) => ({
            id: `note-${index}`,
            type: 'note' as const,
            midi: 60 + index,
            startTick: BigInt(index) * localNoteDuration,
            durationTicks: localNoteDuration,
            velocity: 0.7,
            voiceId: 'v1',
            trackId: 't1',
          })),
        }],
      }],
    }],
  };
}

describe('buildTimeline', () => {
  it('emits noteOn and noteOff events in deterministic order', () => {
    const timeline = buildTimeline(sampleScore());
    const types = timeline.events
      .filter((event) => event.type === 'noteOn' || event.type === 'noteOff')
      .map((event) => event.type);
    expect(types).toEqual(['noteOn', 'noteOff', 'noteOn', 'noteOff']);
    expect(timeline.events[0].time).toBe(0);
    expect(timeline.events.find((event) => event.type === 'noteOff')?.time).toBeCloseTo(0.25, 10);
    expect(timeline.durationSeconds).toBeCloseTo(0.5, 10);
  });

  it('expands chords and tuplets into individual notes', () => {
    const score: Score = {
      ...sampleScore(),
      tracks: [
        {
          id: 't1',
          instrument: { id: 'grand' },
          voices: [
            {
              id: 'v1',
              events: [
                {
                  id: 'chord1',
                  type: 'chord',
                  startTick: 0n,
                  notes: [
                    { midi: 60, durationTicks: 480n, velocity: 0.8 },
                    { midi: 64, durationTicks: 480n, velocity: 0.7 },
                  ],
                  voiceId: 'v1',
                  trackId: 't1',
                },
                {
                  id: 'trip1',
                  type: 'tuplet',
                  actual: 3,
                  normal: 2,
                  startTick: 0n,
                  durationTicks: 960n,
                  voiceId: 'v1',
                  trackId: 't1',
                  events: [
                    { id: 't1', type: 'note', midi: 60, startTick: 0n, durationTicks: 240n, velocity: 0.5, voiceId: 'v1', trackId: 't1' },
                    { id: 't2', type: 'note', midi: 62, startTick: 320n, durationTicks: 240n, velocity: 0.5, voiceId: 'v1', trackId: 't1' },
                    { id: 't3', type: 'note', midi: 64, startTick: 640n, durationTicks: 240n, velocity: 0.5, voiceId: 'v1', trackId: 't1' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const timeline = buildTimeline(score);
    const ons = timeline.events.filter((event) => event.type === 'noteOn');
    expect(ons).toHaveLength(5);
    expect(ons[0].midi).toBe(60);
    expect(ons[1].midi).toBe(64);
    expect(ons.map((event) => event.noteId)).toContain('trip1:t2');
  });

  it.each([
    [3, 2],
    [5, 4],
    [7, 4],
  ])('maps a %i:%i tuplet to exact child ticks and its declared total duration', (actual, normal) => {
    const timeline = buildTimeline(evenlyDividedTupletScore(actual, normal));
    const noteOns = timeline.events.filter(event => event.type === 'noteOn');
    const noteOffs = timeline.events.filter(event => event.type === 'noteOff');

    expect(timeline.ppq).toBe(960 * actual);
    expect(timeline.durationTicks).toBe(BigInt(960 * actual));
    expect(timeline.durationSeconds).toBeCloseTo(0.5, 12);
    expect(noteOns.map(event => event.tick)).toEqual(
      Array.from({ length: actual }, (_, index) => BigInt(index * 960)),
    );
    expect(noteOffs.map(event => event.tick)).toEqual(
      Array.from({ length: actual }, (_, index) => BigInt((index + 1) * 960)),
    );
    expect(noteOffs.at(-1)?.time).toBeCloseTo(0.5, 12);
  });

  it('is deterministic for the same score', () => {
    const a = buildTimeline(sampleScore());
    const b = buildTimeline(sampleScore());
    expect(a).toEqual(b);
  });

  it('preserves a half-pedal value in the performance timeline', () => {
    const score = sampleScore();
    score.tracks[0]!.voices[0]!.events = [
      { id: 'pedal', type: 'pedal', startTick: 0n, endTick: 480n, value: 0.5, voiceId: 'v1', trackId: 't1' },
    ];

    const pedalEvents = buildTimeline(score).events.filter(event =>
      event.type === 'pedalDown' || event.type === 'pedalUp');

    expect(pedalEvents).toEqual([
      expect.objectContaining({ type: 'pedalDown', pedalValue: 0.5 }),
      expect.objectContaining({ type: 'pedalUp', pedalValue: 0 }),
    ]);
  });

  it('retains trailing rests in the score duration without emitting audio events', () => {
    const score = sampleScore();
    score.tracks[0]!.voices[0]!.events = [{
      id: 'ending-rest',
      type: 'rest',
      startTick: 960n,
      durationTicks: 960n,
      voiceId: 'v1',
      trackId: 't1',
    }];

    const timeline = buildTimeline(score);

    expect(timeline.durationTicks).toBe(1_920n);
    expect(timeline.durationSeconds).toBeCloseTo(1, 12);
    expect(timeline.events.filter(event => event.type === 'noteOn' || event.type === 'noteOff')).toEqual([]);
  });

  it('keeps every enclosing tuplet offset when expanding nested tuplets', () => {
    const score: Score = {
      ...sampleScore(),
      tracks: [{
        id: 't1',
        instrument: { id: 'grand' },
        voices: [{
          id: 'v1',
          events: [{
            id: 'outer',
            type: 'tuplet',
            actual: 3,
            normal: 2,
            startTick: 960n,
            durationTicks: 960n,
            voiceId: 'v1',
            trackId: 't1',
            events: [{
              id: 'inner',
              type: 'tuplet',
              actual: 3,
              normal: 2,
              startTick: 480n,
              durationTicks: 480n,
              voiceId: 'v1',
              trackId: 't1',
              events: [{
                id: 'note',
                type: 'note',
                midi: 67,
                startTick: 0n,
                durationTicks: 240n,
                velocity: 0.8,
                voiceId: 'v1',
                trackId: 't1',
              }],
            }],
          }],
        }],
      }],
    };

    const noteOn = buildTimeline(score).events.find((event) => event.id === 'outer:inner:note:on');
    expect(noteOn?.tick).toBe(11_520n);
    expect(noteOn?.time).toBeCloseTo(2 / 3, 10);
  });
});
