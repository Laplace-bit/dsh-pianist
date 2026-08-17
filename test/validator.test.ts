import { describe, expect, it } from 'vitest';
import { ScoreParseError, ScoreValidationError } from '../src/core/errors.js';
import { normalizeScore, parseScoreJson } from '../src/core/normalizer.js';
import { validateScore } from '../src/core/validator.js';
import type { MusicEvent, Score } from '../src/core/types.js';

function validScore(): Score {
  return {
    id: 's',
    title: 'Valid',
    ppq: 960,
    tempoMap: [{ tick: 0n, bpm: 100 }],
    timeSignatureMap: [],
    tracks: [
      {
        id: 't',
        instrument: { id: 'piano' },
        voices: [
          {
            id: 'v',
            events: [
              { id: 'n', type: 'note', midi: 60, startTick: 0n, durationTicks: 480n, velocity: 0.8, voiceId: 'v', trackId: 't' },
            ],
          },
        ],
      },
    ],
  };
}

describe('ScoreValidator', () => {
  it('accepts a valid score', () => {
    expect(() => validateScore(validScore())).not.toThrow();
  });

  it('rejects notes outside the 88-key range instead of skipping them', () => {
    const bad = validScore();
    bad.tracks[0].voices[0].events[0] = { ...bad.tracks[0].voices[0].events[0], midi: 20 } as MusicEvent;
    expect(() => validateScore(bad)).toThrow(ScoreValidationError);
  });

  it('rejects duplicate event IDs before they can overwrite a performance state', () => {
    const score = validScore();
    score.tracks[0].voices[0].events.push({
      id: 'n',
      type: 'note',
      midi: 64,
      startTick: 480n,
      durationTicks: 480n,
      velocity: 0.8,
      voiceId: 'v',
      trackId: 't',
    });

    expect(() => validateScore(score)).toThrow(/id must be unique across the score/);
  });

  it('rejects raw IDs that would collide after a chord expands into performance events', () => {
    const score = validScore();
    score.tracks[0].voices[0].events = [
      {
        id: 'chord',
        type: 'chord',
        startTick: 0n,
        notes: [{ midi: 60, durationTicks: 480n, velocity: 0.8 }],
        voiceId: 'v',
        trackId: 't',
      },
      {
        id: 'chord:0',
        type: 'note',
        midi: 64,
        startTick: 480n,
        durationTicks: 480n,
        velocity: 0.8,
        voiceId: 'v',
        trackId: 't',
      },
    ];

    expect(() => validateScore(score)).toThrow(/derived performance event id .* unique/);
  });

  it('rejects invalid tempo and missing tempo map', () => {
    const bad = validScore();
    bad.tempoMap = [{ tick: 0n, bpm: 0 }];
    expect(() => validateScore(bad)).toThrow(/bpm/);
    bad.tempoMap = [];
    expect(() => validateScore(bad)).toThrow(/empty/);
  });

  it('rejects non-positive duration and out-of-range velocity', () => {
    const bad = validScore();
    bad.tracks[0].voices[0].events[0] = { ...bad.tracks[0].voices[0].events[0], durationTicks: 0n } as MusicEvent;
    expect(() => validateScore(bad)).toThrow(/durationTicks/);

    const badVelocity = validScore();
    badVelocity.tracks[0].voices[0].events[0] = { ...badVelocity.tracks[0].voices[0].events[0], velocity: 1.1 } as MusicEvent;
    expect(() => validateScore(badVelocity)).toThrow(/velocity/);
  });

  it('rejects a nested tuplet that extends beyond its parent duration', () => {
    const score = validScore();
    score.tracks[0].voices[0].events = [{
      id: 'outer',
      type: 'tuplet',
      actual: 3,
      normal: 2,
      startTick: 0n,
      durationTicks: 960n,
      voiceId: 'v',
      trackId: 't',
      events: [{
        id: 'inner',
        type: 'tuplet',
        actual: 3,
        normal: 2,
        startTick: 720n,
        durationTicks: 480n,
        voiceId: 'v',
        trackId: 't',
        events: [{
          id: 'inner-note',
          type: 'note',
          midi: 60,
          startTick: 0n,
          durationTicks: 240n,
          velocity: 0.8,
          voiceId: 'v',
          trackId: 't',
        }],
      }],
    }];

    expect(() => validateScore(score)).toThrow(/extends past its tuplet container/);
  });
});

describe('normalizeScore', () => {
  it('converts string ticks into bigint', () => {
    const input = JSON.parse(JSON.stringify(validScore(), (key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ));
    const normalized = normalizeScore(input);
    expect(typeof normalized.tracks[0].voices[0].events[0].startTick).toBe('bigint');
    expect(normalized.tracks[0].voices[0].events[0].startTick).toBe(0n);
  });

  it('throws ScoreParseError on malformed tick instead of defaulting to C4', () => {
    const raw = {
      id: 'bad',
      title: 'Bad',
      ppq: 960,
      tempoMap: [{ tick: 'abc', bpm: 100 }],
      tracks: [],
    };
    expect(() => normalizeScore(raw)).toThrow(/tick/);
  });

  it('reports malformed score containers as parse errors instead of native TypeErrors', () => {
    expect(() => normalizeScore({
      id: 'bad-container',
      title: 'Bad container',
      ppq: 960,
      tempoMap: { tick: '0', bpm: 120 },
      tracks: [],
    })).toThrow(/tempoMap must be an array/);

    expect(() => normalizeScore({
      id: 'bad-events',
      title: 'Bad events',
      ppq: 960,
      tempoMap: [{ tick: '0', bpm: 120 }],
      tracks: [{ id: 'piano', voices: { not: 'an array' } }],
    })).toThrow(/voices must be an array/);
  });

  it.each([
    ['note duration', { id: 'note', type: 'note', midi: 60, startTick: '0', velocity: 0.8, voiceId: 'v', trackId: 't' }, /durationTicks/],
    ['pedal end', { id: 'pedal', type: 'pedal', startTick: '0', value: 1, voiceId: 'v', trackId: 't' }, /endTick/],
    ['chord-note duration', { id: 'chord', type: 'chord', startTick: '0', notes: [{ midi: 60, velocity: 0.8 }], voiceId: 'v', trackId: 't' }, /durationTicks/],
    ['tuplet ratio', { id: 'tuplet', type: 'tuplet', normal: 2, startTick: '0', durationTicks: '960', events: [], voiceId: 'v', trackId: 't' }, /actual/],
  ])('reports a missing %s scalar as ScoreParseError', (_label, event, message) => {
    const raw = {
      id: 'bad-event',
      title: 'Bad event',
      ppq: 960,
      tempoMap: [{ tick: '0', bpm: 120 }],
      tracks: [{
        id: 't',
        instrument: { id: 'grand' },
        voices: [{ id: 'v', events: [event] }],
      }],
    };

    expect(() => normalizeScore(raw)).toThrow(message);
    expect(() => normalizeScore(raw)).toThrow(ScoreParseError);
  });

  it('parses JSON and validates through buildTimeline', async () => {
    const { buildTimeline } = await import('../src/core/timeline.js');
    const json = JSON.stringify(validScore(), (key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    const score = parseScoreJson(json);
    expect(buildTimeline(score).events).toHaveLength(3);
  });
});
