import { randomUUID } from 'node:crypto';
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import {
  PIANO_TOOL_NAME,
  compilePianoPerformance,
  type PianoToolResult,
} from '../shared/piano-tool.js';

export const PIANO_PRESENTATION_META_MAX_BYTES = 512 * 1024;

function presentationMeta(result: PianoToolResult): JsonValue {
  const meta = { kind: 'dsh-pianist-performance', ...result } as const;
  const bytes = Buffer.byteLength(JSON.stringify(meta), 'utf8');
  if (bytes > PIANO_PRESENTATION_META_MAX_BYTES) {
    throw new RangeError(
      `piano performance metadata exceeds ${String(PIANO_PRESENTATION_META_MAX_BYTES)} UTF-8 bytes`,
    );
  }
  return meta as unknown as JsonValue;
}

const beatSchema = {
  oneOf: [
    { type: 'number' as const },
    { type: 'string' as const },
  ],
  description: 'Absolute quarter-note beats from the beginning. Fractions such as "1/3" and "3/2" are accepted.',
} as const;

const pitchSchema = {
  oneOf: [
    { type: 'integer' as const },
    { type: 'string' as const },
  ],
  description: 'One piano pitch as MIDI 21-108 or scientific pitch notation (C4=60; examples: F#4, Bb3).',
} as const;

export const PIANO_PERFORM_PARAMETERS = {
  title: {
    type: 'string',
    required: true,
    description: 'Short title for the performance shown to the user.',
  },
  bpm: {
    type: 'number',
    required: true,
    description: 'Initial tempo in quarter-note beats per minute, from 20 through 400.',
  },
  notes: {
    type: 'array',
    required: true,
    description: 'Absolute note groups transcribed from the score. For long passages prefer compact {p,s,d,h,v}: p=pitch or chord pitches, s=startBeat, d=durationBeats, h=l/r, v=velocity. The verbose form remains accepted.',
    items: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            pitches: {
              type: 'array',
              required: true,
              items: pitchSchema,
              description: 'One pitch for a note or multiple simultaneous pitches for a chord.',
            },
            startBeat: { ...beatSchema, required: true },
            durationBeats: {
              ...beatSchema,
              required: true,
              description: 'Sounding duration in quarter-note beats; must be greater than zero.',
            },
            hand: {
              type: 'string',
              enum: ['left', 'right'],
              description: 'Piano hand/part. Defaults to right when omitted.',
            },
            velocity: {
              type: 'number',
              description: 'Key velocity from 0 through 1. Defaults to 0.8; use it for written dynamics and accents.',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            p: {
              oneOf: [
                { type: 'integer' as const },
                { type: 'string' as const },
                { type: 'array' as const, items: pitchSchema },
              ],
              required: true,
              description: 'Compact pitch: one pitch or an array for a chord.',
            },
            s: { ...beatSchema, required: true, description: 'Compact absolute startBeat.' },
            d: { ...beatSchema, required: true, description: 'Compact durationBeats.' },
            h: { type: 'string', enum: ['l', 'r'], description: 'Compact hand: l=left, r=right.' },
            v: { type: 'number', description: 'Compact velocity from 0 through 1.' },
          },
        },
      ],
    },
  },
  timeSignature: {
    type: 'object',
    additionalProperties: false,
    description: 'Written meter. Defaults to 4/4.',
    properties: {
      numerator: { type: 'integer', required: true },
      denominator: {
        type: 'integer',
        required: true,
        description: 'Power-of-two beat denominator such as 2, 4, 8, or 16.',
      },
    },
  },
  pedals: {
    type: 'array',
    description: 'Sustain-pedal spans. Omit when the score has no pedal markings.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        startBeat: { ...beatSchema, required: true },
        endBeat: { ...beatSchema, required: true },
        value: {
          type: 'number',
          description: 'Pedal depth from 0 through 1. Defaults to fully down (1).',
        },
      },
    },
  },
  tempoChanges: {
    type: 'array',
    description: 'Tempo changes after beat zero. The initial tempo belongs in bpm.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        beat: { ...beatSchema, required: true },
        bpm: { type: 'number', required: true },
      },
    },
  },
  autoplay: {
    type: 'boolean',
    description: 'Attempt playback when the result first appears. Defaults to true; browser audio policy may still require the user to press Play.',
  },
} as const satisfies ParameterSchemaSpec;

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', required: true },
    performanceId: { type: 'string', required: true },
    title: { type: 'string', required: true },
    noteCount: { type: 'integer', required: true },
    autoplay: { type: 'boolean', required: true },
      payload: {
        type: 'json',
        required: true,
        description: 'Versioned, JSON-safe canonical score and playback metadata.',
    },
  },
} as const;

type DshPianoToolValue = {
  version: number;
  performanceId: string;
  title: string;
  noteCount: number;
  autoplay: boolean;
  payload: JsonValue;
};

function asToolValue(result: PianoToolResult): DshPianoToolValue {
  return result as unknown as DshPianoToolValue;
}

export interface PianoPerformToolOptions {
  /** Publish a bounded live copy for Code Mode's metadata-free subcall view. */
  publish?(result: PianoToolResult): void;
}

/** The one model-facing piano tool; registration and Code Mode share this definition. */
export function createPianoPerformTool(options: PianoPerformToolOptions = {}) {
  return defineTool({
    name: PIANO_TOOL_NAME,
    description: [
      'Render and play a piano performance in the current DeepSeek Harness conversation.',
      'Use this when the user asks to play, audition, demonstrate, or hear piano music.',
      'Make one call for the complete passage. Transcribe it into zero-based absolute quarter-note beat positions and scientific pitch notation (C4=middle C) or MIDI 21-108.',
      'For long passages use compact note objects {p,s,d,h,v}; omit h/v when defaults apply.',
      'Preserve simultaneous notes as one chord, left/right hands, written durations, dynamics, sustain pedal, meter, and tempo changes.',
    ].join(' '),
    parameters: PIANO_PERFORM_PARAMETERS,
    output: {
      schema: outputSchema,
      render: (_args, value) => {
        const result = value as unknown as PianoToolResult;
        return [{
          type: 'text',
          text: `Prepared piano performance "${result.title}" (${result.noteCount} notes, ${result.payload.duration.toFixed(2)} seconds). Performance ID: ${result.performanceId}. The inline player may require the user to press Play before browser audio can start.`,
        }];
      },
      presentationMeta: (_args, value) => presentationMeta(value as unknown as PianoToolResult),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const result = compilePianoPerformance(args, `piano-${randomUUID()}`);
      presentationMeta(result);
      options.publish?.(result);
      return asToolValue(result);
    },
  });
}
