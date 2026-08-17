import { PIANO_SKIN_IDS, type PianoSkinId } from '../visual/skin.js';

export type VisualQuality = 'low' | 'medium' | 'high';

/**
 * How a piano view presents its playing surface.
 *
 * - `immersive` (default): the piano floats over the host page on a fixed,
 *   full-viewport layer with water-like reactive visuals.
 * - `embedded`: the player rendered inline in the chat card.
 */
export type PianistRenderMode = 'immersive' | 'embedded';

export interface PianistEventSettings {
  notes: boolean;
  pedal: boolean;
  tempo: boolean;
  particles: boolean;
}

export interface PianistConfig {
  version: 1;
  enabled: boolean;
  renderMode: PianistRenderMode;
  /** Skin shared by both the inline chat player and the full-viewport immersive stage. */
  skin: PianoSkinId;
  returnToEmbeddedOnEnd: boolean;
  visualQuality: VisualQuality;
  volume: number;
  showWaterfall: boolean;
  events: PianistEventSettings;
}

export const DEFAULT_PIANIST_CONFIG: PianistConfig = {
  version: 1,
  enabled: true,
  renderMode: 'immersive',
  skin: 'lacquer-gold',
  returnToEmbeddedOnEnd: true,
  visualQuality: 'medium',
  volume: 0.8,
  showWaterfall: true,
  events: {
    notes: true,
    pedal: true,
    tempo: true,
    particles: false,
  },
};

const VISUAL_QUALITIES: VisualQuality[] = ['low', 'medium', 'high'];
const RENDER_MODES: PianistRenderMode[] = ['immersive', 'embedded'];

/** Keep legacy aliases valid while new selections use the two family ids. */
function canonicalSkinId(value: string): PianoSkinId | undefined {
  if (PIANO_SKIN_IDS.includes(value as PianoSkinId)) return value as PianoSkinId;
  if (value === 'porcelain' || value === 'celadon') return 'lacquer-gold';
  if (value === 'moonlit' || value === 'dawn') return 'seaside-glass';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

export function normalizeConfig(input: unknown): PianistConfig {
  const base = structuredClone(DEFAULT_PIANIST_CONFIG);
  if (isRecord(input) === false) {
    return base;
  }
  const result = { ...base };
  if (typeof input.enabled === 'boolean') {
    result.enabled = input.enabled;
  }
  if (typeof input.visualQuality === 'string' && VISUAL_QUALITIES.includes(input.visualQuality as VisualQuality)) {
    result.visualQuality = input.visualQuality as VisualQuality;
  }
  if (typeof input.volume === 'number' && Number.isFinite(input.volume)) {
    result.volume = Math.min(1, Math.max(0, input.volume));
  }
  if (typeof input.showWaterfall === 'boolean') {
    result.showWaterfall = input.showWaterfall;
  }
  // Legacy configs without a renderMode field default to immersive.
  if (typeof input.renderMode === 'string' && RENDER_MODES.includes(input.renderMode as PianistRenderMode)) {
    result.renderMode = input.renderMode as PianistRenderMode;
  }
  // A single skin is shared by both presentations. Legacy configs stored
  // separate embedded/immersive selections; the embedded (chat) value wins
  // when both exist so the most-visible surface keeps its look.
  if (typeof input.skin === 'string' && canonicalSkinId(input.skin) !== undefined) {
    result.skin = canonicalSkinId(input.skin)!;
  } else if (typeof input.embeddedSkin === 'string' && canonicalSkinId(input.embeddedSkin) !== undefined) {
    result.skin = canonicalSkinId(input.embeddedSkin)!;
  } else if (typeof input.immersiveSkin === 'string' && canonicalSkinId(input.immersiveSkin) !== undefined) {
    result.skin = canonicalSkinId(input.immersiveSkin)!;
  }
  if (typeof input.returnToEmbeddedOnEnd === 'boolean') {
    result.returnToEmbeddedOnEnd = input.returnToEmbeddedOnEnd;
  }
  if (isRecord(input.events)) {
    if (typeof input.events.notes === 'boolean') {
      result.events.notes = input.events.notes;
    }
    if (typeof input.events.pedal === 'boolean') {
      result.events.pedal = input.events.pedal;
    }
    if (typeof input.events.tempo === 'boolean') {
      result.events.tempo = input.events.tempo;
    }
    if (typeof input.events.particles === 'boolean') {
      result.events.particles = input.events.particles;
    }
  }
  return result;
}

export function mergeConfig(current: PianistConfig, patch: unknown): PianistConfig {
  const merged = {
    ...current,
    ...(isRecord(patch) ? patch : {}),
    events: {
      ...current.events,
      ...(isRecord(patch) && isRecord(patch.events) ? patch.events : {}),
    },
  };
  return normalizeConfig(merged);
}
