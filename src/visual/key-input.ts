/**
 * Reusable piano key input.
 *
 * Turns any element (a 2D canvas today, a WebGL/3D surface tomorrow) into a
 * playable keyboard: multi-touch pointer tracking with pointer capture,
 * arrow-key selection for accessibility, and Space/Enter to sound the
 * selected key. The controller knows nothing about audio or rendering — hosts
 * supply a hit-test plus press/release callbacks, so every skin and backend
 * shares one input path.
 */

export type PianoKeyInputSource = 'pointer' | 'keyboard';

/** Host-owned accessibility cursor over the key range. */
export interface PianoKeySelection {
  get(): number;
  set(midi: number): void;
  readonly min: number;
  readonly max: number;
}

export interface PianoKeyInputCallbacks {
  /** Gate every interaction (settings, disposal). */
  canInput(): boolean;
  /** Resolve a surface-space point to a playable midi number. */
  keyAtPoint(x: number, y: number): number | undefined;
  /** Accessibility selection cursor; arrow keys walk this range. */
  selection: PianoKeySelection;
  /**
   * A key went down for the given logical input id.
   * @param velocity  Optional velocity override (0–1) for glissando dynamics.
   *                  When omitted the host applies its default audition velocity.
   */
  press(id: string, midi: number, source: PianoKeyInputSource, velocity?: number): void;
  /** A held input came up. */
  release(id: string): void;
  /** Drop every active press (surface blur, teardown). */
  releaseAll(): void;
}

export interface PianoKeyInputSurface {
  readonly element: HTMLElement;
  /**
   * Bounds used when the surface reports zero size before layout (jsdom and
   * some embedding shells); a laid-out surface is always its own truth.
   */
  readonly fallbackBounds?: () => { left: number; top: number; width: number; height: number };
}

const KEYBOARD_INPUT_ID = 'keyboard';

/** Minimum milliseconds between consecutive glissando retrigger events. */
const GLISSANDO_THROTTLE_MS = 4;

/** Map a MIDI semitone delta to a velocity attenuation factor (0–1). */
export function glissandoVelocityFactor(midiDelta: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || midiDelta <= 0) return 1;
  const speed = midiDelta / elapsedMs;
  if (speed > 0.15) return 0.4;
  if (speed > 0.04) return 0.5 + 0.5 * (0.15 - speed) / 0.11;
  return 1;
}

export class PianoKeyInputController {
  private readonly active = new Set<string>();
  /** Last sounded key per held logical input, for glissando retriggering. */
  private readonly heldMidi = new Map<string, number>();
  /** Timestamp (ms) of last glissando retrigger, for throttle and velocity. */
  private readonly glissandoLastTime = new Map<string, number>();
  private readonly listeners: Array<readonly [string, EventListener]> = [];
  private attached = false;

  /** Clock source — injectable for deterministic tests. */
  private readonly nowMs: () => number;

  constructor(
    private readonly surface: PianoKeyInputSurface,
    private readonly callbacks: PianoKeyInputCallbacks,
    clock?: () => number,
  ) {
    this.nowMs = clock ?? (() => typeof performance !== 'undefined' ? performance.now() : 0);
  }

  /** Logical inputs currently held down (pointer ids + the keyboard slot). */
  get activeInputs(): readonly string[] {
    return [...this.active];
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const { element } = this.surface;
    this.listen(element, 'pointerdown', this.onPointerDown);
    this.listen(element, 'pointermove', this.onPointerMove);
    this.listen(element, 'pointerup', this.onPointerEnd);
    this.listen(element, 'pointercancel', this.onPointerEnd);
    this.listen(element, 'lostpointercapture', this.onPointerEnd);
    this.listen(element, 'keydown', this.onKeyDown);
    this.listen(element, 'keyup', this.onKeyUp);
    this.listen(element, 'blur', this.onBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const { element } = this.surface;
    for (const [type, listener] of this.listeners) {
      element.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
    this.active.clear();
    this.heldMidi.clear();
    this.glissandoLastTime.clear();
  }

  private listen(element: HTMLElement, type: string, listener: EventListener): void {
    element.addEventListener(type, listener);
    this.listeners.push([type, listener] as const);
  }

  private resolveKey(event: Event): number | undefined {
    if (!this.callbacks.canInput()) return undefined;
    const pointer = event as Partial<PointerEvent>;
    const clientX = pointer.clientX;
    const clientY = pointer.clientY;
    if (typeof clientX !== 'number' || typeof clientY !== 'number') return undefined;
    const rect = this.bounds();
    return this.callbacks.keyAtPoint(clientX - rect.left, clientY - rect.top);
  }

  private readonly onPointerDown = (event: Event): void => {
    const pointer = event as Partial<PointerEvent>;
    if (pointer.button !== 0 || !this.callbacks.canInput()) return;
    const rect = this.bounds();
    const clientX = pointer.clientX;
    const clientY = pointer.clientY;
    if (typeof clientX !== 'number' || typeof clientY !== 'number') return;
    const midi = this.callbacks.keyAtPoint(clientX - rect.left, clientY - rect.top);
    if (midi === undefined) return;
    event.preventDefault();
    this.callbacks.selection.set(midi);
    const element = this.surface.element;
    if (typeof element.focus === 'function') element.focus({ preventScroll: true });
    const pointerId = pointer.pointerId;
    if (typeof element.setPointerCapture === 'function' && typeof pointerId === 'number') {
      try { element.setPointerCapture(pointerId); } catch { /* unsupported pointer capture */ }
    }
    const inputId = `pointer:${String(pointerId)}`;
    if (this.active.has(inputId)) return;
    this.active.add(inputId);
    this.heldMidi.set(inputId, midi);
    this.glissandoLastTime.set(inputId, this.nowMs());
    this.callbacks.press(inputId, midi, 'pointer');
  };

  /**
   * Glissando: while an input is held, crossing onto a different key
   * releases the previous voice and sounds the new one. Moving within the
   * same key is a no-op, so ordinary presses never retrigger.
   *
   * Velocity scales with slide speed — fast sweeps are softer (0.4) while
   * slow deliberate glissandos keep full volume (1.0).
   * A 4 ms throttle prevents audio engine overload on high-frequency
   * touch pointermove events.
   */
  private readonly onPointerMove = (event: Event): void => {
    const pointerId = (event as Partial<PointerEvent>).pointerId;
    const inputId = `pointer:${String(pointerId)}`;
    if (!this.active.has(inputId)) return;
    const midi = this.resolveKey(event);
    if (midi === undefined || midi === this.heldMidi.get(inputId)) return;
    const now = this.nowMs();
    const lastTime = this.glissandoLastTime.get(inputId) ?? 0;
    if (now - lastTime < GLISSANDO_THROTTLE_MS) return;
    event.preventDefault();
    const prevMidi = this.heldMidi.get(inputId);
    const midiDelta = prevMidi !== undefined ? Math.abs(midi - prevMidi) : 0;
    const elapsedMs = now - lastTime;
    const velocity = glissandoVelocityFactor(midiDelta, elapsedMs);
    this.callbacks.release(inputId);
    this.heldMidi.set(inputId, midi);
    this.glissandoLastTime.set(inputId, now);
    this.callbacks.press(inputId, midi, 'pointer', velocity);
  };

  private readonly onPointerEnd = (event: Event): void => {
    const pointerId = (event as Partial<PointerEvent>).pointerId;
    const inputId = `pointer:${String(pointerId)}`;
    if (!this.active.has(inputId)) return;
    event.preventDefault();
    this.active.delete(inputId);
    this.heldMidi.delete(inputId);
    this.glissandoLastTime.delete(inputId);
    this.callbacks.release(inputId);
    const element = this.surface.element;
    if (event.type !== 'lostpointercapture'
      && typeof element.hasPointerCapture === 'function'
      && typeof pointerId === 'number'
      && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  };

  private readonly onKeyDown = (event: Event): void => {
    if (!this.callbacks.canInput()) return;
    const key = (event as KeyboardEvent).key;
    const { selection } = this.callbacks;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      const delta = key === 'ArrowLeft' ? -1 : 1;
      selection.set(Math.min(selection.max, Math.max(selection.min, selection.get() + delta)));
      return;
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      selection.set(key === 'Home' ? selection.min : selection.max);
      return;
    }
    if ((key === ' ' || key === 'Enter')
      && !(event as KeyboardEvent).repeat
      && !this.active.has(KEYBOARD_INPUT_ID)) {
      event.preventDefault();
      this.active.add(KEYBOARD_INPUT_ID);
      this.callbacks.press(KEYBOARD_INPUT_ID, selection.get(), 'keyboard');
    }
  };

  private readonly onKeyUp = (event: Event): void => {
    const key = (event as KeyboardEvent).key;
    if (key !== ' ' && key !== 'Enter') return;
    event.preventDefault();
    if (!this.active.has(KEYBOARD_INPUT_ID)) return;
    this.active.delete(KEYBOARD_INPUT_ID);
    this.callbacks.release(KEYBOARD_INPUT_ID);
  };

  private readonly onBlur = (): void => {
    if (this.active.size === 0) return;
    this.active.clear();
    this.callbacks.releaseAll();
  };

  private bounds(): { left: number; top: number; width: number; height: number } {
    const rect = this.surface.element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
    return this.surface.fallbackBounds?.() ?? rect;
  }
}
