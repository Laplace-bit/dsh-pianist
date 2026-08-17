import { describe, expect, it } from 'vitest';
import { reconstructPerformanceState } from '../src/core/performance-state.js';
import type { TimelineData } from '../src/core/types.js';

const timeline: TimelineData = {
  ppq: 960,
  durationTicks: 1920n,
  durationSeconds: 1,
  events: [
    { id: 'pedal:down', type: 'pedalDown', tick: 0n, time: 0 },
    { id: 'first:on', type: 'noteOn', tick: 0n, time: 0, noteId: 'first', midi: 60, velocity: 0.5 },
    { id: 'second:on', type: 'noteOn', tick: 480n, time: 0.25, noteId: 'second', midi: 60, velocity: 0.8 },
    { id: 'first:off', type: 'noteOff', tick: 960n, time: 0.5, noteId: 'first', midi: 60 },
    { id: 'pedal:up', type: 'pedalUp', tick: 1440n, time: 0.75 },
    { id: 'second:off', type: 'noteOff', tick: 1920n, time: 1, noteId: 'second', midi: 60 },
  ],
};

describe('reconstructPerformanceState', () => {
  it('reconstructs only sustained notes and leaves a held overlapping note active', () => {
    const state = reconstructPerformanceState(timeline, 0.6);

    expect(state.pedal).toBe(1);
    expect(state.activeNotes.map((note) => note.noteId)).toEqual(['first', 'second']);
  });

  it('releases only keys already lifted when the pedal comes up', () => {
    const state = reconstructPerformanceState(timeline, 0.8);

    expect(state.pedal).toBe(0);
    expect(state.activeNotes.map((note) => note.noteId)).toEqual(['second']);
  });

  it('retains the half-pedal value when rebuilding a sustained note state', () => {
    const halfPedalTimeline: TimelineData = {
      ...timeline,
      events: timeline.events.map(event => event.id === 'pedal:down'
        ? { ...event, pedalValue: 0.5 }
        : event),
    };

    const state = reconstructPerformanceState(halfPedalTimeline, 0.6);

    expect(state.pedal).toBe(0.5);
    expect(state.activeNotes.map((note) => note.noteId)).toEqual(['first', 'second']);
  });
});
