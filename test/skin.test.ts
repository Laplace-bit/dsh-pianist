import { describe, expect, it } from 'vitest';
import { PIANO_SKIN_IDS, PIANO_SKINS, resolvePianoSkin } from '../src/visual/skin.js';

describe('piano skins', () => {
  it('exposes every registered skin with a label and description', () => {
    for (const id of PIANO_SKIN_IDS) {
      expect(PIANO_SKINS[id].label.length).toBeGreaterThan(0);
      expect(PIANO_SKINS[id].description.length).toBeGreaterThan(0);
    }
  });

  it('defaults to the seaside family when no skin is set', () => {
    expect(resolvePianoSkin(undefined).id).toBe('seaside-glass');
  });

  it('falls back to the default family for unknown ids without throwing', () => {
    expect(resolvePianoSkin('does-not-exist').id).toBe('seaside-glass');
    expect(resolvePianoSkin('porcelain').id).toBe('lacquer-gold');
    expect(resolvePianoSkin('dawn').id).toBe('seaside-glass');
  });

  it('resolves every registered skin directly', () => {
    expect(resolvePianoSkin('lacquer-gold').id).toBe('lacquer-gold');
    expect(resolvePianoSkin('seaside-glass').id).toBe('seaside-glass');
  });

  it('exposes both selectable families in the single picker', () => {
    expect(PIANO_SKIN_IDS).toHaveLength(2);
    expect(PIANO_SKIN_IDS).toContain('lacquer-gold');
    expect(PIANO_SKIN_IDS).toContain('seaside-glass');
  });

  it('carries the reference-photo material details for both families', () => {
    // Lacquer gold: crimson felt runner above the keys, opaque black shell.
    const lacquer = PIANO_SKINS['lacquer-gold'];
    expect(lacquer.case.feltStrip).toMatch(/^#/);
    expect(lacquer.grand.transparent).toBe(false);
    expect(lacquer.atmosphere.notes).toBe(false);

    // Sakura pearl: opaque pearl-white shell over a blossom sky with drifting notes.
    const seaside = PIANO_SKINS['seaside-glass'];
    expect(seaside.case.feltStrip.length).toBeGreaterThan(0);
    expect(seaside.grand.transparent).toBe(false);
    expect(seaside.keyboardPerspective).toBe(true);
    expect(seaside.label).toContain('Sakura Pearl');
    expect(seaside.atmosphere.notes).toBe(true);
    expect(seaside.atmosphere.sand).toHaveLength(2);
  });

  it('keeps both immersive backdrops translucent and continuous below the piano', () => {
    for (const id of PIANO_SKIN_IDS) {
      const skin = PIANO_SKINS[id];
      for (const color of [skin.backdrop.top, skin.backdrop.mid, skin.backdrop.bottom]) {
        const alpha = Number(color.match(/rgba\([^)]*,\s*([\d.]+)\)$/)?.[1]);
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThan(0.8);
      }
      expect(skin.atmosphere.water.every(color => color.endsWith(',0)'))).toBe(true);
      expect(skin.atmosphere.sand.every(color => color.endsWith(',0)'))).toBe(true);
    }
  });
});
