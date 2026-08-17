import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIANIST_CONFIG,
  normalizeConfig,
  mergeConfig,
} from '../src/plugin/config.js';
import {
  DEFAULT_PIANIST_SETTINGS,
  isPianistSettings,
  mergePianistSettings,
  normalizePianistSettings,
  parsePianistSettingsPatch,
} from '../src/shared/pianist-settings.js';

describe('render-mode settings', () => {
  it('defaults to immersive so legacy profiles upgrade to the new mode', () => {
    expect(DEFAULT_PIANIST_CONFIG.renderMode).toBe('immersive');
    expect(DEFAULT_PIANIST_SETTINGS.renderMode).toBe('immersive');
    expect(DEFAULT_PIANIST_SETTINGS.skin).toBe('lacquer-gold');
    expect(DEFAULT_PIANIST_SETTINGS.returnToEmbeddedOnEnd).toBe(true);
  });

  it('keeps immersive when an old config never stored a renderMode field', () => {
    const legacy = {
      version: 1,
      enabled: true,
      visualQuality: 'medium',
      volume: 0.8,
      showWaterfall: true,
      events: { notes: true, pedal: true, tempo: true, particles: false },
    };
    expect(normalizeConfig(legacy).renderMode).toBe('immersive');
    expect(normalizePianistSettings(legacy).renderMode).toBe('immersive');
  });

  it('accepts an explicit embedded override and rejects invalid modes', () => {
    expect(normalizeConfig({ renderMode: 'embedded' }).renderMode).toBe('embedded');
    expect(normalizeConfig({ renderMode: 'holographic' }).renderMode).toBe('immersive');
    expect(normalizeConfig({ returnToEmbeddedOnEnd: false }).returnToEmbeddedOnEnd).toBe(false);
  });

  it('uses a single shared skin and migrates legacy per-mode selections', () => {
    expect(normalizeConfig({ skin: 'seaside-glass' })).toMatchObject({ skin: 'seaside-glass' });
    // Legacy aliases canonicalize into the shared family ids.
    expect(normalizeConfig({ skin: 'moonlit' })).toMatchObject({ skin: 'seaside-glass' });
    // Legacy per-mode configs collapse into the single skin, preferring the chat value.
    expect(normalizeConfig({ embeddedSkin: 'lacquer-gold', immersiveSkin: 'seaside-glass' })).toMatchObject({ skin: 'lacquer-gold' });
    expect(normalizeConfig({ embeddedSkin: 'moonlit' })).toMatchObject({ skin: 'seaside-glass' });
    expect(normalizeConfig({ immersiveSkin: 'porcelain' })).toMatchObject({ skin: 'lacquer-gold' });
    expect(parsePianistSettingsPatch({ skin: 'lacquer-gold' })).toEqual({ skin: 'lacquer-gold' });
    expect(parsePianistSettingsPatch({ skin: 'moonlit' })).toBeUndefined();
  });

  it('persists render-mode patches and keeps the settings schema strict', () => {
    const patch = parsePianistSettingsPatch({ renderMode: 'embedded', returnToEmbeddedOnEnd: false });
    expect(patch).toEqual({ renderMode: 'embedded', returnToEmbeddedOnEnd: false });

    const merged = mergePianistSettings(DEFAULT_PIANIST_SETTINGS, patch!);
    expect(merged.renderMode).toBe('embedded');
    expect(merged.returnToEmbeddedOnEnd).toBe(false);
    expect(merged.visualQuality).toBe('medium');

    // Unknown or malformed modes are never accepted.
    expect(parsePianistSettingsPatch({ renderMode: 'neon' })).toBeUndefined();
    expect(parsePianistSettingsPatch({ returnToEmbeddedOnEnd: 'yes' })).toBeUndefined();
  });

  it('persists the shared skin in a complete Host-valid settings object', () => {
    const merged = mergePianistSettings(DEFAULT_PIANIST_SETTINGS, {
      skin: 'seaside-glass',
    });
    expect(merged.skin).toBe('seaside-glass');
    expect(isPianistSettings(merged)).toBe(true);
  });

  it('exposes render mode as part of a complete Host-valid settings object', () => {
    expect(DEFAULT_PIANIST_SETTINGS.renderMode).toBe('immersive');
    expect(isPianistSettings(DEFAULT_PIANIST_SETTINGS)).toBe(true);
    // Dropping either new key breaks strict profile validation.
    const missing = { ...DEFAULT_PIANIST_SETTINGS };
    delete (missing as { renderMode?: string }).renderMode;
    expect(isPianistSettings(missing)).toBe(false);
  });

  it('mergeConfig preserves render mode through unrelated patches', () => {
    const next = mergeConfig(DEFAULT_PIANIST_CONFIG, { volume: 0.33 });
    expect(next.renderMode).toBe('immersive');
  });
});
