import { describe, expect, it } from 'vitest';
import {
  PIANO_PRESENTATION_META_MAX_BYTES,
  createPianoPerformTool,
} from '../src/host/piano-tool.js';
import { compilePianoPerformance, type PianoToolResult } from '../src/shared/piano-tool.js';

describe('Agent piano performance contract', () => {
  it('compiles scientific pitches and beat fractions into a JSON-safe canonical performance', () => {
    const result = compilePianoPerformance({
      title: 'Agent prelude',
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      notes: [
        { pitches: ['C4'], startBeat: 0, durationBeats: '1/2', hand: 'right' },
        { pitches: ['E4'], startBeat: '1/2', durationBeats: '1/2', hand: 'right' },
        { pitches: ['G3', 'C4', 'E4'], startBeat: 0, durationBeats: 1, hand: 'left', velocity: 0.64 },
      ],
      pedals: [{ startBeat: 0, endBeat: 1 }],
      autoplay: true,
    }, 'performance-call-1');

    expect(result).toMatchObject({
      version: 1,
      performanceId: 'performance-call-1',
      title: 'Agent prelude',
      noteCount: 5,
      autoplay: true,
      payload: {
        version: 1,
        performanceId: 'performance-call-1',
        duration: 0.5,
        metadata: { bpm: 120, ppq: 960 },
      },
    });
    expect(result.payload.score.tracks).toHaveLength(2);
    expect(result.payload.score.tracks[0]?.voices[0]?.events[0]).toMatchObject({
      type: 'chord',
      startTick: '0',
      notes: [
        { midi: 55, durationTicks: '960' },
        { midi: 60, durationTicks: '960' },
        { midi: 64, durationTicks: '960' },
      ],
    });
    expect(result.payload.score.tracks[1]?.voices[0]?.events).toMatchObject([
      { type: 'note', midi: 60, startTick: '0', durationTicks: '480' },
      { type: 'note', midi: 64, startTick: '480', durationTicks: '480' },
    ]);
    expect(result.payload).not.toHaveProperty('timeline');
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('rejects pitches outside the 88-key range before a performance reaches the browser', () => {
    expect(() => compilePianoPerformance({
      title: 'Out of range',
      bpm: 120,
      notes: [{ pitches: ['C9'], startBeat: 0, durationBeats: 1 }],
    }, 'bad-performance')).toThrow(/88-key piano accepts 21-108/);
  });

  it('accepts compact note objects for token-efficient long passages', () => {
    const result = compilePianoPerformance({
      title: 'Compact chord',
      bpm: 120,
      notes: [
        { p: 'C4', s: 0, d: '1/2', v: 0.7 },
        { p: ['C3', 'G3'], s: '1/2', d: 1, h: 'l' },
      ],
    }, 'compact-performance');

    expect(result).toMatchObject({ noteCount: 3, title: 'Compact chord' });
    expect(result.payload.score.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'left-hand' }),
      expect.objectContaining({ id: 'right-hand' }),
    ]));
  });

  it('defines a model-discoverable DSH tool with replayable piano metadata', async () => {
    const tool = createPianoPerformTool();

    expect(tool).toMatchObject({
      name: 'piano_perform',
      description: expect.stringContaining('scientific pitch'),
      parameters: {
        type: 'object',
        required: expect.arrayContaining(['title', 'bpm', 'notes']),
      },
    });

    const value = await tool.execute({
      title: 'Middle C',
      bpm: 90,
      notes: [{ pitches: ['C4'], startBeat: 0, durationBeats: 1 }],
    }, {
      callId: 'call-42',
      name: 'piano_perform',
      arguments: {},
      agent: {} as never,
      token: {} as never,
      signal: new AbortController().signal,
    } as never) as PianoToolResult;

    expect(value).toMatchObject({ noteCount: 1 });
    expect(value.performanceId).toMatch(/^piano-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(value.performanceId).not.toContain('call-42');
    expect(tool.output.presentationMeta?.({}, value as never)).toMatchObject({
      kind: 'dsh-pianist-performance',
      performanceId: value.performanceId,
      payload: { score: { title: 'Middle C' } },
    });
  });

  it('rejects a performance whose durable replay metadata exceeds the UTF-8 byte budget', async () => {
    const tool = createPianoPerformTool();
    const notes = Array.from({ length: 4_096 }, (_, index) => ({
      pitches: ['C4'],
      startBeat: index,
      durationBeats: 1,
    }));

    await expect(tool.execute({
      title: '大型乐谱',
      bpm: 120,
      notes,
    }, {
      callId: 'oversized/provider+id',
      name: 'piano_perform',
      arguments: {},
      agent: {} as never,
      token: {} as never,
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(new RegExp(`metadata exceeds ${String(PIANO_PRESENTATION_META_MAX_BYTES)}`));
  });
});
