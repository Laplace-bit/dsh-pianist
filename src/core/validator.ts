import type {
  ChordEvent,
  MusicEvent,
  NoteEvent,
  PedalEvent,
  RestEvent,
  Score,
  TempoEvent,
  Tick,
  TimeSignatureEvent,
  TupletEvent,
} from './types.js';
import { ScoreValidationError } from './errors.js';

export const MIN_MIDI = 21;
export const MAX_MIDI = 108;
export const MAX_VELOCITY = 1;

function isNonNegativeTick(value: Tick): boolean {
  return BigInt(value) >= 0n;
}

function isPositiveTick(value: Tick): boolean {
  return BigInt(value) > 0n;
}

function isValidId(value: string): boolean {
  return typeof value === 'string' && value.length > 0;
}

function validateTempoMap(tempoMap: readonly TempoEvent[]): string[] {
  const issues: string[] = [];
  if (tempoMap.length === 0) {
    issues.push('tempoMap must not be empty');
    return issues;
  }
  for (let i = 0; i < tempoMap.length; i += 1) {
    const tempo = tempoMap[i];
    if (isNonNegativeTick(tempo.tick) === false) {
      issues.push(`tempoMap[${i}].tick must be non-negative`);
    }
    if (Number.isFinite(tempo.bpm) === false || tempo.bpm <= 0) {
      issues.push(`tempoMap[${i}].bpm must be a positive finite number`);
    }
    if (i > 0 && BigInt(tempo.tick) <= BigInt(tempoMap[i - 1].tick)) {
      issues.push(`tempoMap must be sorted by tick (index ${i})`);
    }
  }
  if (tempoMap.length > 0 && BigInt(tempoMap[0].tick) !== 0n) {
    issues.push('tempoMap[0].tick must be 0');
  }
  return issues;
}

function validateTimeSignatureMap(
  timeSignatureMap: readonly TimeSignatureEvent[],
): string[] {
  const issues: string[] = [];
  for (let i = 0; i < timeSignatureMap.length; i += 1) {
    const sig = timeSignatureMap[i];
    if (isNonNegativeTick(sig.tick) === false) {
      issues.push(`timeSignatureMap[${i}].tick must be non-negative`);
    }
    if (Number.isInteger(sig.numerator) === false || sig.numerator <= 0) {
      issues.push(`timeSignatureMap[${i}].numerator must be a positive integer`);
    }
    if (Number.isInteger(sig.denominator) === false || sig.denominator <= 0) {
      issues.push(`timeSignatureMap[${i}].denominator must be a positive integer`);
    }
    if (i > 0 && BigInt(sig.tick) <= BigInt(timeSignatureMap[i - 1].tick)) {
      issues.push(`timeSignatureMap must be sorted by tick (index ${i})`);
    }
  }
  return issues;
}

function validateNote(note: NoteEvent, path: string, voiceId: string, trackId: string): string[] {
  const issues: string[] = [];
  if (isValidId(note.id) === false) {
    issues.push(`${path}.id must be a non-empty string`);
  }
  if (note.type !== 'note') {
    issues.push(`${path}.type must be "note"`);
  }
  if (Number.isInteger(note.midi) === false || note.midi < MIN_MIDI || note.midi > MAX_MIDI) {
    issues.push(`${path}.midi must be an integer in [${MIN_MIDI}, ${MAX_MIDI}]`);
  }
  if (isNonNegativeTick(note.startTick) === false) {
    issues.push(`${path}.startTick must be non-negative`);
  }
  if (isPositiveTick(note.durationTicks) === false) {
    issues.push(`${path}.durationTicks must be positive`);
  }
  if (Number.isFinite(note.velocity) === false || note.velocity < 0 || note.velocity > MAX_VELOCITY) {
    issues.push(`${path}.velocity must be in [0, ${MAX_VELOCITY}]`);
  }
  if (note.voiceId !== voiceId) {
    issues.push(`${path}.voiceId must match parent voice`);
  }
  if (note.trackId !== trackId) {
    issues.push(`${path}.trackId must match parent track`);
  }
  return issues;
}

function validateChord(chord: ChordEvent, path: string, voiceId: string, trackId: string): string[] {
  const issues: string[] = [];
  if (isValidId(chord.id) === false) {
    issues.push(`${path}.id must be a non-empty string`);
  }
  if (chord.type !== 'chord') {
    issues.push(`${path}.type must be "chord"`);
  }
  if (isNonNegativeTick(chord.startTick) === false) {
    issues.push(`${path}.startTick must be non-negative`);
  }
  if (chord.notes.length === 0) {
    issues.push(`${path}.notes must not be empty`);
  }
  for (let i = 0; i < chord.notes.length; i += 1) {
    const note = chord.notes[i];
    if (Number.isInteger(note.midi) === false || note.midi < MIN_MIDI || note.midi > MAX_MIDI) {
      issues.push(`${path}.notes[${i}].midi must be in [${MIN_MIDI}, ${MAX_MIDI}]`);
    }
    if (isPositiveTick(note.durationTicks) === false) {
      issues.push(`${path}.notes[${i}].durationTicks must be positive`);
    }
    if (Number.isFinite(note.velocity) === false || note.velocity < 0 || note.velocity > MAX_VELOCITY) {
      issues.push(`${path}.notes[${i}].velocity must be in [0, ${MAX_VELOCITY}]`);
    }
  }
  if (chord.voiceId !== voiceId) {
    issues.push(`${path}.voiceId must match parent voice`);
  }
  if (chord.trackId !== trackId) {
    issues.push(`${path}.trackId must match parent track`);
  }
  return issues;
}

function validatePedal(pedal: PedalEvent, path: string, voiceId: string, trackId: string): string[] {
  const issues: string[] = [];
  if (isValidId(pedal.id) === false) {
    issues.push(`${path}.id must be a non-empty string`);
  }
  if (pedal.type !== 'pedal') {
    issues.push(`${path}.type must be "pedal"`);
  }
  if (isNonNegativeTick(pedal.startTick) === false) {
    issues.push(`${path}.startTick must be non-negative`);
  }
  if (BigInt(pedal.endTick) <= BigInt(pedal.startTick)) {
    issues.push(`${path}.endTick must be greater than startTick`);
  }
  if (Number.isFinite(pedal.value) === false || pedal.value < 0 || pedal.value > 1) {
    issues.push(`${path}.value must be in [0, 1]`);
  }
  if (pedal.voiceId !== voiceId) {
    issues.push(`${path}.voiceId must match parent voice`);
  }
  if (pedal.trackId !== trackId) {
    issues.push(`${path}.trackId must match parent track`);
  }
  return issues;
}

function validateRest(rest: RestEvent, path: string, voiceId: string, trackId: string): string[] {
  const issues: string[] = [];
  if (isValidId(rest.id) === false) {
    issues.push(`${path}.id must be a non-empty string`);
  }
  if (rest.type !== 'rest') {
    issues.push(`${path}.type must be "rest"`);
  }
  if (isNonNegativeTick(rest.startTick) === false) {
    issues.push(`${path}.startTick must be non-negative`);
  }
  if (isPositiveTick(rest.durationTicks) === false) {
    issues.push(`${path}.durationTicks must be positive`);
  }
  if (rest.voiceId !== voiceId) {
    issues.push(`${path}.voiceId must match parent voice`);
  }
  if (rest.trackId !== trackId) {
    issues.push(`${path}.trackId must match parent track`);
  }
  return issues;
}

/**
 * The enclosing tuplet's musical extent. Child events are expressed in the
 * tuplet's local timebase: `actual` notes occupy the same parent duration as
 * `normal` notes, so the local container is `durationTicks * actual / normal`
 * long. Bounds are compared with cross multiplication to stay integral.
 */
interface TupletContainer {
  durationTicks: Tick;
  actual: number;
  normal: number;
}

function extendsPastLocalContainer(
  endTick: Tick,
  container: TupletContainer,
): boolean {
  const end = BigInt(endTick);
  const containerDuration = BigInt(container.durationTicks);
  const normal = BigInt(container.normal);
  const actual = BigInt(container.actual);
  // end <= durationTicks * actual / normal  <=>  end * normal <= durationTicks * actual
  return end * normal > containerDuration * actual;
}

function validateTuplet(
  tuplet: TupletEvent,
  path: string,
  voiceId: string,
  trackId: string,
  container?: TupletContainer,
): string[] {
  const issues: string[] = [];
  if (isValidId(tuplet.id) === false) {
    issues.push(`${path}.id must be a non-empty string`);
  }
  if (tuplet.type !== 'tuplet') {
    issues.push(`${path}.type must be "tuplet"`);
  }
  if (Number.isInteger(tuplet.actual) === false || tuplet.actual <= 0) {
    issues.push(`${path}.actual must be a positive integer`);
  }
  if (Number.isInteger(tuplet.normal) === false || tuplet.normal <= 0) {
    issues.push(`${path}.normal must be a positive integer`);
  }
  if (isNonNegativeTick(tuplet.startTick) === false) {
    issues.push(`${path}.startTick must be non-negative`);
  }
  if (isPositiveTick(tuplet.durationTicks) === false) {
    issues.push(`${path}.durationTicks must be positive`);
  }
  // A nested tuplet is measured against the enclosing tuplet's declared parent
  // duration (its local extent is larger by actual / normal).
  if (container !== undefined
    && BigInt(tuplet.startTick) + BigInt(tuplet.durationTicks) > BigInt(container.durationTicks)) {
    issues.push(`${path} extends past its tuplet container`);
  }
  const childContainer: TupletContainer = {
    durationTicks: tuplet.durationTicks,
    actual: tuplet.actual,
    normal: tuplet.normal,
  };
  for (let i = 0; i < tuplet.events.length; i += 1) {
    const childIssues = validateMusicEvent(
      tuplet.events[i],
      `${path}.events[${i}]`,
      voiceId,
      trackId,
      childContainer,
    );
    issues.push(...childIssues);
  }
  return issues;
}

function validateMusicEvent(
  event: MusicEvent,
  path: string,
  voiceId: string,
  trackId: string,
  container?: TupletContainer,
): string[] {
  if (event.type === 'note') {
    const issues = validateNote(event, path, voiceId, trackId);
    if (container !== undefined
      && extendsPastLocalContainer(BigInt(event.startTick) + BigInt(event.durationTicks), container)) {
      issues.push(`${path} extends past its tuplet container`);
    }
    return issues;
  }
  if (event.type === 'chord') {
    const issues = validateChord(event, path, voiceId, trackId);
    if (container !== undefined) {
      for (let i = 0; i < event.notes.length; i += 1) {
        if (extendsPastLocalContainer(BigInt(event.startTick) + BigInt(event.notes[i].durationTicks), container)) {
          issues.push(`${path}.notes[${i}] extends past its tuplet container`);
        }
      }
    }
    return issues;
  }
  if (event.type === 'pedal') {
    const issues = validatePedal(event, path, voiceId, trackId);
    if (container !== undefined && extendsPastLocalContainer(event.endTick, container)) {
      issues.push(`${path} extends past its tuplet container`);
    }
    return issues;
  }
  if (event.type === 'rest') {
    const issues = validateRest(event, path, voiceId, trackId);
    if (container !== undefined
      && extendsPastLocalContainer(BigInt(event.startTick) + BigInt(event.durationTicks), container)) {
      issues.push(`${path} extends past its tuplet container`);
    }
    return issues;
  }
  if (event.type === 'tuplet') {
    return validateTuplet(event, path, voiceId, trackId, container);
  }
  return [`${path} has unknown event type`];
}

export function validateScore(score: Score): void {
  const issues: string[] = [];
  const eventIds = new Set<string>();

  const validateEventIds = (events: readonly MusicEvent[], path: string): void => {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const eventPath = `${path}[${index}]`;
      if (isValidId(event.id)) {
        if (eventIds.has(event.id)) {
          issues.push(`${eventPath}.id must be unique across the score`);
        }
        eventIds.add(event.id);
      }
      if (event.type === 'tuplet') {
        validateEventIds(event.events, `${eventPath}.events`);
      }
    }
  };

  // Performance events derive their ids from raw event ids. A raw id that is a
  // prefix of another event's derived ids (or two events deriving the same id)
  // would make playback and visual state ambiguous after expansion.
  const derivedIds = new Set<string>();
  const checkDerivedId = (id: string): void => {
    if (eventIds.has(id) || derivedIds.has(id)) {
      issues.push(`derived performance event id ${id} must be unique across the score`);
      return;
    }
    derivedIds.add(id);
  };
  const validateDerivedIds = (events: readonly MusicEvent[], prefix: string): void => {
    for (const event of events) {
      const id = `${prefix}${event.id}`;
      if (event.type === 'note') {
        checkDerivedId(`${id}:on`);
        checkDerivedId(`${id}:off`);
      } else if (event.type === 'chord') {
        event.notes.forEach((_, index) => {
          checkDerivedId(`${id}:${index}:on`);
          checkDerivedId(`${id}:${index}:off`);
        });
      } else if (event.type === 'pedal') {
        checkDerivedId(`${id}:down`);
        checkDerivedId(`${id}:up`);
      } else if (event.type === 'tuplet') {
        validateDerivedIds(event.events, `${id}:`);
      }
    }
  };

  if (isValidId(score.id) === false) {
    issues.push('score.id must be a non-empty string');
  }
  if (typeof score.title !== 'string') {
    issues.push('score.title must be a string');
  }
  if (Number.isInteger(score.ppq) === false || score.ppq <= 0) {
    issues.push('score.ppq must be a positive integer');
  }

  issues.push(...validateTempoMap(score.tempoMap));
  issues.push(...validateTimeSignatureMap(score.timeSignatureMap ?? []));

  const trackIds = new Set<string>();
  const allVoiceEvents: MusicEvent[][] = [];
  for (let t = 0; t < score.tracks.length; t += 1) {
    const track = score.tracks[t];
    const trackPath = `tracks[${t}]`;
    if (isValidId(track.id) === false) {
      issues.push(`${trackPath}.id must be a non-empty string`);
    } else if (trackIds.has(track.id)) {
      issues.push(`${trackPath}.id must be unique`);
    }
    trackIds.add(track.id);
    if (track.instrument === undefined || isValidId(track.instrument.id) === false) {
      issues.push(`${trackPath}.instrument.id must be a non-empty string`);
    }
    if (track.channel !== undefined && (Number.isInteger(track.channel) === false || track.channel < 0 || track.channel > 15)) {
      issues.push(`${trackPath}.channel must be an integer in [0, 15]`);
    }

    const voiceIds = new Set<string>();
    for (let v = 0; v < track.voices.length; v += 1) {
      const voice = track.voices[v];
      const voicePath = `${trackPath}.voices[${v}]`;
      if (isValidId(voice.id) === false) {
        issues.push(`${voicePath}.id must be a non-empty string`);
      } else if (voiceIds.has(voice.id)) {
        issues.push(`${voicePath}.id must be unique within the track`);
      }
      voiceIds.add(voice.id);
      for (let e = 0; e < voice.events.length; e += 1) {
        issues.push(...validateMusicEvent(voice.events[e], `${voicePath}.events[${e}]`, voice.id, track.id));
      }
      validateEventIds(voice.events, `${voicePath}.events`);
      allVoiceEvents.push(voice.events);
    }
  }
  // Derived ids are only meaningful once every raw event id in the score is
  // known, so this runs after all voices have been scanned.
  for (const events of allVoiceEvents) {
    validateDerivedIds(events, '');
  }

  if (issues.length > 0) {
    throw new ScoreValidationError(issues);
  }
}
