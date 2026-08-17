import {
  DEFAULT_PIANIST_CONFIG,
  mergeConfig,
  normalizeConfig,
  type PianistConfig,
  type PianistEventSettings,
  type PianistRenderMode,
} from '../plugin/config.js';

/** Durable profile namespace owned by the production DSH Host entry. */
export const PIANIST_SETTINGS_NS = 'pianist';

/** User-editable settings. The schema version remains an implementation detail. */
export type PianistSettings = Omit<PianistConfig, 'version'>;

/** A sparse browser mutation, merged by the Host into the durable namespace. */
export type PianistSettingsPatch = Partial<Omit<PianistSettings, 'events'>> & {
  events?: Partial<PianistEventSettings>;
};

export const DEFAULT_PIANIST_SETTINGS: Readonly<PianistSettings> = Object.freeze(settingsFromConfig(DEFAULT_PIANIST_CONFIG));

const SETTING_KEYS = new Set<keyof PianistSettings>([
  'enabled',
  'renderMode',
  'skin',
  'returnToEmbeddedOnEnd',
  'visualQuality',
  'volume',
  'showWaterfall',
  'events',
]);

const EVENT_KEYS = new Set<keyof PianistEventSettings>(['notes', 'pedal', 'tempo', 'particles']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

/** Remove the internal schema marker before sending settings across the RPC boundary. */
export function settingsFromConfig(config: PianistConfig): PianistSettings {
  const { version: _version, ...settings } = config;
  return structuredClone(settings);
}

/** Normalize legacy or partial stored values without exposing the schema marker. */
export function normalizePianistSettings(value: unknown): PianistSettings {
  return settingsFromConfig(normalizeConfig(value));
}

/** Apply a sparse settings mutation while preserving defaults for old stored shapes. */
export function mergePianistSettings(current: PianistSettings, patch: PianistSettingsPatch): PianistSettings {
  return settingsFromConfig(mergeConfig({ version: 1, ...current }, patch));
}

/** Validate the narrow Host mutation surface; unknown keys are never persisted. */
export function parsePianistSettingsPatch(value: unknown): PianistSettingsPatch | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(key => !SETTING_KEYS.has(key as keyof PianistSettings))) return undefined;

  const patch: PianistSettingsPatch = {};
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') return undefined;
    patch.enabled = value.enabled;
  }
  if ('visualQuality' in value) {
    if (value.visualQuality !== 'low' && value.visualQuality !== 'medium' && value.visualQuality !== 'high') return undefined;
    patch.visualQuality = value.visualQuality;
  }
  if ('volume' in value) {
    if (typeof value.volume !== 'number' || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) return undefined;
    patch.volume = value.volume;
  }
  if ('showWaterfall' in value) {
    if (typeof value.showWaterfall !== 'boolean') return undefined;
    patch.showWaterfall = value.showWaterfall;
  }
  if ('renderMode' in value) {
    if (value.renderMode !== 'immersive' && value.renderMode !== 'embedded') return undefined;
    patch.renderMode = value.renderMode;
  }
  if ('skin' in value) {
    if (typeof value.skin !== 'string') return undefined;
    const skin = normalizePianistSettings({ skin: value.skin }).skin;
    if (skin !== value.skin) return undefined;
    patch.skin = skin;
  }
  if ('returnToEmbeddedOnEnd' in value) {
    if (typeof value.returnToEmbeddedOnEnd !== 'boolean') return undefined;
    patch.returnToEmbeddedOnEnd = value.returnToEmbeddedOnEnd;
  }
  if ('events' in value) {
    if (!isRecord(value.events)) return undefined;
    const eventKeys = Object.keys(value.events);
    if (eventKeys.length === 0 || eventKeys.some(key => !EVENT_KEYS.has(key as keyof PianistEventSettings))) return undefined;
    const events: Partial<PianistEventSettings> = {};
    for (const key of eventKeys as Array<keyof PianistEventSettings>) {
      if (typeof value.events[key] !== 'boolean') return undefined;
      events[key] = value.events[key] as boolean;
    }
    patch.events = events;
  }
  return patch;
}

/** Strictly validate a complete Host response before a browser card consumes it. */
export function isPianistSettings(value: unknown): value is PianistSettings {
  if (!isRecord(value) || Object.keys(value).length !== SETTING_KEYS.size) return false;
  const patch = parsePianistSettingsPatch(value);
  return patch !== undefined
    && Object.keys(patch).length === SETTING_KEYS.size
    && patch.events !== undefined
    && Object.keys(patch.events).length === EVENT_KEYS.size;
}
