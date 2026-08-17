// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PianoKeyInputController, glissandoVelocityFactor, type PianoKeyInputCallbacks } from '../src/visual/key-input.js';

function pointerEvent(
  type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'lostpointercapture' | 'pointermove',
  init: { pointerId: number; clientX?: number; clientY?: number; button?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    button: { value: init.button ?? 0 },
  });
  return event;
}

function keyEvent(type: 'keydown' | 'keyup', key: string, repeat = false): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { key: { value: key }, repeat: { value: repeat } });
  return event;
}

interface Harness {
  surface: HTMLDivElement;
  controller: PianoKeyInputController;
  counters: {
    presses: Array<{ id: string; midi: number; source: string; velocity: number | undefined }>;
    releases: string[];
    releasedAll: number;
    selections: number[];
  };
}

function harness(options: { canInput?: boolean; clock?: () => number } = {}): Harness {
  const surface = document.createElement('div');
  document.body.appendChild(surface);
  const counters = {
    presses: [] as Array<{ id: string; midi: number; source: string; velocity: number | undefined }>,
    releases: [] as string[],
    releasedAll: 0,
    selections: [] as number[],
  };
  let selected = 60;
  const callbacks: PianoKeyInputCallbacks = {
    canInput: () => options.canInput ?? true,
    keyAtPoint: (x: number) => (x < 50 ? 48 : x < 100 ? 60 : undefined),
    selection: {
      get: () => selected,
      set: (midi: number) => {
        if (midi === selected) return;
        selected = midi;
        counters.selections.push(midi);
      },
      min: 21,
      max: 108,
    },
    press: (id: string, midi: number, source: string, velocity?: number) => { counters.presses.push({ id, midi, source, velocity }); },
    release: (id: string) => { counters.releases.push(id); },
    releaseAll: () => { counters.releasedAll += 1; },
  };
  const controller = new PianoKeyInputController({ element: surface }, callbacks, options.clock);
  controller.attach();
  return { surface, controller, counters };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('PianoKeyInputController', () => {
  it('presses on pointer down and releases the same logical input on pointer up', () => {
    const t = harness();
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3, clientX: 40 }));
    expect(t.counters.presses).toEqual([{ id: 'pointer:3', midi: 48, source: 'pointer', velocity: undefined }]);
    expect(t.counters.selections).toEqual([48]);

    t.surface.dispatchEvent(pointerEvent('pointerup', { pointerId: 3 }));
    expect(t.counters.releases).toEqual(['pointer:3']);
  });

  it('tracks multiple pointers independently and survives pointercancel', () => {
    const t = harness();
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 10 }));
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 70 }));
    expect(t.counters.presses.map(press => press.id)).toEqual(['pointer:1', 'pointer:2']);

    t.surface.dispatchEvent(pointerEvent('pointercancel', { pointerId: 1 }));
    expect(t.counters.releases).toEqual(['pointer:1']);
    t.surface.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: 2 }));
    expect(t.counters.releases).toEqual(['pointer:1', 'pointer:2']);
  });

  it('moves the accessibility selection with arrows and Home/End', () => {
    const t = harness();
    t.surface.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));
    expect(t.counters.selections).toEqual([59]);
    t.surface.dispatchEvent(keyEvent('keydown', 'ArrowRight'));
    expect(t.counters.selections).toEqual([59, 60]);
    t.surface.dispatchEvent(keyEvent('keydown', 'Home'));
    expect(t.counters.selections).toEqual([59, 60, 21]);
    t.surface.dispatchEvent(keyEvent('keydown', 'End'));
    expect(t.counters.selections).toEqual([59, 60, 21, 108]);
    expect(t.counters.presses).toHaveLength(0);
  });

  it('sounds the selected key via Space and stops on keyup, ignoring repeats', () => {
    const t = harness();
    t.surface.dispatchEvent(keyEvent('keydown', ' ', true));
    expect(t.counters.presses).toHaveLength(0);

    t.surface.dispatchEvent(keyEvent('keydown', ' '));
    expect(t.counters.presses).toEqual([{ id: 'keyboard', midi: 60, source: 'keyboard', velocity: undefined }]);
    t.surface.dispatchEvent(keyEvent('keyup', ' '));
    expect(t.counters.releases).toEqual(['keyboard']);
  });

  it('releases everything when the surface blurs or detaches', () => {
    const t = harness();
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, clientX: 40 }));
    t.surface.dispatchEvent(new Event('blur'));
    expect(t.counters.releasedAll).toBe(1);
    expect(t.controller.activeInputs).toHaveLength(0);

    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 10, clientX: 40 }));
    t.controller.detach();
    expect(t.counters.releasedAll).toBe(1);
    expect(t.controller.activeInputs).toHaveLength(0);
    expect(() => t.surface.dispatchEvent(pointerEvent('pointerup', { pointerId: 10 }))).not.toThrow();
  });

  it('ignores every gesture while canInput is false', () => {
    const t = harness({ canInput: false });
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 5, clientX: 40 }));
    t.surface.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));
    t.surface.dispatchEvent(keyEvent('keydown', 'Enter'));
    expect(t.counters.presses).toHaveLength(0);
    expect(t.counters.selections).toHaveLength(0);
  });

  it('does not press when the point misses the keyboard', () => {
    const t = harness();
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, clientX: 120 }));
    expect(t.counters.presses).toHaveLength(0);
  });

  it('glissando: sliding onto a different key releases and re-sounds per key crossed', () => {
    let now = 1000;
    const t = harness({ clock: () => now });
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 4, clientX: 20 }));
    expect(t.counters.presses).toEqual([{ id: 'pointer:4', midi: 48, source: 'pointer', velocity: undefined }]);

    // Drift within the same key must not retrigger.
    now += 10;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 4, clientX: 35 }));
    expect(t.counters.presses).toHaveLength(1);
    expect(t.counters.releases).toHaveLength(0);

    // Crossing onto the neighbouring key sounds it (12 semitones in 10ms → speed=1.2 → velocity 0.4).
    now += 10;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 4, clientX: 70 }));
    expect(t.counters.releases).toEqual(['pointer:4']);
    expect(t.counters.presses).toEqual([
      { id: 'pointer:4', midi: 48, source: 'pointer', velocity: undefined },
      { id: 'pointer:4', midi: 60, source: 'pointer', velocity: 0.4 },
    ]);

    // Leaving the keyboard entirely holds nothing new and stays silent.
    now += 10;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 4, clientX: 140 }));
    expect(t.counters.presses).toHaveLength(2);
    expect(t.counters.releases).toHaveLength(1);

    // Re-entering a key glissandos again; pointer up ends the voice.
    now += 10;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 4, clientX: 30 }));
    expect(t.counters.presses).toHaveLength(3);
    expect(t.counters.presses[2]!.midi).toBe(48);
    expect(t.counters.presses[2]!.velocity).toBe(0.4);
    expect(t.counters.releases).toEqual(['pointer:4', 'pointer:4']);
    t.surface.dispatchEvent(pointerEvent('pointerup', { pointerId: 4 }));
    expect(t.counters.releases).toEqual(['pointer:4', 'pointer:4', 'pointer:4']);
    expect(t.controller.activeInputs).toHaveLength(0);
  });

  it('ignores pointermove for inputs that are not held down', () => {
    const t = harness();
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 6, clientX: 70 }));
    expect(t.counters.presses).toHaveLength(0);
    expect(t.counters.releases).toHaveLength(0);
  });

  it('glissando velocity: fast slide produces lower velocity', () => {
    let now = 1000;
    const t = harness({ clock: () => now });
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 5, clientX: 20 }));
    expect(t.counters.presses[0]!.velocity).toBeUndefined();

    // Simulate fast slide: 12 semitones in 50ms → speed = 0.24 → velocity ~0.4
    now += 50;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 5, clientX: 70 }));
    expect(t.counters.presses[1]!.velocity).toBe(0.4);
  });

  it('glissando velocity: slow slide preserves full velocity', () => {
    let now = 1000;
    const t = harness({ clock: () => now });
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 6, clientX: 20 }));

    // Simulate slow slide: 12 semitones in 400ms → speed = 0.03 → velocity = 1
    now += 400;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 6, clientX: 70 }));
    expect(t.counters.presses[1]!.velocity).toBe(1);
  });

  it('glissando throttle: events closer than 4ms are suppressed', () => {
    let now = 1000;
    const t = harness({ clock: () => now });
    t.surface.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, clientX: 20 }));
    expect(t.counters.presses).toHaveLength(1);

    // 2ms later — below throttle threshold, event is swallowed
    now += 2;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 70 }));
    expect(t.counters.presses).toHaveLength(1);

    // 6ms later (total 8ms from pointerdown) — throttle passes, event fires
    // clientX=70 → midi=60 (different key than heldMidi=48), so the key-crossing path runs
    now += 6;
    t.surface.dispatchEvent(pointerEvent('pointermove', { pointerId: 7, clientX: 70 }));
    expect(t.counters.presses).toHaveLength(2);
  });
});

describe('glissandoVelocityFactor', () => {
  it('returns 1 for zero or negative elapsed time', () => {
    expect(glissandoVelocityFactor(12, 0)).toBe(1);
    expect(glissandoVelocityFactor(12, -10)).toBe(1);
  });

  it('returns 1 for very slow slides (speed <= 0.04)', () => {
    // 1 semitone / 100ms = 0.01
    expect(glissandoVelocityFactor(1, 100)).toBe(1);
  });

  it('returns 0.4 for very fast slides (speed > 0.15)', () => {
    // 12 semitones / 50ms = 0.24
    expect(glissandoVelocityFactor(12, 50)).toBe(0.4);
  });

  it('interpolates linearly in the medium-speed range', () => {
    // speed = 0.095 → factor = 0.5 + 0.5 * (0.15 - 0.095) / 0.11 = 0.75
    expect(glissandoVelocityFactor(19, 200)).toBeCloseTo(0.75, 5);
  });
});
