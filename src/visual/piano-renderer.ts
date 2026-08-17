import type { PerformanceEvent } from '../core/types.js';
import type { PianoAudioAnalysis } from '../audio/audio-analyzer.js';
import type { PianoKeyHitGeometry } from './key-geometry.js';
import {
  KEYBOARD_LAYOUT,
  PIANO_BLACK_KEY_HEIGHT_RATIO,
  PIANO_BLACK_KEY_WIDTH_RATIO,
  PIANO_KEYBOARD_HEIGHT,
} from './keyboard.js';
import { createParticleBurst } from './particles.js';
import type { VisualState } from './visual-state.js';
import type { VisualTimeline, VisualTimelineNote } from './visual-timeline.js';

export type PianoRenderQuality = 'low' | 'medium' | 'high';
export type PianoRendererBackend = 'webgl2' | 'canvas2d' | 'none';

export interface PianoRenderOptions {
  readonly musicalTime: number;
  readonly state: VisualState;
  readonly timeline: VisualTimeline;
  readonly showWaterfall: boolean;
  readonly showKeyboard: boolean;
  readonly particles: boolean;
  readonly quality: PianoRenderQuality;
  readonly pixelsPerSecond?: number;
  /** Render the full-viewport poetic immersive shell instead of the card. */
  readonly immersive?: boolean;
  /** Master-output / event activity used to animate water, mist and ripples. */
  readonly atmosphere?: Readonly<PianoAudioAnalysis> | null;
  /** Wall-clock seconds, used only for slow, non-musical breathing motion. */
  readonly nowSeconds?: number;
  /** Reduced-motion: damp or skip motion-dependent layers. */
  readonly reducedMotion?: boolean;
  /** False for the transport's clean stopped frame; transient effects vanish. */
  readonly transientEffects?: boolean;
  /** Keyboard height in CSS pixels; larger in the immersive presentation. */
  readonly keyboardHeight?: number;
}

export interface PianoRenderer {
  readonly backend: PianoRendererBackend;
  resize(width: number, height: number, pixelRatio: number): void;
  render(options: PianoRenderOptions): void;
  /**
   * Optional key layout for pointer hit-testing. Scene-style renderers expose
   * their own geometry so clicks land on the keys the user actually sees.
   */
  keyGeometry?(): PianoKeyHitGeometry | undefined;
  /** Trigger a short visual audition burst for a manually pressed key. */
  audition?(midi: number, velocity: number, nowSeconds: number): void;
  /**
   * Swap the active registered skin by id. Renderers that ignore skins (the
   * legacy quad renderer, a future 3D backend with its own material system)
   * simply omit this; the view treats it as advisory.
   */
  setSkin?(id: string | undefined): void;
  /** Release optional background resources while this renderer is not visible. */
  setActive?(active: boolean): void;
  /** Clear transient playback visuals while retaining cached geometry. */
  resetVisualState?(): void;
  dispose(): void;
}

interface RenderDimensions {
  width: number;
  height: number;
  pixelRatio: number;
}

interface Quad {
  x: number;
  y: number;
  width: number;
  height: number;
  red: number;
  green: number;
  blue: number;
  alpha: number;
  shape?: 'particle';
}

const FALL_SECONDS = 8;
const TAIL_SECONDS = 1.2;
const BACKGROUND: readonly [number, number, number, number] = [0.025, 0.035, 0.075, 1];

function emptyDimensions(): RenderDimensions {
  return { width: 1, height: 1, pixelRatio: 1 };
}

function noteColor(midi: number, velocity: number): readonly [number, number, number, number] {
  // Midnight-indigo base with moon-silver and amber accents.
  const pitch = (midi - 21) / 87;
  const intensity = 0.48 + velocity * 0.52;
  return [0.50 + pitch * 0.34, 0.36 + pitch * 0.18, 0.78 + pitch * 0.16, intensity];
}

function visibleNotes(options: PianoRenderOptions): readonly VisualTimelineNote[] {
  return options.timeline.window(
    options.musicalTime - TAIL_SECONDS,
    options.musicalTime + FALL_SECONDS,
  ).notes;
}

function buildQuads(options: PianoRenderOptions, dimensions: RenderDimensions): Quad[] {
  const quads: Quad[] = [];
  const { width, height } = dimensions;
  const kbHeight = options.showKeyboard ? (options.keyboardHeight ?? PIANO_KEYBOARD_HEIGHT) : 0;
  const waterfallHeight = Math.max(0, height - kbHeight - (kbHeight === 0 ? 0 : 10));
  const pixelsPerSecond = options.pixelsPerSecond ?? 120;
  const bonusPixelsPerSecond = options.immersive ? 90 : 0;

  if (options.showWaterfall) {
    const fallPixels = pixelsPerSecond + bonusPixelsPerSecond;
    for (const note of visibleNotes(options)) {
      const startY = waterfallHeight - ((note.startTime - options.musicalTime) * fallPixels);
      const endY = waterfallHeight - ((note.endTime - options.musicalTime) * fallPixels);
      const y = Math.min(startY, endY);
      const noteHeight = Math.max(6, Math.abs(endY - startY));
      const noteWidth = Math.max(8, width / 52 * 0.9);
      const active = options.state.activeNotes.some(activeNote => activeNote.noteId === note.id);
      const [red, green, blue, alpha] = noteColor(note.midi, note.velocity);
      quads.push({
        x: note.x * width - noteWidth / 2,
        y,
        width: noteWidth,
        height: noteHeight,
        red: Math.min(1, red + (active ? 0.08 : 0)),
        green: Math.min(1, green + (active ? 0.08 : 0)),
        blue: Math.min(1, blue + (active ? 0.08 : 0)),
        alpha: Math.min(0.92, alpha + (active ? 0.08 : 0)),
      });

      if (options.quality !== 'low') {
        const padding = options.quality === 'high' ? 11 : 6;
        quads.push({
          x: note.x * width - noteWidth / 2 - padding / 2,
          y: y - padding / 2,
          width: noteWidth + padding,
          height: noteHeight + padding,
          red,
          green,
          blue,
          alpha: alpha * (options.quality === 'high' ? 0.12 : 0.07),
        });
      }
      if (active && options.immersive && note.midi <= 72) {
        // A soft ripple blooms under an actively sounding low/mid note.
        const beat = ((options.nowSeconds ?? options.musicalTime) * 0.8) % 1;
        const radius = Math.max(10, width / 46 * (0.15 + beat * 0.85));
        quads.push({
          x: note.x * width - radius,
          y: waterfallHeight,
          width: radius * 2,
          height: Math.max(3, radius * 0.35),
          red: 0.72, green: 0.86, blue: 0.96,
          alpha: (1 - beat) * 0.16 * (0.4 + (options.atmosphere?.energy ?? 0) * 0.6),
        });
      }
    }
  }

  if (options.showKeyboard) {
    const keyboardY = height - kbHeight;
    const whiteWidth = width / 52;
    for (const key of KEYBOARD_LAYOUT) {
      if (key.isBlack) continue;
      const pressed = options.state.pressedMidi.has(key.midi);
      const keyY = keyboardY + (pressed ? 2 : 0);
      quads.push({
        x: key.normalizedPosition * width,
        y: keyY,
        width: Math.max(1, whiteWidth - 1),
        height: kbHeight - (pressed ? 2 : 0),
        red: pressed ? 0.22 : 0.965,
        green: pressed ? 0.64 : 0.945,
        blue: pressed ? 0.7 : 0.895,
        alpha: 1,
      });
    }
    for (const key of KEYBOARD_LAYOUT) {
      if (!key.isBlack) continue;
      const pressed = options.state.pressedMidi.has(key.midi);
      const keyY = keyboardY + (pressed ? 1 : 0);
      quads.push({
        x: key.normalizedPosition * width - whiteWidth * PIANO_BLACK_KEY_WIDTH_RATIO / 2,
        y: keyY,
        width: whiteWidth * PIANO_BLACK_KEY_WIDTH_RATIO,
        height: kbHeight * PIANO_BLACK_KEY_HEIGHT_RATIO - (pressed ? 1 : 0),
        red: pressed ? 0.18 : 0.022,
        green: pressed ? 0.3 : 0.024,
        blue: pressed ? 0.36 : 0.03,
        alpha: 1,
      });
    }
    if (options.immersive) {
      addImmersiveKeyboardFinishing(quads, options, dimensions, keyboardY, whiteWidth);
    }
  }

  if (options.particles && options.quality !== 'low') {
    const window = options.timeline.window(options.musicalTime - 0.55, options.musicalTime);
    for (const event of window.noteOnEvents) {
      addParticleQuads(quads, event, options, dimensions, waterfallHeight);
    }
  }

  if (options.immersive) {
    addImmersiveQuads(quads, options, dimensions, kbHeight, waterfallHeight);
  }

  return quads;
}

/** A restrained, breathable activity level for the poetic immersive shell. */
function activityLevel(options: PianoRenderOptions): number {
  const atmosphere = options.atmosphere;
  if (atmosphere === undefined || atmosphere === null) return 0;
  return clamp01(atmosphere.loudness * 0.5 + atmosphere.energy * 0.5);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * A believable grand/piano body behind the keys plus ivory/ebony detailing.
 * These quads only run in immersive mode, so the compact embedded key count
 * (and its exact render tests) is untouched.
 */
function addImmersiveKeyboardFinishing(
  quads: Quad[],
  options: PianoRenderOptions,
  dimensions: RenderDimensions,
  keyboardY: number,
  whiteWidth: number,
): void {
  const { width, height } = dimensions;
  const kbHeight = options.keyboardHeight ?? PIANO_KEYBOARD_HEIGHT;
  const activity = activityLevel(options);
  const atmosphere = options.atmosphere;
  const energy = clamp01(atmosphere?.energy ?? 0) * (options.reducedMotion ? 0.6 : 1);
  const lamp = 0.16 + energy * 0.14 + activity * 0.1;

  // ---- Glossy piano case (open lid silhouette) behind the keyboard ----
  const bodyHeight = Math.max(40, Math.min(height - kbHeight - 20, kbHeight * 2.6));
  const bodyTop = keyboardY - bodyHeight;
  // Deep polished case.
  quads.push({ x: 0, y: bodyTop, width, height: bodyHeight, red: 0.028, green: 0.035, blue: 0.055, alpha: 1 });
  // A warm top highlight that reads as reflected stage light.
  quads.push({ x: 0, y: bodyTop, width, height: 2, red: 0.36, green: 0.42, blue: 0.5, alpha: 0.5 + lamp * 0.5 });
  // A soft diagonal sheen sweeping across the closed lid.
  quads.push({ x: 0, y: bodyTop + bodyHeight * 0.18, width, height: bodyHeight * 0.05, red: 0.3, green: 0.36, blue: 0.46, alpha: 0.08 + lamp * 0.1 });
  quads.push({ x: 0, y: bodyTop + bodyHeight * 0.62, width, height: bodyHeight * 0.04, red: 0.2, green: 0.24, blue: 0.32, alpha: 0.06 + lamp * 0.08 });

  // ---- Fallboard (the polished band just above the keys) ----
  const fallboardY = keyboardY - 8;
  const fallboardHeight = 8;
  quads.push({ x: 0, y: fallboardY, width, height: fallboardHeight, red: 0.035, green: 0.045, blue: 0.07, alpha: 1 });
  quads.push({ x: 0, y: fallboardY, width, height: 1.5, red: 0.45, green: 0.52, blue: 0.6, alpha: 0.5 });
  // Under-key recess floor (where the key stick drops) is a shade darker.
  quads.push({ x: 0, y: keyboardY, width, height: 4, red: 0.02, green: 0.028, blue: 0.04, alpha: 1 });

  // ---- Cheek blocks (the piano sides either side of the keys) ----
  const cheekWidth = Math.max(10, width * 0.012);
  const cheekColor: Quad = { x: 0, y: keyboardY - 10, width: cheekWidth, height: kbHeight + 10, red: 0.05, green: 0.065, blue: 0.09, alpha: 1 };
  quads.push(cheekColor);
  quads.push({ x: width - cheekWidth, y: keyboardY - 10, width: cheekWidth, height: kbHeight + 10, red: 0.05, green: 0.065, blue: 0.09, alpha: 1 });

  // ---- Ivory detailing on white keys: top sheen + recessed bottom shadow ----
  for (const key of KEYBOARD_LAYOUT) {
    if (key.isBlack) continue;
    const pressed = options.state.pressedMidi.has(key.midi);
    const x = key.normalizedPosition * width;
    const w = Math.max(1, whiteWidth - 1);
    if (pressed) continue; // pressed keys get their own highlight below
    // Cool ivory top edge catches the light.
    quads.push({ x, y: keyboardY + 1, width: w, height: 3, red: 0.99, green: 0.98, blue: 0.95, alpha: 0.85 });
    // Warm ivory body.
    quads.push({ x, y: keyboardY + 4, width: w, height: Math.max(1, kbHeight * 0.42), red: 0.965, green: 0.945, blue: 0.90, alpha: 0.9 });
    // Recessed, slightly shaded bed near the bottom where the key tapers.
    quads.push({ x, y: keyboardY + kbHeight * 0.8, width: w, height: Math.max(1, kbHeight * 0.2), red: 0.86, green: 0.83, blue: 0.77, alpha: 0.95 });
  }
  // Pressed white keys: darker ivory, a cold touch highlight, and a drop shadow.
  for (const key of KEYBOARD_LAYOUT) {
    if (key.isBlack) continue;
    if (!options.state.pressedMidi.has(key.midi)) continue;
    const x = key.normalizedPosition * width;
    const w = Math.max(1, whiteWidth - 1);
    const y = keyboardY + 2;
    const h = kbHeight - 2;
    quads.push({ x, y, width: w, height: h, red: 0.82, green: 0.79, blue: 0.72, alpha: 1 });
    quads.push({ x, y, width: w, height: 3, red: 0.98, green: 0.97, blue: 0.94, alpha: 0.75 });
  }

  // ---- Ebony gloss on black keys + a bright tip sheen reflecting the light ----
  for (const key of KEYBOARD_LAYOUT) {
    if (!key.isBlack) continue;
    const pressed = options.state.pressedMidi.has(key.midi);
    const x = key.normalizedPosition * width - whiteWidth * PIANO_BLACK_KEY_WIDTH_RATIO / 2;
    const w = whiteWidth * PIANO_BLACK_KEY_WIDTH_RATIO;
    const h = kbHeight * PIANO_BLACK_KEY_HEIGHT_RATIO;
    if (pressed) {
      quads.push({ x, y: keyboardY + 2, width: w, height: h - 3, red: 0.16, green: 0.2, blue: 0.26, alpha: 1 });
      quads.push({ x, y: keyboardY + 2, width: w, height: 3, red: 0.3, green: 0.38, blue: 0.45, alpha: 0.8 });
    } else {
      quads.push({ x, y: keyboardY, width: w, height: h, red: 0.028, green: 0.038, blue: 0.055, alpha: 1 });
      // A soft specular streak near the key tip.
      quads.push({ x: x + w * 0.12, y: keyboardY + h * 0.05, width: w * 0.55, height: h * 0.16, red: 0.42, green: 0.48, blue: 0.55, alpha: 0.18 + lamp * 0.1 });
    }
  }

  // ---- Key-bed shadow under the whole keyboard ----
  quads.push({ x: 0, y: height - 3, width, height: 3, red: 0, green: 0.008, blue: 0.015, alpha: 1 });
}

function ctxColor(red: number, green: number, blue: number): string {
  const channel = (value: number): number => Math.round(clamp01(value) * 255);
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

/**
 * Water-centred layers for the immersive shell: a moon glow, a reflected
 * keyboard under the waterline, settling ripple ellipses, drifting mist, and a
 * waterline highlight. Everything is deterministic from the shared timeline and
 * analyser activity — no random flashes, no neon.
 */
function addImmersiveQuads(
  quads: Quad[],
  options: PianoRenderOptions,
  dimensions: RenderDimensions,
  keyboardHeight: number,
  waterfallHeight: number,
): void {
  const { width, height } = dimensions;
  const kbHeight = options.keyboardHeight ?? PIANO_KEYBOARD_HEIGHT;
  const keyboardY = height - kbHeight;
  const waterline = keyboardY + kbHeight + 8;
  const activity = activityLevel(options);
  const energy = clamp01(options.atmosphere?.energy ?? 0);
  const moving = options.reducedMotion ? 0 : 1;
  const now = options.nowSeconds ?? options.musicalTime;
  // A calm, low-saturation moonlit palette.
  const moon = { red: 0.5, green: 0.62, blue: 0.7 };

  // ---- Moon glow in the upper space ----
  const glowX = width * 0.5;
  const glowY = height * 0.14;
  const glowR = width * 0.22;
  const glowAlpha = 0.04 + energy * 0.05 + (0.5 + 0.5 * Math.sin(now * 0.15)) * activity * 0.03;
  quads.push({ x: glowX - glowR, y: glowY - glowR * 0.5, width: glowR * 2, height: glowR, red: 0.55, green: 0.68, blue: 0.78, alpha: glowAlpha });
  quads.push({ x: glowX - glowR * 0.5, y: glowY - glowR * 0.28, width: glowR, height: glowR * 0.55, red: 0.72, green: 0.8, blue: 0.9, alpha: glowAlpha * 0.7 });

  // ---- Water surface beneath the piano ----
  const waterTop = waterline;
  const waterHeight = Math.max(20, height - waterline);
  // Deep translucent water wash.
  quads.push({ x: 0, y: waterTop, width, height: waterHeight, red: 0.02, green: 0.05, blue: 0.075, alpha: 0.9 });

  // ---- Reflected keyboard (mirrored, softened) ----
  const reflectionStrength = 0.06 + energy * 0.2 + activity * 0.08;
  if (options.showKeyboard && reflectionStrength > 0.008) {
    const reflectH = Math.min(kbHeight * 0.95, waterHeight * 0.7);
    const whiteWidth = width / 52;
    for (const key of KEYBOARD_LAYOUT) {
      if (key.isBlack) continue;
      const x = key.normalizedPosition * width;
      quads.push({ x, y: waterTop + 2, width: Math.max(1, whiteWidth - 1), height: reflectH, red: 0.16, green: 0.19, blue: 0.24, alpha: reflectionStrength * 0.4 });
    }
    for (const key of KEYBOARD_LAYOUT) {
      if (!key.isBlack) continue;
      const x = key.normalizedPosition * width - whiteWidth * PIANO_BLACK_KEY_WIDTH_RATIO / 2;
      quads.push({ x, y: waterTop + 2, width: whiteWidth * PIANO_BLACK_KEY_WIDTH_RATIO, height: reflectH * PIANO_BLACK_KEY_HEIGHT_RATIO, red: 0.05, green: 0.07, blue: 0.09, alpha: reflectionStrength * 0.5 });
    }
  }

  // ---- Water crest: settle the reflection under a deepening surface ----
  const crestCount = 4;
  for (let i = 0; i < crestCount; i += 1) {
    const t = (i + 1) / (crestCount + 1);
    const alpha = 0.16 + t * 0.42;
    quads.push({ x: 0, y: waterTop + waterHeight * t, width, height: waterHeight * 0.22, red: 0.015, green: 0.04, blue: 0.06, alpha });
  }

  // ---- Bounded shimmer lines gliding across the water ----
  const shimmer = options.quality === 'low' ? 8 : 14;
  for (let i = 0; i < shimmer; i += 1) {
    const phase = (now * (0.02 + 0.02 * ((i % 3) + 1)) + i * 0.7 * Math.PI) % (Math.PI * 2);
    const orient = (i % 2 === 0) ? 1 : -1;
    const lineWidth = width * (0.1 + 0.08 * ((i % 4)));
    const cx = (width / 2) + orient * Math.sin(phase) * width * 0.16;
    const y = waterTop + ((i % shimmer) / shimmer) * waterHeight + 4;
    const alpha = (0.05 + energy * 0.12) * (1 - (i % shimmer) / shimmer) * moving;
    quads.push({ x: cx - lineWidth / 2, y, width: lineWidth, height: 1.5, red: 0.5, green: 0.62, blue: 0.7, alpha });
  }

  // ---- Ripple ellipses from active low/mid notes ----
  const rippleNotes = options.quality === 'low'
    ? options.state.activeNotes.slice(0, 6)
    : options.state.activeNotes.slice(0, 10);
  for (let index = 0; index < rippleNotes.length; index += 1) {
    const note = rippleNotes[index]!;
    if (note.midi > 74) continue; // only low/mid notes touch the water
    const age = now - note.startTime;
    const cycle = (age * 0.5 + index * 0.37) % 1;
    const radius = cycle * width * 0.18 + 8;
    const x = note.x * width;
    quads.push({ x: x - radius, y: waterTop + 6, width: radius * 2, height: Math.max(2, radius * 0.28), red: 0.62, green: 0.76, blue: 0.86, alpha: (1 - cycle) * 0.14 * (0.3 + energy * 0.7) * moving });
    if (cycle > 0.55 && options.quality !== 'low') {
      quads.push({ x: x - radius * 0.62, y: waterTop + 10, width: radius * 1.24, height: Math.max(2, radius * 0.16), red: 0.62, green: 0.76, blue: 0.86, alpha: (1 - cycle) * 0.08 * (0.3 + energy * 0.7) });
    }
  }

  // ---- Drifting mist bands across the upper background ----
  const mistStrength = options.reducedMotion ? 0.05 : 0.05 + activity * 0.1;
  const mistBands = options.quality === 'low' ? 3 : 5;
  for (let band = 0; band < mistBands; band += 1) {
    const drift = moving ? Math.sin(now * 0.05 + band * 1.7) * 0.07 : 0;
    const bandX = ((band / mistBands) * 0.7 + 0.15) * width + drift * width;
    const bandY = waterfallHeight * (0.12 + 0.12 * (band % 3)) + 6;
    const w = width * (0.34 + 0.14 * (band % 2));
    const h = 34 + (band % 3) * 10;
    quads.push({ x: bandX - w / 2, y: bandY, width: w, height: h, red: moon.red, green: moon.green, blue: moon.blue, alpha: mistStrength * 0.34 });
  }

  // ---- Waterline catches the light on every strong chord onset ----
  quads.push({ x: 0, y: waterline, width, height: 2, red: 0.6, green: 0.75, blue: 0.85, alpha: 0.12 + energy * 0.26 });
}

function addParticleQuads(
  quads: Quad[],
  event: PerformanceEvent,
  options: PianoRenderOptions,
  dimensions: RenderDimensions,
  keyboardY: number,
): void {
  if (event.midi === undefined || event.velocity === undefined) return;
  const elapsed = Math.max(0, options.musicalTime - event.time);
  const x = ((event.midi - 21) / 87) * dimensions.width;
  for (const particle of createParticleBurst(event)) {
    if (elapsed >= particle.lifeSeconds) continue;
    const remaining = 1 - elapsed / particle.lifeSeconds;
    const size = options.quality === 'high' ? 3.5 : 2.5;
    quads.push({
      x: x + particle.x + particle.velocityX * elapsed - size / 2,
      y: keyboardY + particle.y + particle.velocityY * elapsed - size / 2,
      width: size,
      height: size,
      red: 0.42,
      green: 0.82,
      blue: 1,
      alpha: particle.intensity * remaining * 0.8,
      shape: 'particle',
    });
  }
}

class CanvasPianoRenderer implements PianoRenderer {
  readonly backend: PianoRendererBackend = 'canvas2d';
  private dimensions = emptyDimensions();

  constructor(private readonly context: CanvasRenderingContext2D) {}

  resize(width: number, height: number, pixelRatio: number): void {
    this.dimensions = { width: Math.max(1, width), height: Math.max(1, height), pixelRatio: Math.max(1, pixelRatio) };
  }

  render(options: PianoRenderOptions): void {
    const { width, height, pixelRatio } = this.dimensions;
    const context = this.context;
    context.save();
    context.scale(pixelRatio, pixelRatio);
    context.clearRect(0, 0, width, height);
    const gradientFactory = context.createLinearGradient?.bind(context);
    if (gradientFactory !== undefined) {
      const background = gradientFactory(0, 0, 0, height);
      if (options.immersive) {
        const breath = options.reducedMotion ? 0 : Math.sin((options.nowSeconds ?? 0) * 0.22) * 0.015;
        const lift = clamp01(options.atmosphere?.energy ?? 0) * 0.05;
        background.addColorStop(0, ctxColor(0.045 + lift, 0.10 + lift, 0.12 + lift + breath));
        background.addColorStop(0.5, ctxColor(0.035 + lift, 0.075 + lift, 0.10 + lift));
        background.addColorStop(1, ctxColor(0.02 + lift, 0.045 + lift, 0.065 + lift));
      } else {
        background.addColorStop(0, '#08232a');
        background.addColorStop(0.48, '#0b1820');
        background.addColorStop(1, '#061016');
      }
      context.fillStyle = background;
    } else {
      context.fillStyle = options.immersive ? '#071018' : '#0b1820';
    }
    context.fillRect(0, 0, width, height);
    for (const quad of buildQuads(options, this.dimensions)) {
      const color = `rgba(${Math.round(quad.red * 255)}, ${Math.round(quad.green * 255)}, ${Math.round(quad.blue * 255)}, ${quad.alpha})`;
      if (quad.shape === 'particle'
        && context.beginPath !== undefined
        && context.arc !== undefined
        && context.fill !== undefined) {
        context.beginPath();
        context.fillStyle = color;
        context.arc(quad.x + quad.width / 2, quad.y + quad.height / 2, Math.max(1, quad.width / 2), 0, Math.PI * 2);
        context.fill();
        continue;
      }
      if (gradientFactory !== undefined && quad.height > 5) {
        const wash = gradientFactory(0, quad.y, 0, quad.y + quad.height);
        wash.addColorStop(0, color);
        wash.addColorStop(0.52, color);
        wash.addColorStop(1, `rgba(${Math.round(quad.red * 180)}, ${Math.round(quad.green * 180)}, ${Math.round(quad.blue * 180)}, ${quad.alpha * 0.86})`);
        context.fillStyle = wash;
      } else {
        context.fillStyle = color;
      }
      context.fillRect(quad.x, quad.y, quad.width, quad.height);
    }
    // These strokes add a quiet glass frame and a waterline without changing
    // the deterministic quad count used by low-level render tests.
    if (context.strokeRect !== undefined) {
      context.strokeStyle = 'rgba(170, 235, 225, 0.30)';
      context.lineWidth = 1;
      context.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
    }
    if (options.showWaterfall && context.beginPath !== undefined) {
      context.beginPath();
      context.moveTo(0, Math.max(0, height - (options.showKeyboard ? PIANO_KEYBOARD_HEIGHT + 10 : 0)));
      context.lineTo(width, Math.max(0, height - (options.showKeyboard ? PIANO_KEYBOARD_HEIGHT + 10 : 0)));
      context.strokeStyle = 'rgba(137, 226, 216, 0.22)';
      context.lineWidth = 1;
      context.stroke();
    }
    context.restore();
  }

  dispose(): void {}
}

const VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
in vec4 a_rect;
in vec4 a_color;
uniform vec2 u_resolution;
out vec4 v_color;
out vec2 v_local;
void main() {
  vec2 position = a_rect.xy + a_position * a_rect.zw;
  vec2 zeroToOne = position / u_resolution;
  vec2 clip = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
  v_local = a_position;
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in vec4 v_color;
in vec2 v_local;
out vec4 outColor;
void main() {
  float edge = min(min(v_local.x, 1.0 - v_local.x), min(v_local.y, 1.0 - v_local.y));
  float softness = smoothstep(0.0, 0.06, edge);
  // Vertical light falloff makes keys and panels read as dimensional surfaces.
  float grad = mix(1.07, 0.84, v_local.y);
  vec3 rgb = v_color.rgb * grad;
  // A quiet inner shadow along the lower edge suggests the key recess.
  float recess = smoothstep(1.0, 0.84, v_local.y) * 0.10;
  rgb *= (1.0 - recess);
  outColor = vec4(rgb, v_color.a * softness);
}`;

function compileShader(context: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = context.createShader(type);
  if (shader === null) throw new Error('WebGL shader allocation failed');
  context.shaderSource(shader, source);
  context.compileShader(shader);
  if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
    const detail = context.getShaderInfoLog(shader) ?? 'unknown shader error';
    context.deleteShader(shader);
    throw new Error(`WebGL shader compilation failed: ${detail}`);
  }
  return shader;
}

function createProgram(context: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(context, context.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compileShader(context, context.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  const program = context.createProgram();
  if (program === null) throw new Error('WebGL program allocation failed');
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  context.deleteShader(vertex);
  context.deleteShader(fragment);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    const detail = context.getProgramInfoLog(program) ?? 'unknown program error';
    context.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${detail}`);
  }
  return program;
}

/** A dependency-free WebGL2 renderer using a single instanced quad draw. */
class WebGlPianoRenderer implements PianoRenderer {
  readonly backend: PianoRendererBackend = 'webgl2';
  private dimensions = emptyDimensions();
  private readonly program: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly positionLocation: number;
  private readonly rectLocation: number;
  private readonly colorLocation: number;
  private readonly resolutionLocation: WebGLUniformLocation;

  constructor(private readonly context: WebGL2RenderingContext) {
    this.program = createProgram(context);
    const quadBuffer = context.createBuffer();
    const instanceBuffer = context.createBuffer();
    const resolutionLocation = context.getUniformLocation(this.program, 'u_resolution');
    if (quadBuffer === null || instanceBuffer === null || resolutionLocation === null) {
      throw new Error('WebGL renderer allocation failed');
    }
    this.quadBuffer = quadBuffer;
    this.instanceBuffer = instanceBuffer;
    this.positionLocation = context.getAttribLocation(this.program, 'a_position');
    this.rectLocation = context.getAttribLocation(this.program, 'a_rect');
    this.colorLocation = context.getAttribLocation(this.program, 'a_color');
    this.resolutionLocation = resolutionLocation;
    context.bindBuffer(context.ARRAY_BUFFER, this.quadBuffer);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), context.STATIC_DRAW);
    context.enable(context.BLEND);
    context.blendFunc(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.dimensions = { width: Math.max(1, width), height: Math.max(1, height), pixelRatio: Math.max(1, pixelRatio) };
  }

  render(options: PianoRenderOptions): void {
    const context = this.context;
    if (context.isContextLost?.()) {
      throw new Error('WebGL context lost');
    }
    const { width, height, pixelRatio } = this.dimensions;
    context.viewport(0, 0, Math.floor(width * pixelRatio), Math.floor(height * pixelRatio));
    let clear = BACKGROUND;
    if (options.immersive) {
      const lift = clamp01(options.atmosphere?.energy ?? 0) * 0.05;
      const breath = options.reducedMotion ? 0 : Math.sin((options.nowSeconds ?? 0) * 0.22) * 0.015;
      clear = [
        clamp01(0.025 + lift),
        clamp01(0.06 + lift),
        clamp01(0.075 + lift + breath),
        1,
      ];
    }
    context.clearColor(clear[0], clear[1], clear[2], clear[3]);
    context.clear(context.COLOR_BUFFER_BIT);
    const quads = buildQuads(options, this.dimensions);
    if (quads.length === 0) return;

    const data = new Float32Array(quads.length * 8);
    quads.forEach((quad, index) => {
      const base = index * 8;
      data.set([
        quad.x, quad.y, quad.width, quad.height,
        quad.red, quad.green, quad.blue, quad.alpha,
      ], base);
    });
    context.useProgram(this.program);
    context.uniform2f(this.resolutionLocation, width, height);

    context.bindBuffer(context.ARRAY_BUFFER, this.quadBuffer);
    context.enableVertexAttribArray(this.positionLocation);
    context.vertexAttribPointer(this.positionLocation, 2, context.FLOAT, false, 0, 0);
    context.vertexAttribDivisor(this.positionLocation, 0);

    context.bindBuffer(context.ARRAY_BUFFER, this.instanceBuffer);
    context.bufferData(context.ARRAY_BUFFER, data, context.DYNAMIC_DRAW);
    context.enableVertexAttribArray(this.rectLocation);
    context.vertexAttribPointer(this.rectLocation, 4, context.FLOAT, false, 32, 0);
    context.vertexAttribDivisor(this.rectLocation, 1);
    context.enableVertexAttribArray(this.colorLocation);
    context.vertexAttribPointer(this.colorLocation, 4, context.FLOAT, false, 32, 16);
    context.vertexAttribDivisor(this.colorLocation, 1);
    context.drawArraysInstanced(context.TRIANGLE_STRIP, 0, 4, quads.length);
  }

  dispose(): void {
    this.context.deleteBuffer(this.quadBuffer);
    this.context.deleteBuffer(this.instanceBuffer);
    this.context.deleteProgram(this.program);
  }
}

class NullPianoRenderer implements PianoRenderer {
  readonly backend: PianoRendererBackend = 'none';
  resize(): void {}
  render(): void {}
  dispose(): void {}
}

/** Prefer an instanced WebGL2 path and retain Canvas2D for unsupported devices. */
export function createPianoRenderer(canvas: HTMLCanvasElement, preferWebGl = true): PianoRenderer {
  if (preferWebGl) {
    try {
      const context = canvas.getContext('webgl2', { alpha: false, antialias: true });
      if (context !== null) return new WebGlPianoRenderer(context);
    } catch {
      // Some headless/browser-security environments reject WebGL allocation.
    }
  }
  try {
    const context = canvas.getContext('2d');
    if (context !== null) return new CanvasPianoRenderer(context);
  } catch {
    // A no-op renderer still allows the deterministic audio path to run.
  }
  return new NullPianoRenderer();
}
