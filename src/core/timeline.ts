import type {
  ChordEvent,
  MusicEvent,
  PerformanceEvent,
  PerformanceEventType,
  Score,
  Tick,
  TimelineData,
  TupletEvent,
} from './types.js';
import { TempoMap } from './tempo-map.js';
import { validateScore } from './validator.js';

const EVENT_TYPE_ORDER: Record<PerformanceEventType, number> = {
  noteOff: 0,
  pedalUp: 1,
  noteOn: 2,
  pedalDown: 3,
  tempoChange: 4,
};

function compareEvents(a: PerformanceEvent, b: PerformanceEvent): number {
  if (a.tick !== b.tick) {
    return a.tick < b.tick ? -1 : 1;
  }
  const orderDiff = EVENT_TYPE_ORDER[a.type] - EVENT_TYPE_ORDER[b.type];
  if (orderDiff !== 0) {
    return orderDiff;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

function addNoteEvents(
  events: PerformanceEvent[],
  id: string,
  midi: number,
  startTick: Tick,
  durationTicks: Tick,
  velocity: number,
  tempoMap: TempoMap,
): void {
  const endTick = BigInt(startTick) + BigInt(durationTicks);
  events.push({
    id: `${id}:on`,
    type: 'noteOn',
    time: tempoMap.tickToSeconds(startTick),
    tick: BigInt(startTick),
    midi,
    velocity,
    noteId: id,
  });
  events.push({
    id: `${id}:off`,
    type: 'noteOff',
    time: tempoMap.tickToSeconds(endTick),
    tick: endTick,
    midi,
    noteId: id,
  });
}

function addChordEvents(
  events: PerformanceEvent[],
  chord: ChordEvent,
  tempoMap: TempoMap,
): void {
  chord.notes.forEach((note, index) => {
    addNoteEvents(
      events,
      `${chord.id}:${index}`,
      note.midi,
      chord.startTick,
      note.durationTicks,
      note.velocity,
      tempoMap,
    );
  });
}

/**
 * Compute the tick scale applied to the whole timeline. Every tuplet's local
 * timebase divides its container's parent duration by `normal` and multiplies
 * by `actual`; multiplying the global ppq (and every tick) by the product of
 * all tuplet `actual` ratios keeps every expanded child tick an integer.
 */
function collectTupletScale(events: readonly MusicEvent[], scale: bigint): bigint {
  let result = scale;
  for (const event of events) {
    if (event.type === 'tuplet') {
      result *= BigInt(event.actual);
      result = collectTupletScale(event.events, result);
    }
  }
  return result;
}

interface TimelineBuilder {
  events: PerformanceEvent[];
  tempoMap: TempoMap;
  maxTick: bigint;
}

function addMusicEvent(
  builder: TimelineBuilder,
  event: MusicEvent,
  baseTick: Tick,
  scale: bigint,
  idPrefix: string,
): void {
  if (event.type === 'note') {
    const startTick = BigInt(baseTick) + BigInt(event.startTick) * scale;
    const durationTicks = BigInt(event.durationTicks) * scale;
    addNoteEvents(
      builder.events,
      `${idPrefix}${event.id}`,
      event.midi,
      startTick,
      durationTicks,
      event.velocity,
      builder.tempoMap,
    );
    builder.maxTick = builder.maxTick < startTick + durationTicks
      ? startTick + durationTicks
      : builder.maxTick;
    return;
  }
  if (event.type === 'chord') {
    const startTick = BigInt(baseTick) + BigInt(event.startTick) * scale;
    const shiftedChord: ChordEvent = {
      ...event,
      id: `${idPrefix}${event.id}`,
      startTick,
    };
    for (const note of event.notes) {
      const durationTicks = BigInt(note.durationTicks) * scale;
      const end = startTick + durationTicks;
      builder.maxTick = builder.maxTick < end ? end : builder.maxTick;
    }
    addChordEvents(builder.events, shiftedChord, builder.tempoMap);
    return;
  }
  if (event.type === 'pedal') {
    const startTick = BigInt(baseTick) + BigInt(event.startTick) * scale;
    const endTick = BigInt(baseTick) + BigInt(event.endTick) * scale;
    builder.events.push({
      id: `${idPrefix}${event.id}:down`,
      type: 'pedalDown',
      time: builder.tempoMap.tickToSeconds(startTick),
      tick: startTick,
      pedalValue: event.value,
    });
    builder.events.push({
      id: `${idPrefix}${event.id}:up`,
      type: 'pedalUp',
      time: builder.tempoMap.tickToSeconds(endTick),
      tick: endTick,
      pedalValue: 0,
    });
    builder.maxTick = builder.maxTick < endTick ? endTick : builder.maxTick;
    return;
  }
  if (event.type === 'rest') {
    // A rest has no audio transition, but it is still part of the score's
    // absolute duration. Omitting it would end a score with trailing silence
    // before its deterministic musical timeline is complete.
    const end = BigInt(baseTick) + (BigInt(event.startTick) + BigInt(event.durationTicks)) * scale;
    builder.maxTick = builder.maxTick < end ? end : builder.maxTick;
    return;
  }
  if (event.type === 'tuplet') {
    addTupletEvents(builder, event, baseTick, scale, idPrefix);
    return;
  }
}

function addTupletEvents(
  builder: TimelineBuilder,
  tuplet: TupletEvent,
  baseTick: Tick,
  scale: bigint,
  idPrefix: string,
): void {
  // Child ticks live in the tuplet's local timebase: the container is
  // durationTicks * actual / normal local ticks long, so one local tick equals
  // normal / actual parent ticks. `scale` already carries every enclosing
  // tuplet's `actual` factor, which keeps scale * normal / actual integral.
  const containerStart = BigInt(baseTick) + BigInt(tuplet.startTick) * scale;
  const containerEnd = BigInt(baseTick) + (BigInt(tuplet.startTick) + BigInt(tuplet.durationTicks)) * scale;
  builder.maxTick = builder.maxTick < containerEnd ? containerEnd : builder.maxTick;
  const childScale = (scale * BigInt(tuplet.normal)) / BigInt(tuplet.actual);
  const childPrefix = `${idPrefix}${tuplet.id}:`;
  for (const event of tuplet.events) {
    addMusicEvent(builder, event, containerStart, childScale, childPrefix);
  }
}

export function buildTimeline(score: Score): TimelineData {
  validateScore(score);

  const globalScale = score.tracks.reduce(
    (scale, track) => track.voices.reduce(
      (voiceScale, voice) => collectTupletScale(voice.events, voiceScale),
      scale,
    ),
    1n,
  );
  const timelinePPQ = score.ppq * Number(globalScale);
  const tempoMap = new TempoMap(
    timelinePPQ,
    score.tempoMap.map((event) => ({ tick: BigInt(event.tick) * globalScale, bpm: event.bpm })),
  );
  const builder: TimelineBuilder = {
    events: [],
    tempoMap,
    maxTick: 0n,
  };

  for (const track of score.tracks) {
    for (const voice of track.voices) {
      for (const event of voice.events) {
        addMusicEvent(builder, event, 0n, globalScale, '');
      }
    }
  }

  for (const tempo of score.tempoMap) {
    const tick = BigInt(tempo.tick) * globalScale;
    builder.events.push({
      id: `tempo:${tick}`,
      type: 'tempoChange',
      time: tempoMap.tickToSeconds(tick),
      tick,
      bpm: tempo.bpm,
    });
  }

  builder.events.sort(compareEvents);

  const immutableEvents = Object.freeze(builder.events.map(event => Object.freeze({ ...event })));
  return Object.freeze({
    ppq: timelinePPQ,
    events: immutableEvents,
    durationTicks: builder.maxTick,
    durationSeconds: tempoMap.tickToSeconds(builder.maxTick),
  });
}
