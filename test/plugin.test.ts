import { describe, expect, it } from 'vitest';
import { DEFAULT_PIANIST_CONFIG, mergeConfig, normalizeConfig } from '../src/plugin/config.js';

describe('browser module boundaries', () => {
  it('allows the browser view module to be loaded by the Node Host entry', async () => {
    await expect(import('../src/plugin/view.js')).resolves.toHaveProperty('registerDshPianoView');
  });
});

describe('plugin config', () => {
  it('uses stable defaults', () => {
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_PIANIST_CONFIG);
    expect(DEFAULT_PIANIST_CONFIG.events.notes).toBe(true);
    expect(DEFAULT_PIANIST_CONFIG.events.pedal).toBe(true);
    expect(DEFAULT_PIANIST_CONFIG.events.tempo).toBe(true);
    expect(DEFAULT_PIANIST_CONFIG.events.particles).toBe(false);
    // The audio source is fixed to the sample pack; it is no longer a setting.
    expect(DEFAULT_PIANIST_CONFIG).not.toHaveProperty('audioSource');
    expect(DEFAULT_PIANIST_CONFIG).not.toHaveProperty('showKeyboard');
  });

  it('migrates legacy/partial payloads to the current shape', () => {
    const config = normalizeConfig({ volume: 0.3 });
    expect(config.volume).toBe(0.3);
    expect(config.visualQuality).toBe('medium');
    expect(config.events).toEqual(DEFAULT_PIANIST_CONFIG.events);
  });

  it('clamps volume and ignores unknown fields without erasing new defaults', () => {
    const config = normalizeConfig({ volume: 3, unknownFutureField: true });
    expect(config.volume).toBe(1);
    expect(config.enabled).toBe(true);
  });

  it('mergeConfig preserves nested event defaults', () => {
    const merged = mergeConfig(DEFAULT_PIANIST_CONFIG, { volume: 0.4, events: { notes: false } });
    expect(merged.volume).toBe(0.4);
    expect(merged.events.notes).toBe(false);
    expect(merged.events.pedal).toBe(true);
  });
});
