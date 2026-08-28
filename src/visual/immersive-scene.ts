/**
 * Piano scene — the Canvas2D renderer behind every piano skin.
 *
 * Design goals:
 * - Skin-driven: every color, material and atmosphere flag comes from a pure
 *   data `PianoSkin`. The chat card renders the clean compact presentation;
 *   immersive playback stages the full scene. Both read the same skin data,
 *   so future skins (and a future 3D backend consuming the same data) plug in
 *   without touching this file's geometry or motion code.
 * - High performance: the static piano body is pre-rendered to an off-screen
 *   layer once per layout; keys are cached sprites with the black-key drop
 *   shadow baked in (no per-frame shadowBlur); moon/horizon/press glows are
 *   cached radial sprites; backdrop, vignette, water and keybed gradients are
 *   cached per layout+skin; grain is one pre-rendered tile blitted as a
 *   pattern. Every frame only animates keys, ribbons, impacts and bounded
 *   ambient pools.
 * - Deterministic: note-generated ribbons and impacts come from the shared
 *   timeline, never Math.random(); ambient motes use a seeded RNG so
 *   pause/seek/replay keep a stable atmosphere.
 * - Extensible: quality presets control particle budget and DPR; reduced-
 *   motion shuts off moving layers; `setSkin` swaps palettes live.
 */

import type { PianoRenderer, PianoRenderOptions, PianoRendererBackend, PianoRenderQuality } from './piano-renderer.js';
import type { PianoKeyHit, PianoKeyHitGeometry } from './key-geometry.js';
import {
  AMBIENT_METEOR_STRIDE,
  createAmbientWorker,
  type AmbientMeteorFrame,
  type AmbientMeteorSeed,
  type AmbientWorkerBridge,
} from './ambient-worker.js';
import {
  KEYBOARD_LAYOUT,
  PIANO_IMMERSIVE_KEYBOARD_HEIGHT,
  PIANO_KEYBOARD_HEIGHT,
  PIANO_BLACK_KEY_HEIGHT_RATIO,
  PIANO_BLACK_KEY_WIDTH_RATIO,
  blackKeyLean,
} from './keyboard.js';
import { applySparkGravity } from './particles.js';
import { resolvePianoSkin, type PianoSkin, type Rgb } from './skin.js';

const WHITE_COUNT = KEYBOARD_LAYOUT.filter(key => !key.isBlack).length;

const WHITE_INDEX_BY_MIDI = new Map<number, number>();
const WHITES_BEFORE_BY_MIDI = new Map<number, number>();
{
  let whites = 0;
  for (const key of KEYBOARD_LAYOUT) {
    WHITES_BEFORE_BY_MIDI.set(key.midi, whites);
    if (!key.isBlack) {
      WHITE_INDEX_BY_MIDI.set(key.midi, whites);
      whites += 1;
    }
  }
}

interface QualityPreset {
  dpr: number;
  ribbonSegments: number;
  ribbonGlow: boolean;
  droplets: number;
  glints: number;
  streaks: number;
  sparksPerHit: number;
  reflectionSlices: number;
}

const QUALITY: Record<PianoRenderQuality, QualityPreset> = {
  low: { dpr: 1, ribbonSegments: 5, ribbonGlow: false, droplets: 18, glints: 16, streaks: 7, sparksPerHit: 5, reflectionSlices: 20 },
  medium: { dpr: 1.5, ribbonSegments: 9, ribbonGlow: true, droplets: 34, glints: 28, streaks: 12, sparksPerHit: 9, reflectionSlices: 30 },
  high: { dpr: 2, ribbonSegments: 12, ribbonGlow: true, droplets: 48, glints: 38, streaks: 16, sparksPerHit: 14, reflectionSlices: 40 },
};

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothish(t: number): number {
  return t * t * (3 - 2 * t);
}

function easeInCubic(t: number): number {
  return t * t * t;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}

/** Parse #rgb / #rrggbb skin hex fields into an rgb triplet. */
function hexRgb(hex: string): Rgb {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map(ch => ch + ch).join('') : raw;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [255, 255, 255];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function scaleRgb(color: Rgb, factor: number): Rgb {
  return [Math.round(color[0] * factor), Math.round(color[1] * factor), Math.round(color[2] * factor)];
}

/** Brighten a color for highlight stops, clamped to the 0-255 channel range. */
function bumpRgb(color: Rgb, factor: number): Rgb {
  return [
    Math.min(255, Math.round(color[0] * factor)),
    Math.min(255, Math.round(color[1] * factor)),
    Math.min(255, Math.round(color[2] * factor)),
  ];
}

function hueFor(midi: number, skin: PianoSkin): Rgb {
  if (midi < 50) return skin.notes.low;
  if (midi < 70) return skin.notes.mid;
  return skin.notes.high;
}

function roundedRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(1, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

export interface PianoLayout {
  width: number;
  height: number;
  pw: number;
  cheek: number;
  whiteW: number;
  whiteH: number;
  blackW: number;
  blackH: number;
  padLid: number;
  backH: number;
  railH: number;
  /** Open-lid / music-rack region above the front case. */
  lidH: number;
  /** Complete case height, including open lid and front rail. */
  caseH: number;
  /** Complete instrument height, including legs and bench clearance. */
  grandH: number;
  legH: number;
  benchH: number;
  x0: number;
  top: number;
  keyTop: number;
  keyLeft: number;
  /** Local-space keyboard plane: depth 0 is the back edge, depth 1 the front edge. */
  keyboardBackY: number;
  keyboardFrontY: number;
  /** Canvas-space top edge of the front rail; it meets the key plane front. */
  frontRailY: number;
  keyboardDepthY: number;
  keyboardSkewX: number;
  keyboardBackInset: number;
  keyboardFrontInset: number;
  keyboardFrontDrop: number;
  waterY: number;
}

interface ScenePoint {
  x: number;
  y: number;
}

/** Project a local keyboard coordinate onto the shared keyboard plane. */
function projectKeyboardPoint(L: PianoLayout, localX: number, depth: number, extraY = 0): ScenePoint {
  const t = clamp(depth, 0, 1);
  const norm = clamp((localX - L.cheek) / Math.max(1, L.pw - L.cheek * 2), 0, 1);
  const inset = lerp(L.keyboardBackInset, L.keyboardFrontInset, t);
  return {
    x: inset + norm * (L.pw - inset * 2) + (t - 0.5) * L.keyboardSkewX,
    y: lerp(L.keyboardBackY, L.keyboardFrontY, t) + extraY,
  };
}

interface Ribbon {
  noteId: string;
  midi: number;
  x: number;
  velocity: number;
  start: number;
  hold: number;
  ph: number;
  state: 'fall' | 'hit';
  t0: number;
}

interface Impact {
  kind: 'flash' | 'ring' | 'ripple' | 'pillar' | 'spark' | 'chord';
  x: number;
  y: number;
  t0: number;
  wallT0?: number;
  v: number;
  hue: readonly [number, number, number];
  vx?: number;
  vy?: number;
  g?: number;
  life?: number;
  r?: number;
  ph?: number;
}

interface AmbientMote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  ph: number;
  sp: number;
}

type Meteor = AmbientMeteorSeed;

const MAX_IMPACTS = 220;
/** How many seconds of look-ahead a falling comet covers before it strikes. */
const COMET_LEAD = 2.2;
const COMET_LEAD_REDUCED = 0.6;
/** Mid-plane depth used for hit cells and effect anchoring on the key plane. */
const KEY_PLANE_DEPTH = 0.52;
/** Ebony tops occupy the rear half of the key plane. */
const BLACK_KEY_DEPTH_BACK = 0.1;
const BLACK_KEY_DEPTH_FRONT = 0.72;

function whiteKeyFaceDepth(L: PianoLayout, referenceView: boolean): number {
  return Math.max(3, L.whiteH * (referenceView ? 0.19 : 0.15));
}

function blackKeyFaceDepth(L: PianoLayout, referenceView: boolean): number {
  return Math.max(4, L.blackH * (referenceView ? 0.42 : 0.34));
}

/**
 * Compact staging centers the instrument inside short cards instead of
 * leaving room for water below it.
 *
 * `options.tallLid` selects the concert-grand staging used on the immersive
 * stage. `options.referenceView` adds the deeper, elevated player-height
 * geometry used only by the black reference-photo skin.
 */
export function computeLayout(
  width: number,
  height: number,
  compact: boolean,
  keyboardHeight?: number,
  options?: { tallLid?: boolean; flatKeyboard?: boolean; referenceView?: boolean },
): PianoLayout {
  const tallLid = options?.tallLid === true && !compact;
  const flatKeyboard = options?.flatKeyboard === true;
  const referenceView = options?.referenceView === true && !compact;
  let pw: number;
  if (width < 640) pw = width * 0.955;
  else if (width < 1100) pw = width * 0.86;
  else pw = Math.min(1180, width * 0.78);
  // The concert-grand staging narrows the case so its tall open lid keeps
  // room to breathe against the sky.
  if (tallLid) pw *= 0.88;
  pw = clamp(pw, 280, 1180);
  // Wide glossy cheek blocks keep the keyboard inset within the case, as on
  // a real frontal elevation.
  const cheek = Math.max(10, pw * 0.055);
  const whiteW = (pw - cheek * 2) / WHITE_COUNT;
  // The staged presentation gives the keyboard a stable, readable scale even
  // on narrower viewports. Compact cards remain proportional to their width;
  // immersive mode gets a larger physical key height and rebuilds its sprites
  // when the presentation changes.
  const naturalWhiteH = clamp(pw * 0.075, 26, 88);
  const requestedKeyboardHeight = Number.isFinite(keyboardHeight)
    ? keyboardHeight!
    : compact ? PIANO_KEYBOARD_HEIGHT : PIANO_IMMERSIVE_KEYBOARD_HEIGHT;
  const maxWhiteH = compact ? Math.max(24, (height - 24) / 6.4) : 88;
  const whiteH = clamp(Math.min(Math.max(naturalWhiteH, requestedKeyboardHeight * 0.5), maxWhiteH), 24, 88);
  // Preserve a small physical width for ebony keys on narrow immersive
  // viewports so the dark keys remain legible after entering the stage.
  const blackW = compact
    ? whiteW * PIANO_BLACK_KEY_WIDTH_RATIO
    : Math.max(whiteW * PIANO_BLACK_KEY_WIDTH_RATIO, Math.min(6.25, whiteW * 0.9));
  const blackH = whiteH * PIANO_BLACK_KEY_HEIGHT_RATIO;
  const padLid = whiteH * 0.2;
  // A real grand exposes a deep soundboard between the raised lid and the
  // fallboard. The black reference view gets enough depth for the elevated
  // player-height composition; other presentations retain their proportions.
  const backH = whiteH * (referenceView ? 1.65 : 0.56);
  const railH = whiteH * 0.72;
  const legH = whiteH * (compact ? 1.20 : 1.55);
  const benchH = whiteH * 0.34;
  // The keyboard sits on a shallow plane parallel to the floor: its rear edge
  // tucks under the fallboard while the front edge opens toward the viewer.
  // Keep the optional flat mode for layout tests/future skins, but neither
  // built-in family uses it.
  const keyboardBackInset = flatKeyboard ? cheek * 1.18 : cheek * 1.45;
  const keyboardFrontInset = flatKeyboard ? cheek * 1.18 : cheek * 0.95;
  const keyboardDepthY = Math.max(5, whiteH * (compact ? 0.44 : 0.68));
  // The near edge sits lower in the frame because the player is looking down
  // onto the key tops. This drop is deliberately shared by the front rail.
  const keyboardFrontDrop = Math.max(2, whiteH * (referenceView ? 0.26 : compact ? 0.1 : 0.16));
  // Lid band sized to the viewport: the instrument shrinks to fit instead of
  // sliding up out of frame, so the raised lid is never clipped.
  const skyMargin = compact ? Math.max(4, height * 0.05) : Math.max(24, height * 0.08);
  const waterGap = compact ? 10 : 120;
  const fixedParts = padLid + backH + whiteH + keyboardFrontDrop + railH + legH;
  const budgetLidH = height - skyMargin - waterGap - fixedParts;
  const lidHeightRatio = compact ? 2.6 : tallLid ? (referenceView ? 4.0 : 5.2) : 2.24;
  const lidH = clamp(
    whiteH * lidHeightRatio,
    whiteH * 1.4,
    Math.max(whiteH * 1.4, budgetLidH),
  );
  const caseH = lidH + padLid + backH + whiteH + keyboardFrontDrop + railH;
  const grandH = caseH + legH;
  let top: number;
  let waterY: number;
  if (compact) {
    top = clamp((height - grandH) * 0.48, 4, Math.max(4, height - grandH - 3));
    waterY = Math.min(height - 2, top + grandH + 8);
  } else {
    // Seat the assembly as low as the waterline allows — sky above stays
    // generous, and the lid peak keeps clear headroom by construction.
    top = Math.max(skyMargin, height - waterGap - grandH - 14);
    waterY = top + grandH + 14;
  }
  const keyTop = top + lidH + padLid + backH;
  const frontRailY = keyTop + whiteH + keyboardFrontDrop;
  const keyboardSkewX = 0;
  return {
    width, height, pw, cheek, whiteW, whiteH, blackW, blackH, padLid, backH, railH, lidH, caseH, grandH, legH, benchH,
    x0: (width - pw) / 2,
    top,
    keyTop,
    keyLeft: (width - pw) / 2 + cheek,
    keyboardBackY: keyTop,
    keyboardFrontY: frontRailY,
    frontRailY,
    keyboardDepthY,
    keyboardSkewX,
    keyboardBackInset,
    keyboardFrontInset,
    keyboardFrontDrop,
    waterY,
  };
}

/**
 * Horizontal center of a key, in white-key widths from the left cheek edge.
 * White keys own one full unit each; black keys sit on the boundary between
 * their neighbouring whites — `whitesBefore` already counts that left white —
 * leaned by the shared real-piano offset of blackKeyLean.
 */
function keyCenterOffsetUnits(midi: number): number {
  const whitesBefore = WHITES_BEFORE_BY_MIDI.get(midi);
  if (whitesBefore === undefined) return WHITE_COUNT / 2;
  const pitchClass = ((midi % 12) + 12) % 12;
  const isBlack = pitchClass === 1 || pitchClass === 3 || pitchClass === 6 || pitchClass === 8 || pitchClass === 10;
  return whitesBefore + (isBlack ? blackKeyLean(pitchClass) : 0.5);
}

/**
 * Canvas-space center of any key for the current layout. Every note-derived
 * visual (ribbons, flashes, rings, sparks, ripples) MUST route through this
 * so effects land exactly on the sounding key — never on a full-canvas
 * normalization of its pitch, which drifts away from the centered instrument
 * on wide screens.
 */
export function keyCenterX(L: PianoLayout, midi: number): number {
  const localX = L.cheek + keyCenterOffsetUnits(midi) * L.whiteW;
  const projected = projectKeyboardPoint(L, localX, 0.52);
  return L.x0 + projected.x;
}

export class ImmersivePianoScene implements PianoRenderer {
  readonly backend: PianoRendererBackend = 'canvas2d';
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private quality: PianoRenderQuality = 'medium';
  /** True when rendering the short embedded card presentation. */
  private layoutCompact = false;
  private layoutKeyboardHeight: number | undefined;
  private layoutTallLid = false;
  private layoutFlatKeyboard = false;
  private layoutReferenceView = false;
  private modeImmersive = false;
  private layout: PianoLayout | undefined;
  private layer: HTMLCanvasElement | undefined;
  private layerC: CanvasRenderingContext2D | null = null;
  private activeSkin: PianoSkin | undefined;
  private skinOverride: string | undefined;

  private whiteSprite: HTMLCanvasElement | undefined;
  private blackSprite: HTMLCanvasElement | undefined;
  private woodSprite: HTMLCanvasElement | undefined;
  private dropletSprite: HTMLCanvasElement | undefined;
  private moonSprite: HTMLCanvasElement | undefined;
  private horizonSprite: HTMLCanvasElement | undefined;
  private pressGlowSprite: HTMLCanvasElement | undefined;
  private noteSprites: HTMLCanvasElement[] = [];
  private cometSprites: HTMLCanvasElement[] = [];
  private notesAmbient: Array<{ fx: number; fy: number; sp: number; ph: number; glyph: number; size: number }> = [];

  private grainTile: HTMLCanvasElement | undefined;
  private grainPattern: CanvasPattern | undefined;
  private backdropGradient: CanvasGradient | undefined;
  private vignetteGradient: CanvasGradient | undefined;
  private keybedShadowGradient: CanvasGradient | undefined;
  /** Shared white-key gradient, keyed by skin + key-plane geometry. */
  private whiteKeyGradient: CanvasGradient | undefined;
  private whiteKeyGradientKey = '';
  private whiteKeyFaceGradient: CanvasGradient | undefined;
  private blackKeyFaceGradient: CanvasGradient | undefined;
  /** Horizontal unit gradients for water streaks, keyed by skin id. */
  private streakUnits: { dark: CanvasGradient; light: CanvasGradient } | undefined;
  private streakUnitsSkinId = '';
  /** Horizontal unit gradient stretched along meteor tails, keyed by skin id. */
  private meteorTrailUnit: CanvasGradient | undefined;
  private meteorTrailSkinId = '';

  private ambientT = 0;
  private ribbons: Ribbon[] = [];
  private impacts: Impact[] = [];
  private motes: AmbientMote[] = [];
  private glints: AmbientMote[] = [];
  private streaks: Array<{ fy: number; fx: number; fw: number; sp: number; ph: number; a: number; dark: boolean }> = [];
  private meteors: Meteor[] = [];
  private notified = new Map<string, number>();
  private lastMusic = -1;
  private pressed = new Map<number, number>();
  private hitKeys: PianoKeyHit[] = [];
  private hitGeometry: PianoKeyHitGeometry | undefined;
  private wallSeconds = 0;
  private wallDelta = 1 / 60;
  private lastWallSeconds = 0;
  private frameDelta = 1 / 60;
  private ambientWorker: AmbientWorkerBridge | undefined;
  private workerMeteors: AmbientMeteorFrame | undefined;
  private workerFrameReady = false;
  private lastWorkerRequest = Number.NEGATIVE_INFINITY;
  private ambientWorkerCreationFailed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('immersive piano requires a 2d canvas context');
    this.ctx = ctx;
  }

  /** Key layout used by the view for pointer auditioning. */
  keyGeometry(): PianoKeyHitGeometry | undefined {
    return this.hitGeometry;
  }

  /** Select a registered skin by id; unknown ids fall back per presentation. */
  setSkin(id: string | undefined): void {
    this.skinOverride = id === undefined || id.length === 0 ? undefined : id;
  }

  audition(midi: number, velocity: number, nowSeconds: number): void {
    const L = this.layout;
    const skin = this.activeSkin;
    if (L === undefined || skin === undefined) return;
    this.wallSeconds = Number.isFinite(nowSeconds) ? nowSeconds : this.wallSeconds;
    this.emitImpact({ id: `audition:${String(midi)}:${String(this.wallSeconds)}`, midi, velocity }, true);
  }

  setActive(active: boolean): void {
    if (active) return;
    this.ambientWorker?.dispose();
    this.ambientWorker = undefined;
    this.workerMeteors = undefined;
    this.workerFrameReady = false;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    const dpr = Math.min(Math.max(1, pixelRatio), QUALITY[this.quality].dpr);
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.layoutKeyboardHeight = undefined;
    this.layout = computeLayout(this.width, this.height, this.layoutCompact);
    this.buildHitKeys();
    this.buildStaticArt();
    this.buildAmbient();
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  render(options: PianoRenderOptions): void {
    if (this.quality !== options.quality) {
      this.quality = options.quality;
      this.resize(this.width, this.height, window.devicePixelRatio ?? 1);
    }
    const reduced = options.reducedMotion === true;
    const immersive = options.immersive === true;
    const presentationChanged = this.modeImmersive !== immersive;
    this.modeImmersive = immersive;
    const keyboardHeight = Number.isFinite(options.keyboardHeight)
      ? options.keyboardHeight!
      : immersive ? PIANO_IMMERSIVE_KEYBOARD_HEIGHT : PIANO_KEYBOARD_HEIGHT;

    const skin = resolvePianoSkin(this.skinOverride);
    // Both families share the concert-grand staging on the immersive stage:
    // a narrower case with a full-elevation lid, sized to the viewport.
    const tallLid = immersive;
    // Both built-in families use a floor-parallel key plane. The rear edge
    // sits higher and narrower while the front edge opens toward the viewer.
    const flatKeyboard = !skin.keyboardPerspective;
    const referenceView = immersive && skin.id === 'lacquer-gold';
    // Presentation switches change geometry (compact card vs staged scene).
    if (
      presentationChanged
      || this.layoutCompact === immersive
      || this.layoutKeyboardHeight !== keyboardHeight
      || this.layoutTallLid !== tallLid
      || this.layoutFlatKeyboard !== flatKeyboard
      || this.layoutReferenceView !== referenceView
    ) {
      this.layoutCompact = !immersive;
      this.layoutTallLid = tallLid;
      this.layoutFlatKeyboard = flatKeyboard;
      this.layoutReferenceView = referenceView;
      this.layout = computeLayout(this.width, this.height, this.layoutCompact, keyboardHeight, { tallLid, flatKeyboard, referenceView });
      this.layoutKeyboardHeight = keyboardHeight;
      this.buildHitKeys();
      this.buildStaticArt();
      // Impacts and ribbons carry absolute coordinates from the previous
      // layout; drawing them against new geometry scatters ghost flashes and
      // stray streaks across the stage right after a presentation switch.
      this.ribbons.length = 0;
      this.impacts.length = 0;
      this.notified.clear();
    }
    if (this.activeSkin !== skin) {
      this.activeSkin = skin;
      this.buildStaticArt();
    }

    if (immersive && skin.atmosphere.meteors && options.quality !== 'low' && !reduced) this.ensureAmbientWorker();
    else if (this.ambientWorker !== undefined) this.setActive(false);

    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Dynamic passes use additive compositing and temporary shadows. Reset the
    // shared context before the next frame so a pause-triggered repaint always
    // starts from an opaque, source-over canvas state.
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.filter = 'none';
    c.shadowBlur = 0;
    c.shadowColor = 'transparent';
    c.shadowOffsetX = 0;
    c.shadowOffsetY = 0;
    // Transparent ground truth: clear leaves alpha 0 so the host shows.
    c.clearRect(0, 0, this.width, this.height);
    const L = this.layout;
    if (L === undefined) return;

    const analysis = options.atmosphere;
    const energy = analysis?.energy ?? 0;
    const loudness = analysis?.loudness ?? 0;
    const low = analysis?.low ?? 0;
    const mid = analysis?.mid ?? 0;
    const highEnergy = analysis?.high ?? 0;
    const q = QUALITY[this.quality];
    const nextWallSeconds = Number.isFinite(options.nowSeconds) ? options.nowSeconds! : this.wallSeconds + 1 / 60;
    this.wallDelta = this.lastWallSeconds === 0
      ? 1 / 60
      : Math.min(0.06, Math.max(0, nextWallSeconds - this.lastWallSeconds));
    this.wallSeconds = nextWallSeconds;
    this.lastWallSeconds = nextWallSeconds;
    this.ambientT = nextWallSeconds * (reduced ? 6 : 60);
    const musicalDelta = Math.min(0.06, Math.max(0, options.musicalTime - this.lastMusic));
    this.frameDelta = musicalDelta > 0 ? musicalDelta : this.wallDelta;

    const transientEffects = options.transientEffects !== false;
    if (transientEffects) this.updateDynamics(options, reduced);
    this.updateKeys(options, reduced);

    if (immersive) this.drawAtmosphereBackdrop(c, L, { energy, loudness }, reduced || !transientEffects, skin);
    else this.drawCompactBackdrop(c, L, energy, skin);

    // Music glyphs drift through the sky around the instrument, behind it.
    if (transientEffects && immersive && skin.atmosphere.notes && options.particles) this.drawMusicNotes(c, L, reduced);

    // Comets fall between the viewer and the instrument for skins that ask
    // for it (the opaque concert grand), so the case never swallows them.
    const cometsInFront = skin.atmosphere.cometsFront;
    if (transientEffects && !cometsInFront && options.showWaterfall) this.drawRibbons(c, L, options, reduced, skin);
    this.drawPianoAndKeys(c, L, options, skin);
    if (immersive && skin.atmosphere.reflection) {
      this.drawWaterAndReflection(c, L, { energy, loudness, low }, reduced || !transientEffects, q, skin, transientEffects);
    }
    if (transientEffects && cometsInFront && options.showWaterfall) this.drawRibbons(c, L, options, reduced, skin);
    if (transientEffects) this.drawImpacts(c, L);
    if (transientEffects && immersive) {
      this.drawAmbient(c, L, { energy, high: highEnergy }, reduced, q, options.particles, skin);
    }
    if (skin.atmosphere.grain && !reduced) this.drawGrain(c);
  }

  dispose(): void {
    this.resetVisualState();
    this.motes.length = 0;
    this.glints.length = 0;
    this.streaks.length = 0;
    this.setActive(false);
  }

  /** Clear transient playback visuals without rebuilding cached piano art. */
  resetVisualState(): void {
    this.ribbons.length = 0;
    this.impacts.length = 0;
    this.notified.clear();
    this.pressed.clear();
    this.lastMusic = -1;
    this.wallSeconds = 0;
    this.lastWallSeconds = 0;
    this.ambientT = 0;
    this.wallDelta = 1 / 60;
    this.frameDelta = 1 / 60;
    this.lastWorkerRequest = Number.NEGATIVE_INFINITY;
    this.workerFrameReady = false;
    this.workerMeteors = undefined;
    if (this.layout !== undefined) this.buildAmbient();
  }

  /* ------------------------------ layout, sprites & caches ------------------------------ */

  private buildHitKeys(): void {
    const L = this.layout;
    if (L === undefined) {
      this.hitGeometry = undefined;
      return;
    }
    // Each pointer cell encloses the complete projected key prism, including
    // the newly visible front and side faces. This same geometry is used for
    // pointer-down and held-pointer glissandos.
    const referenceView = this.layoutReferenceView;
    const whiteFaceDepth = whiteKeyFaceDepth(L, referenceView);
    const blackFaceDepth = blackKeyFaceDepth(L, referenceView);
    const keys: PianoKeyHit[] = [];
    for (const key of KEYBOARD_LAYOUT) {
      if (key.isBlack) continue;
      const index = WHITE_INDEX_BY_MIDI.get(key.midi) ?? 0;
      const backL = projectKeyboardPoint(L, L.cheek + index * L.whiteW, 0);
      const backR = projectKeyboardPoint(L, L.cheek + (index + 1) * L.whiteW, 0);
      const frontL = projectKeyboardPoint(L, L.cheek + index * L.whiteW, 1);
      const frontR = projectKeyboardPoint(L, L.cheek + (index + 1) * L.whiteW, 1);
      const x = L.x0 + Math.min(backL.x, frontL.x);
      const right = L.x0 + Math.max(backR.x, frontR.x);
      keys.push({
        midi: key.midi,
        isBlack: false,
        x,
        w: right - x,
        y: backL.y,
        h: frontL.y + whiteFaceDepth - backL.y,
        backX: L.x0 + backL.x,
        backW: backR.x - backL.x,
        frontX: L.x0 + frontL.x,
        frontW: frontR.x - frontL.x,
        frontY: frontL.y,
      });
    }
    for (const key of KEYBOARD_LAYOUT) {
      if (!key.isBlack) continue;
      const centerLocal = L.cheek + keyCenterOffsetUnits(key.midi) * L.whiteW;
      const half = L.blackW / 2;
      const backL = projectKeyboardPoint(L, centerLocal - half, BLACK_KEY_DEPTH_BACK);
      const backR = projectKeyboardPoint(L, centerLocal + half, BLACK_KEY_DEPTH_BACK);
      const frontL = projectKeyboardPoint(L, centerLocal - half * 0.92, BLACK_KEY_DEPTH_FRONT);
      const frontR = projectKeyboardPoint(L, centerLocal + half * 0.92, BLACK_KEY_DEPTH_FRONT);
      const x = L.x0 + Math.min(backL.x, frontL.x);
      const right = L.x0 + Math.max(backR.x, frontR.x);
      keys.push({
        midi: key.midi,
        isBlack: true,
        x,
        w: right - x,
        y: backL.y,
        h: frontL.y + blackFaceDepth - backL.y,
        backX: L.x0 + backL.x,
        backW: backR.x - backL.x,
        frontX: L.x0 + frontL.x,
        frontW: frontR.x - frontL.x,
        frontY: frontL.y,
      });
    }
    this.hitKeys = keys;
    this.hitGeometry = {
      keys,
      keyTop: L.keyTop,
      whiteH: L.keyboardFrontY + whiteFaceDepth - L.keyTop,
      blackH: L.blackH + blackFaceDepth,
    };
  }

  private buildStaticArt(): void {
    const L = this.layout;
    if (L === undefined) return;
    const skin = this.activeSkin ?? resolvePianoSkin(undefined);
    const s = this.dpr;
    const layer = document.createElement('canvas');
    layer.width = Math.round(L.pw * s);
    layer.height = Math.round(L.grandH * s);
    const c = layer.getContext('2d');
    if (c !== null) {
      c.scale(s, s);
      this.layer = layer;
      this.layerC = c;
      this.drawPianoBody(c, L, skin);
    } else {
      this.layer = undefined;
      this.layerC = null;
    }
    this.whiteSprite = keySprite('white', L.whiteW, L.whiteH, s, skin);
    this.blackSprite = keySprite('black', L.blackW, L.blackH, s, skin);
    this.woodSprite = skin.case.wood ? woodTexture(L.cheek, L.grandH, s) : undefined;
    this.dropletSprite = radialSprite([255, 242, 214], 32);
    this.moonSprite = radialSprite(skin.atmosphere.moon, 128);
    this.horizonSprite = radialSprite(skin.backdrop.horizon, 128);
    this.pressGlowSprite = radialSprite(skin.keys.pressGlow, 64);
    this.backdropGradient = undefined;
    this.vignetteGradient = undefined;
    this.keybedShadowGradient = undefined;
    this.whiteKeyGradient = undefined;
    this.whiteKeyFaceGradient = undefined;
    this.blackKeyFaceGradient = undefined;
    this.streakUnits = undefined;
    this.meteorTrailUnit = undefined;
    this.noteSprites = skin.atmosphere.notes ? buildNoteSprites(skin) : [];
    this.cometSprites = [skin.notes.low, skin.notes.mid, skin.notes.high].map(hue => cometSprite(hue, skin.notes.tip));
    this.seedMusicNotes();
  }

  private buildAmbient(): void {
    const q = QUALITY[this.quality];
    const R = mulberry32(20260821);
    const L = this.layout;
    const H = this.height;
    this.motes = [];
    for (let i = 0; i < q.droplets; i += 1) {
      this.motes.push({
        x: R() * this.width,
        y: (L?.waterY ?? H * 0.6) * (0.1 + R() * 0.9),
        vx: (R() - 0.5) * 6,
        vy: -(1 + R() * 4),
        r: 0.6 + R() * 1.6,
        ph: R() * Math.PI * 2,
        sp: 0.3 + R() * 0.5,
      });
    }
    this.glints = [];
    for (let i = 0; i < q.glints; i += 1) {
      const gx = (R() + R() + R() - 1.5) / 1.5;
      this.glints.push({
        x: gx * 0.5,
        y: R() * 0.6,
        vx: 0,
        vy: 0,
        r: 0.7 + R() * 1.7,
        ph: R() * Math.PI * 2,
        sp: 0.35 + R() * 0.9,
      });
    }
    this.streaks = [];
    for (let i = 0; i < q.streaks; i += 1) {
      this.streaks.push({
        fy: R(),
        fx: R(),
        fw: 0.08 + R() * 0.22,
        sp: 0.1 + R() * 0.22,
        ph: R() * Math.PI * 2,
        a: 0.35 + R() * 0.6,
        dark: i % 3 === 0,
      });
    }
    this.meteors = [];
    const meteorCount = q.streaks + (this.quality === 'high' ? 5 : this.quality === 'medium' ? 3 : 1);
    for (let i = 0; i < meteorCount; i += 1) {
      this.meteors.push({
        x: -80 + R() * (this.width + 80),
        y: -20 + R() * Math.max(1, H * 0.38),
        vx: 150 + R() * 210,
        vy: 70 + R() * 120,
        length: 70 + R() * 130,
        width: 0.7 + R() * 1.4,
        phase: R() * 12,
        cycle: (this.quality === 'high' ? 4.5 : this.quality === 'medium' ? 7 : 10) + R() * 9,
        travel: 0.55 + R() * 0.9,
        alpha: 0.24 + R() * 0.42,
      });
    }
    // Floating music glyphs around the instrument (reference photo 2).
    this.seedMusicNotes();
    this.ambientWorker?.resize(this.meteors);
    this.workerFrameReady = false;
  }

  private seedMusicNotes(): void {
    this.notesAmbient = [];
    if (this.noteSprites.length === 0) return;
    const R = mulberry32(20260822);
    const noteCount = Math.min(12, 6 + (this.quality === 'high' ? 4 : this.quality === 'medium' ? 2 : 0));
    for (let i = 0; i < noteCount; i += 1) {
      this.notesAmbient.push({
        fx: R(),
        fy: R(),
        sp: 0.14 + R() * 0.3,
        ph: R() * Math.PI * 2,
        glyph: i % this.noteSprites.length,
        size: 13 + R() * 15,
      });
    }
  }

  private ensureAmbientWorker(): void {
    if (this.ambientWorker !== undefined || this.ambientWorkerCreationFailed) return;
    const bridge = createAmbientWorker();
    if (bridge === undefined) {
      // A strict CSP may reject Blob workers; synchronous drawing stays.
      this.ambientWorkerCreationFailed = true;
      return;
    }
    bridge.onFrame((frame) => {
      this.workerMeteors = frame;
      this.workerFrameReady = true;
    });
    bridge.resize(this.meteors);
    this.ambientWorker = bridge;
  }

  /* ------------------------------ backdrops ------------------------------ */

  /**
   * The chat-card stage: one cached vertical wash, a horizon glow above the
   * keyboard line, a soft halo behind the instrument and a vignette. No
   * meteors, mist, grain or water — clean and quiet by design.
   */
  private drawCompactBackdrop(
    c: CanvasRenderingContext2D,
    L: PianoLayout,
    energy: number,
    skin: PianoSkin,
  ): void {
    const { width: W, height: H } = this;
    let bg = this.backdropGradient;
    if (bg === undefined) {
      bg = c.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, skin.backdrop.top);
      bg.addColorStop(0.55, skin.backdrop.mid);
      bg.addColorStop(1, skin.backdrop.bottom);
      this.backdropGradient = bg;
    }
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    if (this.horizonSprite !== undefined) {
      c.save();
      c.globalCompositeOperation = 'screen';
      const hy = L.keyTop + L.whiteH * 0.55;
      const hw = W * 0.72;
      c.globalAlpha = skin.backdrop.horizonAlpha * (0.85 + energy * 0.5);
      c.drawImage(this.horizonSprite, W / 2 - hw / 2, hy - hw * 0.19, hw, hw * 0.38);
      const haloW = L.pw * 1.5;
      c.globalAlpha = 0.09 + energy * 0.05;
      c.drawImage(this.horizonSprite, W / 2 - haloW / 2, L.top + L.grandH * 0.35 - haloW * 0.3, haloW, haloW * 0.6);
      c.restore();
    }

    let vg = this.vignetteGradient;
    if (vg === undefined && skin.backdrop.vignette > 0) {
      vg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.36, W / 2, H / 2, Math.max(W, H) * 0.74);
      vg.addColorStop(0, 'rgba(9,10,20,0)');
      vg.addColorStop(1, `rgba(9,10,20,${skin.backdrop.vignette})`);
      this.vignetteGradient = vg;
    }
    if (vg !== undefined) {
      c.fillStyle = vg;
      c.fillRect(0, 0, W, H);
    }
  }

  /**
   * The immersive stage: a barely-there warm moon behind glass refraction
   * streaks and soft ground fog, all tinted by the active skin.
   */
  private drawAtmosphereBackdrop(
    c: CanvasRenderingContext2D,
    L: PianoLayout,
    dyn: { energy: number; loudness: number },
    reduced: boolean,
    skin: PianoSkin,
  ): void {
    const { width: W, height: H } = this;
    // The immersive shell is transparent to the host, so the active family
    // must paint its own sky/sea wash before the light shafts and particles.
    let bg = this.backdropGradient;
    if (bg === undefined) {
      bg = c.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, skin.backdrop.top);
      bg.addColorStop(0.56, skin.backdrop.mid);
      bg.addColorStop(1, skin.backdrop.bottom);
      this.backdropGradient = bg;
    }
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    const strength = 0.04 + dyn.energy * 0.05;
    const my = H * 0.13;
    const mr = clamp(Math.min(W, H) * 0.04, 26, 54);

    if (this.moonSprite !== undefined) {
      c.save();
      c.globalCompositeOperation = 'screen';
      c.globalAlpha = 0.09 + dyn.loudness * 0.05;
      c.drawImage(this.moonSprite, W * 0.52 - mr * 3.25, my - mr * 3.25, mr * 6.5, mr * 6.5);
      c.globalAlpha = (0.09 + dyn.loudness * 0.05) * 0.72;
      c.drawImage(this.moonSprite, W * 0.52 - mr * 1.6, my - mr * 1.6, mr * 3.2, mr * 3.2);
      c.restore();
    }

    if (!reduced) {
      c.save();
      const tints: readonly Rgb[] = [skin.notes.low, skin.atmosphere.moon, skin.notes.mid];
      for (let i = 0; i < 5; i += 1) {
        const tint = tints[i % 3]!;
        const drift = Math.sin(this.ambientT * 0.03 + i * 1.9) * W * 0.08;
        const x = W * (0.16 + 0.17 * i) + drift;
        const w = W * (0.09 + 0.02 * Math.sin(i * 2.1));
        const grad = c.createLinearGradient(x - w / 2, 0, x + w / 2, L.waterY);
        grad.addColorStop(0, rgba(tint, strength));
        grad.addColorStop(0.5, rgba(tint, strength * 0.4));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = grad;
        c.beginPath();
        c.moveTo(x - w / 2, 0);
        c.quadraticCurveTo(x + Math.sin(this.ambientT * 0.06 + i) * 40, L.waterY * 0.5, x + w / 2 + Math.sin(this.ambientT * 0.05 + i) * 30, L.waterY);
        c.lineTo(x + w / 2, 0);
        c.closePath();
        c.fill();
      }
      c.restore();
    }

    if (this.horizonSprite !== undefined) {
      c.save();
      c.globalCompositeOperation = 'screen';
      c.globalAlpha = 0.07 + dyn.energy * 0.04;
      c.drawImage(this.horizonSprite, W * 0.06, this.seaHorizonY(L) - H * 0.15, W * 0.88, H * 0.3);
      c.restore();
    }
  }

  /* ------------------------------ dynamics ------------------------------ */

  private updateDynamics(options: PianoRenderOptions, reduced: boolean): void {
    const L = this.layout;
    if (L === undefined) return;
    const dt = this.frameDelta;
    this.lastMusic = options.musicalTime;

    // Future notes become falling comets; notes that reached their start hit.
    const lead = reduced ? COMET_LEAD_REDUCED : COMET_LEAD;
    const window = options.timeline.window(options.musicalTime - 0.4, options.musicalTime + lead);
    const active = new Set<string>();
    for (const note of window.notes) {
      active.add(note.id);
      let ribbon = this.ribbons.find(r => r.noteId === note.id);
      if (ribbon === undefined) {
        ribbon = {
          noteId: note.id,
          midi: note.midi,
          x: keyCenterX(L, note.midi),
          velocity: note.velocity,
          start: note.startTime,
          hold: Math.max(0.2, (note.endTime - note.startTime) * 0.8),
          ph: mulberry32(hash(note.id))() * Math.PI * 2,
          state: note.startTime <= options.musicalTime ? 'hit' : 'fall',
          t0: options.musicalTime,
        };
        this.ribbons.push(ribbon);
      }
      if (ribbon.state === 'fall' && options.musicalTime >= note.startTime) {
        ribbon.state = 'hit';
        ribbon.t0 = options.musicalTime;
        this.emitImpact({ id: note.id, midi: note.midi, velocity: note.velocity }, false);
      }
    }
    for (let i = this.ribbons.length - 1; i >= 0; i -= 1) {
      const r = this.ribbons[i];
      const noteActive = active.has(r.noteId);
      if (!noteActive && (r.state === 'hit' && options.musicalTime - r.t0 > 0.38)) {
        this.ribbons.splice(i, 1);
      }
    }

    const windowOn = options.timeline.window(options.musicalTime - 0.24, options.musicalTime);
    for (const event of windowOn.noteOnEvents) {
      if (event.noteId === undefined || event.midi === undefined || event.velocity === undefined) continue;
      const last = this.notified.get(event.noteId) ?? Number.NEGATIVE_INFINITY;
      if (options.musicalTime - last > 0.28) {
        this.notified.set(event.noteId, options.musicalTime);
        this.emitImpact({
          id: event.noteId,
          midi: event.midi,
          velocity: event.velocity,
        }, true);
      }
    }
    if (this.notified.size > 64) {
      for (const [id, t] of this.notified) {
        if (options.musicalTime - t > 1.2) this.notified.delete(id);
      }
    }

    const now = options.musicalTime;
    for (let i = this.impacts.length - 1; i >= 0; i -= 1) {
      const impact = this.impacts[i]!;
      const impactDelta = impact.wallT0 === undefined ? dt : this.wallDelta;
      if (impact.kind === 'spark' && impact.life !== undefined) {
        applySparkGravity(impact, impactDelta);
        impact.x += (impact.vx ?? 0) * impactDelta;
        impact.y += (impact.vy ?? 0) * impactDelta;
      }
      const age = impact.wallT0 === undefined ? now - impact.t0 : this.wallSeconds - impact.wallT0;
      if ((impact.life ?? 2.6) > 0 && age > (impact.life ?? 2.6)) this.impacts.splice(i, 1);
    }
    if (this.impacts.length > MAX_IMPACTS) this.impacts.splice(0, this.impacts.length - MAX_IMPACTS);
  }

  /**
   * All impact bursts derive their x from the sounding midi via the live
   * keyboard layout. Callers never pass raw coordinates — a normalized or
   * stale x here is what used to strand rings at the canvas's left edge.
   */
  private emitImpact(note: { id: string; midi: number; velocity: number }, manual: boolean): void {
    const L = this.layout;
    const skin = this.activeSkin;
    if (L === undefined || skin === undefined) return;
    const v = clamp(note.velocity, 0, 1);
    const hue = hueFor(note.midi, skin);
    const x = keyCenterX(L, note.midi);
    const now = this.lastMusic;
    const wallT0 = manual ? this.wallSeconds : undefined;
    const immersive = this.modeImmersive;
    // A flash marks every audible note; rings, ripples, pillars and spark
    // budgets scale with velocity so quiet passages stay clean while accents
    // bloom.
    this.impacts.push({ kind: 'flash', x, y: L.keyTop + 3, t0: now, wallT0, v, hue });
    if (v >= 0.26) {
      this.impacts.push({ kind: 'ring', x, y: L.keyTop + 4, t0: now, wallT0, v, hue });
    }
    if (immersive) {
      if (v >= 0.32) this.impacts.push({ kind: 'ripple', x, y: 0, t0: now, wallT0, v, hue });
      if (v >= 0.45) this.impacts.push({ kind: 'pillar', x, y: 0, t0: now, wallT0, v, hue });
    }
    const q = QUALITY[this.quality];
    const budget = manual
      ? q.sparksPerHit + 4
      : Math.round(q.sparksPerHit * (0.35 + v * 0.85)) - (immersive ? 0 : 3);
    const count = Math.max(manual ? 4 : 2, budget);
    const random = mulberry32(hash(`${note.id}:${String(Math.round(now * 1000))}`));
    for (let i = 0; i < count; i += 1) {
      const a = -Math.PI / 2 + (random() - 0.5) * 1.9;
      const speed = 24 + random() * 58 * v;
      this.impacts.push({
        kind: 'spark', x, y: L.keyTop + 2,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, g: 7, // px/s² downward in canvas space
        t0: now, wallT0: manual ? this.wallSeconds : undefined, v, hue,
        life: 0.9 + random() * 0.8, r: 1.1 + random() * 1.8,
      });
    }
  }

  /* ------------------------------ key animation ------------------------------ */

  private updateKeys(options: PianoRenderOptions, reduced: boolean): void {
    const L = this.layout;
    if (L === undefined) return;
    const targets = options.state.pressedMidi;
    const downSpeed = reduced ? 1 : this.frameDelta / 0.075;
    for (const midi of KEYBOARD_LAYOUT) {
      const current = this.pressed.get(midi.midi) ?? 0;
      // Sound may remain active under the sustain pedal, but the physical key
      // must return as soon as note-off removes it from pressedMidi.
      const next = targets.has(midi.midi) ? clamp(current + downSpeed, 0, 1) : 0;
      if (next > 0.001) this.pressed.set(midi.midi, next);
      else this.pressed.delete(midi.midi);
    }
  }

  /* ------------------------------ falling-note comets ------------------------------ */

  /**
   * Every visible note is a cached comet sprite: one drawImage per note per
   * frame, additive-blended in a single batch. The bright head lands exactly
   * on its key column and the tail stays short of the sky so the stage reads
   * elegant instead of scratched through.
   */
  private drawRibbons(
    c: CanvasRenderingContext2D,
    L: PianoLayout,
    options: PianoRenderOptions,
    reduced: boolean,
    skin: PianoSkin,
  ): void {
    if (this.cometSprites.length === 0) return;
    const musicT = options.musicalTime;
    const lead = reduced ? COMET_LEAD_REDUCED : COMET_LEAD;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const rb of this.ribbons) {
      const sprite = this.cometSprites[rb.midi < 50 ? 0 : rb.midi < 70 ? 1 : 2];
      if (sprite === undefined) continue;
      const w = 3 + rb.velocity * 4.2;
      if (rb.state === 'hit') {
        // The struck comet folds into its key as a quick fading ember.
        const k = clamp((musicT - rb.t0) / 0.34, 0, 1);
        if (k >= 1) continue;
        const h = Math.max(4, this.height * 0.15 * (1 - k));
        c.globalAlpha = (1 - k) * 0.72;
        c.drawImage(sprite, rb.x - w / 2, L.keyTop + 3 - h, w, h);
      } else {
        const p = clamp((musicT - (rb.start - lead)) / lead, 0, 1);
        if (p <= 0) continue;
        const eased = smoothish(p);
        const yTip = lerp(reduced ? L.keyTop - 46 : Math.max(16, this.height * 0.04), L.keyTop + 2, eased);
        const span = Math.min(yTip - 2, this.height * (0.05 + 0.2 * eased));
        c.globalAlpha = clamp(p / 0.1, 0, 1) * (0.42 + rb.velocity * 0.42);
        c.drawImage(sprite, rb.x - w / 2, yTip - span, w, span);
      }
    }
    c.restore();
    c.globalAlpha = 1;
  }


  /**
   * Elevated player view of a concert grand, matched to the reference
   * photography: a sloped key plane, a raised lid whose lit underside crowns
   * the instrument, and the accent felt runner above the keys. Every plane
   * shares one depth axis — the rear of
   * the instrument is narrower/higher and the keyboard projects toward the
   * viewer — so skins stay material-only data and a future WebGL backend can
   * consume the same model. Painted once per layout+skin into the cached
   * static layer, keeping per-frame cost flat.
   */
  private drawPianoBody(c: CanvasRenderingContext2D, L: PianoLayout, skin: PianoSkin): void {
    const pw = L.pw;
    const wh = L.whiteH;
    const rh = L.railH;
    const ky = L.lidH + L.padLid + L.backH;
    const ch = L.caseH;
    // The front rail starts exactly at the near edge of the key plane. The
    // keyboard-depth value belongs to the recessed bed beneath the keys; it
    // must not become a visible gap that makes the keyboard float.
    const railTop = L.frontRailY - L.top;
    const grand = skin.grand;
    const wire = grand.transparent;
    const line = wire ? grand.lineStrong : skin.case.edge;
    const referenceView = this.modeImmersive && skin.id === 'lacquer-gold';
    // The concert-grand staging gives the lid band enough elevation for a
    // realistic slab; shorter bands fall back to span-priority geometry.
    const tallBand = L.lidH > wh * 3;
    type Fill = string | CanvasGradient | null;
    const poly = (points: readonly ScenePoint[], fill: Fill, stroke: string | null, width = 1): void => {
      c.beginPath();
      c.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i += 1) c.lineTo(points[i]!.x, points[i]!.y);
      c.closePath();
      if (fill !== null) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke !== null) {
        c.strokeStyle = stroke;
        c.lineWidth = width;
        c.stroke();
      }
    };
    const vgrad = (y0: number, y1: number, stops: ReadonlyArray<readonly [number, string]>): CanvasGradient => {
      const g = c.createLinearGradient(0, y0, 0, y1);
      for (const [t, col] of stops) g.addColorStop(t, col);
      return g;
    };

    if (wire) {
      c.shadowColor = rgba(skin.notes.tip, 0.55);
      c.shadowBlur = Math.max(5, wh * 0.2);
    }

    // ---- Raised lid: a long, low slab seen from above, sweeping up toward
    // the treble (right) side like the reference photograph. A shallower
    // angle keeps the lid broad enough to read as a grand-piano lid.
    const baseY = L.lidH * 0.99;
    const riseMax = Math.max(10, L.lidH - 6);
    const startX = pw * 0.04;
    const runCap = pw * 0.9 - startX;
    const LID_ANGLE = referenceView ? Math.PI / 9 : Math.PI / 6;
    let run: number;
    if (tallBand) {
      // Concert-grand staging: hold the requested elevation and cap the span.
      run = Math.min(runCap * 0.98, riseMax / Math.tan(LID_ANGLE));
    } else {
      // Shorter bands prioritize span — a long shallow sweep reads like the
      // reference far better than a stubby 30° stub, so the angle relaxes.
      run = Math.min(runCap * 0.95, riseMax / Math.tan(LID_ANGLE * 0.55));
    }
    const rise = run * Math.tan(LID_ANGLE);
    const angle = Math.atan2(rise, run);
    const lidThicknessRatio = tallBand
      ? (referenceView ? 0.32 : 0.22)
      : (referenceView ? 0.18 : 0.14);
    const th = Math.max(referenceView ? 7 : 5, wh * lidThicknessRatio);
    // Perpendicular slab offset (up-left normal in screen space).
    const nx = -Math.sin(angle);
    const ny = -Math.cos(angle);
    const ax = startX;
    const ay = baseY;
    const bx = startX + run;
    const by = baseY - rise;
    const cx = bx + nx * th;
    const cy = by + ny * th;
    const dx = ax + nx * th;
    const dy = ay + ny * th;
    const slabFill = wire
      ? vgrad(dy, ay, [[0, 'rgba(255,244,214,0.06)'], [1, 'rgba(255,236,196,0.03)']])
      : vgrad(dy, ay, [[0, grand.lid], [0.7, grand.lidInner], [1, skin.case.lidBottom]]);
    poly([
      { x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy }, { x: dx, y: dy },
    ], slabFill, wire ? grand.lidEdge : skin.case.edge, wire ? 1.5 : 1.1);
    // Polished gold hardware strip rides the slab's upper edge.
    c.strokeStyle = grand.lidEdge;
    c.lineWidth = Math.max(1.1, th * 0.34);
    c.beginPath();
    c.moveTo(dx + (cx - dx) * 0.02, dy + (cy - dy) * 0.02);
    c.lineTo(dx + (cx - dx) * 0.98, dy + (cy - dy) * 0.98);
    c.stroke();
    if (referenceView) {
      // The lower parallel line exposes the polished underside thickness. It
      // is broad enough to survive dark backgrounds and small DPRs.
      c.strokeStyle = grand.lidInner;
      c.lineWidth = Math.max(1, th * 0.28);
      c.beginPath();
      c.moveTo(ax + (dx - ax) * 0.3, ay + (dy - ay) * 0.3);
      c.lineTo(bx + (cx - bx) * 0.3, by + (cy - by) * 0.3);
      c.stroke();
    }
    // Hinge knuckles dot the lower edge back toward the spine (left).
    const hingeCount = 7;
    c.fillStyle = wire ? grand.lineStrong : grand.hardware;
    for (let hi = 0; hi < hingeCount; hi += 1) {
      const ht = 0.04 + (hi / (hingeCount - 1)) * 0.42;
      c.globalAlpha = wire ? 0.8 : 0.9 - ht * 0.55;
      c.beginPath();
      c.arc(ax + (bx - ax) * ht, ay + (by - ay) * ht + 1, Math.max(1.2, wh * 0.03), 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
    // Lid prop: a thin stick from the treble shoulder to the slab underside.
    const propFrac = 0.76;
    const propTopX = ax + (bx - ax) * propFrac;
    const propTopY = ay + (by - ay) * propFrac + 2;
    c.strokeStyle = wire ? grand.lineStrong : grand.prop;
    c.lineWidth = Math.max(1.3, wh * 0.045);
    c.beginPath();
    c.moveTo(pw * 0.952, baseY + wh * 0.06);
    c.lineTo(propTopX, propTopY);
    c.stroke();

    // ---- Case shoulder between lid hinge and soundboard --------------------
    const openingTopLeft = referenceView
      ? L.lidH + L.padLid * 0.72 + wh * 0.18
      : L.lidH + L.padLid * 0.66;
    const openingTopRight = referenceView
      ? L.lidH + L.padLid * 0.72 + wh * 0.02
      : openingTopLeft;
    const openingTop = Math.min(openingTopLeft, openingTopRight);
    const bodyTop = baseY + (referenceView ? wh * 0.08 : 1);
    const shellFill = wire
      ? grand.shell
      : vgrad(bodyTop, ch, [[0, grand.shellHighlight], [0.16, grand.shell], [0.62, skin.case.lidMid], [1, grand.shellDeep]]);
    // The case broadens toward the player. A slightly rounded lower shoulder
    // keeps the silhouette closer to a real grand than a flat cabinet.
    const bodyPoints = referenceView
      ? [
          { x: pw * 0.035, y: bodyTop }, { x: pw * 0.965, y: bodyTop },
          { x: pw * 0.985, y: ch - rh * 0.44 },
          { x: pw * 0.965, y: ch - rh * 0.08 },
          { x: pw * 0.88, y: ch }, { x: pw * 0.12, y: ch },
          { x: pw * 0.035, y: ch - rh * 0.08 },
          { x: pw * 0.015, y: ch - rh * 0.44 },
        ]
      : [
          { x: pw * 0.01, y: bodyTop }, { x: pw * 0.99, y: bodyTop },
          { x: pw * 0.994, y: ch }, { x: pw * 0.006, y: ch },
        ];
    poly(bodyPoints, shellFill, wire ? grand.line : line, wire ? 1.5 : 1.05);
    if (!wire) {
      // Vertical speculars: polished lacquer mirrors the stage light strips.
      for (const [cx, cw, a] of [[pw * 0.115, pw * 0.035, 0.2], [pw * 0.86, pw * 0.022, 0.14]] as const) {
        const sheen = c.createLinearGradient(cx - cw, 0, cx + cw, 0);
        sheen.addColorStop(0, 'rgba(255,255,255,0)');
        sheen.addColorStop(0.5, `rgba(235,240,250,${a})`);
        sheen.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = sheen;
        c.fillRect(cx - cw, bodyTop + 4, cw * 2, (ch - bodyTop) * (referenceView ? 0.88 : 0.92));
      }
    }

    // ---- Soundboard opening: the warm interior remains visible under the
    // open lid. It is deliberately deeper than the fallboard so the player
    // sees the strings and plate from above.
    const opL = pw * (referenceView ? 0.09 : 0.14);
    const opR = pw * (referenceView ? 0.91 : 0.86);
    const opB = referenceView
      ? ky - Math.max(wh * 0.04, L.backH * 0.04)
      : ky - Math.max(wh * 0.22, L.backH * 0.3);
    const openFill = wire
      ? grand.interior
      : (() => {
        const gold = hexRgb(grand.interior);
        return vgrad(openingTop, opB, [
          [0, rgba(bumpRgb(gold, 1.5), 1)],
          [0.5, grand.interior],
          [1, rgba(bumpRgb(gold, 0.36), 1)],
        ]);
      })();
    poly([
      { x: opL, y: openingTopLeft }, { x: opR, y: openingTopRight },
      { x: opR + pw * (referenceView ? 0.018 : 0.008), y: opB },
      { x: opL - pw * (referenceView ? 0.018 : 0.008), y: opB },
    ], openFill, wire ? grand.trim : grand.trim, Math.max(1, wh * 0.03));
    // Strings fan subtly toward the player instead of reading as a flat
    // vertical barcode. The restrained spread is enough to imply the grand's
    // curved plate without drawing every physical part.
    const stringCount = 19;
    for (let i = 0; i < stringCount; i += 1) {
      const sx = opL + 7 + ((opR - opL) - 14) * (i / (stringCount - 1));
      const spread = referenceView ? (i - (stringCount - 1) / 2) * wh * 0.008 : 0;
      c.globalAlpha = wire ? 0.62 : (i % 2 === 0 ? 0.52 : 0.3);
      c.strokeStyle = grand.hardware;
      c.lineWidth = Math.max(0.55, wh * 0.014);
      c.beginPath();
      const topY = lerp(openingTopLeft, openingTopRight, i / (stringCount - 1));
      c.moveTo(sx, topY + 4);
      c.lineTo(sx + spread, opB - 4);
      c.stroke();
    }
    c.globalAlpha = 1;
    // Tuning-pin row and damper rail bracket the strings.
    c.fillStyle = wire ? grand.hardware : rgba(bumpRgb(hexRgb(grand.interior), 0.32), 1);
    for (let i = 0; i < stringCount; i += 1) {
      const sx = opL + 7 + ((opR - opL) - 14) * (i / (stringCount - 1));
      c.beginPath();
      const pinY = lerp(openingTopLeft, openingTopRight, i / (stringCount - 1));
      c.arc(sx, pinY + 4, Math.max(0.9, wh * 0.022), 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = grand.trim;
    c.lineWidth = Math.max(1, wh * 0.032);
    c.beginPath();
    c.moveTo(opL - pw * 0.006, opB - wh * 0.1);
    c.lineTo(opR + pw * 0.006, opB - wh * 0.1);
    c.stroke();

    // ---- Premium material passes: baked once into the static case layer so
    // the lacquer/pearl shell reads as a machined, lit object rather than a
    // flat slab. None of these run on the per-frame hot path, and the crisp
    // front elements (fallboard, rail, engraving, keys) are painted on top.
    if (!wire) {
      // Edge caustic (rim light): a crisp highlight tracing the case's top
      // shoulder, with a thin definition line beneath so the contour pops
      // even against light pearl shells.
      const rimY = baseY + (referenceView ? wh * 0.05 : 1);
      const rimH = Math.max(1.2, wh * 0.11);
      const rimGlow = bumpRgb(hexRgb(grand.shellHighlight), 1.3);
      const rim = c.createLinearGradient(0, rimY, 0, rimY + rimH * 1.8);
      rim.addColorStop(0, rgba(rimGlow, 0.9));
      rim.addColorStop(0.4, rgba(rimGlow, 0.3));
      rim.addColorStop(1, rgba(rimGlow, 0));
      c.strokeStyle = rim;
      c.lineWidth = rimH;
      c.beginPath();
      c.moveTo(pw * 0.012, rimY);
      c.lineTo(pw * 0.988, rimY);
      c.stroke();
      const rimSep = scaleRgb(hexRgb(grand.shellDeep), 0.72);
      const sep = c.createLinearGradient(0, rimY + rimH, 0, rimY + rimH + wh * 0.16);
      sep.addColorStop(0, rgba(rimSep, 0.5));
      sep.addColorStop(1, rgba(rimSep, 0));
      c.strokeStyle = sep;
      c.lineWidth = Math.max(1, wh * 0.06);
      c.beginPath();
      c.moveTo(pw * 0.03, rimY + rimH * 0.5);
      c.lineTo(pw * 0.97, rimY + rimH * 0.5);
      c.stroke();

      // Brushed metallic glints along the gold/rose trim band.
      const trimY = opB - wh * 0.1;
      const brush = bumpRgb(hexRgb(grand.hardware), 1.05);
      c.lineWidth = Math.max(0.7, wh * 0.018);
      for (let b = 0; b < 3; b += 1) {
        const bx = lerp(opL, opR, 0.16 + b * 0.34);
        const bw = pw * (0.1 + b * 0.02);
        const br = c.createLinearGradient(bx, 0, bx + bw, 0);
        br.addColorStop(0, rgba(brush, 0));
        br.addColorStop(0.5, rgba(brush, 1));
        br.addColorStop(1, rgba(brush, 0));
        c.strokeStyle = br;
        c.beginPath();
        c.moveTo(bx, trimY - wh * 0.012);
        c.lineTo(bx + bw, trimY - wh * 0.012);
        c.stroke();
      }

      // Volumetric light shaft raking across the lid and case, baked once.
      c.save();
      c.globalCompositeOperation = 'lighter';
      const bT = Math.max(2, bodyTop - wh * 0.4);
      const bB = ch - rh * 0.2;
      const beamX0 = pw * 0.34;
      const beamX1 = pw * 0.68;
      const shaft = c.createLinearGradient(beamX0, bT, beamX1 + pw * 0.1, bB);
      shaft.addColorStop(0, rgba(skin.atmosphere.moon, 0.13));
      shaft.addColorStop(0.55, rgba(skin.atmosphere.moon, 0.055));
      shaft.addColorStop(1, rgba(skin.atmosphere.moon, 0));
      c.fillStyle = shaft;
      c.beginPath();
      c.moveTo(beamX0 - pw * 0.05, bT);
      c.lineTo(beamX1 + pw * 0.1, bT);
      c.lineTo(beamX1 + pw * 0.02, bB);
      c.lineTo(beamX0 - pw * 0.18, bB);
      c.closePath();
      c.fill();
      c.restore();
    }

    // A simplified music desk anchors the eye in the open cavity. Its broad
    // dark face is the most recognizable front-facing detail in the reference
    // photo; the rest of the mechanism stays intentionally minimal.
    if (referenceView) {
      const deskTop = Math.max(openingTopLeft, openingTopRight) + (opB - Math.max(openingTopLeft, openingTopRight)) * 0.48;
      const deskBottom = opB + wh * 0.02;
      poly([
        { x: pw * 0.30, y: deskTop + wh * 0.04 },
        { x: pw * 0.70, y: deskTop + wh * 0.04 },
        { x: pw * 0.73, y: deskBottom },
        { x: pw * 0.27, y: deskBottom },
      ], skin.case.fallboardBottom, 'rgba(0,0,0,0.72)', Math.max(0.8, wh * 0.018));
    }

    // ---- Fallboard band directly above the keys ----------------------------
    const feltH = Math.max(2, wh * 0.05);
    const fbB = ky - feltH;
    const fbFill = wire
      ? skin.case.fallboardBottom
      : vgrad(opB, fbB, [[0, skin.case.fallboardTop], [1, skin.case.fallboardBottom]]);
    poly([
      { x: pw * 0.006, y: opB }, { x: pw * 0.994, y: opB },
      { x: pw * 0.99, y: fbB }, { x: pw * 0.01, y: fbB },
    ], fbFill, wire ? grand.line : line, wire ? 1.2 : 0.85);
    c.fillStyle = skin.case.fallboardSheen;
    c.fillRect(pw * 0.02, opB + 1, pw * 0.96, Math.max(0.7, wh * 0.024));

    // Key-plane projection helpers in body-local space: the keyboard recedes
    // toward the fallboard, so every keybed element shares its perspective.
    const kx = (localX: number, depth: number): number => projectKeyboardPoint(L, localX, depth).x;
    const backInsetX = kx(L.cheek, 0);
    const frontInsetX = kx(L.cheek, 1);

    // ---- Accent felt runner (follows the far edge) ---------------------------
    c.fillStyle = skin.case.feltStrip;
    c.fillRect(backInsetX, fbB, pw - backInsetX * 2, feltH);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(backInsetX, ky - 1, pw - backInsetX * 2, 1);

    // ---- Keybed recess behind the animated keys -----------------------------
    const recessFill = wire ? 'rgba(20,34,52,0.30)' : skin.case.keybedBottom;
    poly([
      { x: backInsetX, y: ky },
      { x: pw - backInsetX, y: ky },
      { x: pw - frontInsetX, y: railTop },
      { x: frontInsetX, y: railTop },
    ], recessFill, null, 0);
    poly([
      { x: frontInsetX, y: railTop },
      { x: pw - frontInsetX, y: railTop },
      { x: pw - frontInsetX, y: railTop + L.keyboardDepthY },
      { x: frontInsetX, y: railTop + L.keyboardDepthY },
    ], wire ? 'rgba(14,24,38,0.35)' : skin.case.railBottom, null, 0);

    // ---- Cheek blocks flanking the keyboard ----------------------------------
    for (const side of [0, 1]) {
      const outer = side === 0 ? pw * 0.006 : pw - pw * 0.006;
      const innerBack = side === 0 ? backInsetX : pw - backInsetX;
      const innerFront = side === 0 ? frontInsetX : pw - frontInsetX;
      const cheekFill = wire ? grand.shell : vgrad(fbB, railTop, [[0, grand.shellHighlight], [0.4, grand.shell], [1, grand.shellDeep]]);
      poly([
        { x: outer, y: fbB },
        { x: innerBack, y: fbB },
        { x: innerBack, y: ky },
        { x: innerFront, y: railTop + 2 },
        { x: outer, y: railTop + 2 },
      ], cheekFill, wire ? grand.line : line, wire ? 1.1 : 0.8);
    }

    // ---- Front rail with the maker's mark -----------------------------------
    // The fascia is the continuous front wall of the case: full width like
    // the shoulders, with the animated keys recessed into their slot above.
    const railFill = wire
      ? skin.case.railBottom
      : vgrad(railTop, ch, [[0, skin.case.railTop], [0.44, skin.case.railBottom], [1, grand.shellDeep]]);
    poly([
      { x: pw * 0.01, y: railTop }, { x: pw * 0.99, y: railTop },
      { x: pw * 0.994, y: ch }, { x: pw * 0.006, y: ch },
    ], railFill, wire ? grand.line : line, wire ? 1.3 : 0.85);
    const fs = Math.max(7, L.railH * 0.25);
    const gy = railTop + (ch - railTop) * 0.56;
    const gg = c.createLinearGradient(0, gy - fs, 0, gy + fs);
    gg.addColorStop(0, skin.case.engraving[0]);
    gg.addColorStop(0.55, skin.case.engraving[1]);
    gg.addColorStop(1, skin.case.engraving[2]);
    c.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = gg;
    c.fillText('DSH · PIANIST', pw / 2, gy);

    // ---- Tapered legs, brass casters and the pedal lyre ---------------------
    const legTop = ch - rh * 0.1;
    const legBottom = L.grandH - 3;
    const legXs = [pw * 0.185, pw * 0.815];
    for (const x of legXs) {
      const spread = Math.max(3, pw * 0.021);
      poly([
        { x: x - spread * 0.62, y: legTop }, { x: x + spread * 0.62, y: legTop },
        { x: x + spread * 0.5, y: legBottom }, { x: x - spread * 0.5, y: legBottom },
      ], wire ? null : grand.leg, wire ? grand.leg : grand.line, wire ? 1.2 : 0.7);
      if (wire) {
        // Warm light pools where each leg meets the sand (reference photo).
        const pool = c.createRadialGradient(x, legBottom, 1, x, legBottom, Math.max(6, wh * 0.5));
        pool.addColorStop(0, rgba(skin.notes.mid, 0.4));
        pool.addColorStop(1, rgba(skin.notes.mid, 0));
        c.fillStyle = pool;
        c.fillRect(x - wh * 0.5, legBottom - wh * 0.5, wh, wh);
      } else {
        c.fillStyle = grand.hardware;
        c.beginPath();
        c.ellipse(x, legBottom - 1, Math.max(1.4, wh * 0.035), Math.max(0.9, wh * 0.026), 0, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.strokeStyle = grand.pedal;
    c.lineWidth = Math.max(1, wh * 0.045);
    c.beginPath();
    c.moveTo(pw * 0.5, legTop + wh * 0.06);
    c.lineTo(pw * 0.5, legTop + L.legH * 0.56);
    c.moveTo(pw * 0.43, legTop + L.legH * 0.56);
    c.quadraticCurveTo(pw * 0.5, legTop + L.legH * 0.72, pw * 0.57, legTop + L.legH * 0.56);
    c.stroke();
    for (const px of [pw * 0.445, pw * 0.5, pw * 0.555]) {
      c.fillStyle = grand.pedal;
      c.beginPath();
      c.ellipse(px, legTop + L.legH * 0.74, Math.max(2.2, wh * 0.1), Math.max(1.1, wh * 0.04), 0, 0, Math.PI * 2);
      c.fill();
    }

    if (!wire) {
      c.shadowBlur = 0;
      return;
    }
    c.shadowBlur = 0;
  }

  /**
   * Animated keys over the static body. The key plane is a shallow sloped
   * surface: every key keeps its pitch column while its front edge drops
   * toward the player, so falling ribbons land exactly on the key they sound
   * and pointer cells match the drawn pixels one to one.
   */
  private drawPianoAndKeys(
    c: CanvasRenderingContext2D,
    L: PianoLayout,
    options: PianoRenderOptions,
    skin: PianoSkin,
  ): void {
    if (this.layer === undefined) return;

    // Soft halo behind the piano.
    c.save();
    c.globalCompositeOperation = 'screen';
    c.globalAlpha = 0.11;
    if (this.horizonSprite !== undefined) {
      c.drawImage(
        this.horizonSprite,
        this.width / 2 - L.pw * 0.75,
        L.top + L.grandH * 0.35 - L.pw * 0.45,
        L.pw * 1.5,
        L.pw * 0.9,
      );
    }
    c.restore();
    c.globalAlpha = 1;

    c.drawImage(this.layer, L.x0, L.top, L.pw, L.grandH);
    if (!options.showKeyboard) return;

    const energy = options.atmosphere?.energy ?? 0;
    const kH = clamp(L.whiteH / 60, 0.6, 1.4);
    const travelWhite = skin.keys.travelWhite * kH;
    const travelBlack = skin.keys.travelBlack * kH;
    const wire = skin.grand.transparent;
    const referenceView = this.modeImmersive && skin.id === 'lacquer-gold';

    // Pressed-key glow pool, batched under the keys. Whites anchor to the
    // key plane's mid depth so the pool sits under the visible key top.
    if (this.pressGlowSprite !== undefined) {
      c.save();
      c.globalCompositeOperation = 'screen';
      const gh = L.whiteH * 0.62;
      for (const key of KEYBOARD_LAYOUT) {
        const anim = this.pressed.get(key.midi) ?? 0;
        if (anim <= 0.05) continue;
        const gw = (key.isBlack ? L.blackW : L.whiteW) * 2.3;
        let gx: number;
        if (key.isBlack) {
          gx = keyCenterX(L, key.midi) - gw / 2;
        } else {
          const index = WHITE_INDEX_BY_MIDI.get(key.midi) ?? 0;
          gx = L.x0 + projectKeyboardPoint(L, L.cheek + (index + 0.5) * L.whiteW, KEY_PLANE_DEPTH).x - gw / 2;
        }
        const gy = key.isBlack
          ? L.keyboardBackY + BLACK_KEY_DEPTH_FRONT * L.whiteH - 4
          : L.keyboardFrontY - gh * 0.45;
        c.globalAlpha = (key.isBlack ? 0.23 : 0.28) * anim * (0.55 + energy * 0.45);
        c.drawImage(this.pressGlowSprite, gx, gy, gw, gh);
      }
      c.restore();
      c.globalAlpha = 1;
    }

    // White keys share one depth plane with a subtly wider near edge, like a
    // keyboard viewed from the player's standing position.
    // Keyboard-plane projection into canvas space. projectKeyboardPoint
    // already returns absolute Y (the layout anchors are canvas-space), so no
    // extra stage offset may be added here — double-counting it detaches the
    // keys from the case by exactly the stage margin.
    const project = (localX: number, depth: number, extraY = 0): ScenePoint => {
      const point = projectKeyboardPoint(L, localX, depth, extraY);
      return { x: L.x0 + point.x, y: point.y };
    };
    const fillQuad = (points: readonly ScenePoint[], fill: string | CanvasGradient | null, stroke: string | null, width = 0.65): void => {
      c.beginPath();
      c.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i += 1) c.lineTo(points[i]!.x, points[i]!.y);
      c.closePath();
      if (fill !== null) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke !== null) {
        c.strokeStyle = stroke;
        c.lineWidth = width;
        c.stroke();
      }
    };
    // Every white key shares the same plane depth, so one vertical gradient
    // (and one stroke color) serves all 52 columns — created once and reused
    // until a pressed key's travel or the skin changes the geometry key.
    const whiteStroke = wire ? null : rgba(skin.keys.whiteShade, 0.36);
    const whiteFaceDepth = whiteKeyFaceDepth(L, referenceView);
    let whiteFaceGradient = this.whiteKeyFaceGradient;
    if (whiteFaceGradient === undefined) {
      whiteFaceGradient = c.createLinearGradient(
        0,
        L.keyboardFrontY,
        0,
        L.keyboardFrontY + whiteFaceDepth,
      );
      whiteFaceGradient.addColorStop(0, skin.keys.whiteTop);
      whiteFaceGradient.addColorStop(0.2, skin.keys.whiteBottom);
      whiteFaceGradient.addColorStop(1, rgba(skin.keys.whiteShade, 0.62));
      this.whiteKeyFaceGradient = whiteFaceGradient;
    }
    let whiteGradientKey = '';
    for (const key of KEYBOARD_LAYOUT) {
      if (key.isBlack) continue;
      const index = WHITE_INDEX_BY_MIDI.get(key.midi) ?? 0;
      const anim = this.pressed.get(key.midi) ?? 0;
      const off = anim * travelWhite;
      const backL = project(L.cheek + index * L.whiteW, 0, off);
      const backR = project(L.cheek + (index + 1) * L.whiteW, 0, off);
      const frontR = project(L.cheek + (index + 1) * L.whiteW, 1, off);
      const frontL = project(L.cheek + index * L.whiteW, 1, off);
      const quad = [backL, backR, frontR, frontL];
      if (!wire) {
        const gKey = `${skin.id}|${backL.y.toFixed(1)}|${frontL.y.toFixed(1)}`;
        if (whiteGradientKey !== gKey || this.whiteKeyGradient === undefined) {
          const g = c.createLinearGradient(0, backL.y, 0, frontL.y);
          g.addColorStop(0, skin.keys.whiteTop);
          g.addColorStop(0.52, skin.keys.whiteMid);
          g.addColorStop(1, skin.keys.whiteBottom);
          this.whiteKeyGradient = g;
          whiteGradientKey = gKey;
        }
        fillQuad(quad, this.whiteKeyGradient, whiteStroke);
      }
      if (this.whiteSprite !== undefined) {
        c.save();
        c.beginPath();
        c.moveTo(backL.x, backL.y); c.lineTo(backR.x, backR.y); c.lineTo(frontR.x, frontR.y); c.lineTo(frontL.x, frontL.y);
        c.closePath();
        c.clip();
        if (wire) c.globalAlpha = 0.55;
        c.drawImage(this.whiteSprite, Math.min(backL.x, frontL.x), backL.y + 0.2, Math.max(frontR.x, backR.x) - Math.min(backL.x, frontL.x), Math.max(frontL.y, frontR.y) - backL.y);
        c.restore();
      }
      if (anim > 0.02) {
        fillQuad(quad, wire
          ? rgba(skin.keys.pressGlow, 0.3 * anim)
          : rgba(skin.keys.pressedWhiteTint, skin.keys.pressedWhiteTintAlpha * anim), null, 0);
      }
      // A filled front face plus two bevel lines turns each white key into a
      // shallow key cap instead of a flat painted strip.
      if (!wire) {
        const lipL = project(L.cheek + index * L.whiteW, 1, off + whiteFaceDepth);
        const lipR = project(L.cheek + (index + 1) * L.whiteW, 1, off + whiteFaceDepth);
        fillQuad(
          [frontL, frontR, lipR, lipL],
          whiteFaceGradient,
          rgba(skin.keys.whiteShade, 0.58),
          0.65,
        );
        c.strokeStyle = 'rgba(255,255,255,0.62)';
        c.lineWidth = 0.7;
        c.beginPath();
        c.moveTo(backL.x + 0.5, backL.y + 0.8);
        c.lineTo(backR.x - 0.5, backR.y + 0.8);
        c.stroke();
        c.strokeStyle = rgba(skin.keys.whiteShade, 0.34);
        c.beginPath();
        c.moveTo(frontR.x - 0.35, frontR.y);
        c.lineTo(lipR.x - 0.35, lipR.y);
        c.stroke();
        c.strokeStyle = rgba(skin.keys.whiteShade, 0.58);
        c.lineWidth = 0.8;
        c.beginPath();
        c.moveTo(lipL.x + 0.5, lipL.y - 0.45);
        c.lineTo(lipR.x - 0.5, lipR.y - 0.45);
        c.stroke();
      } else {
        fillQuad(quad, null, skin.grand.line, 1);
      }
    }

    // Ebony keys: their tops lie on the rear half of the key plane, raised as
    // small prisms with visible side and front faces.
    const blackFaceDepth = blackKeyFaceDepth(L, referenceView);
    const blackBackDepth = blackFaceDepth * 0.38;
    let blackFaceGradient = this.blackKeyFaceGradient;
    if (blackFaceGradient === undefined) {
      const faceTop = L.keyboardBackY + BLACK_KEY_DEPTH_FRONT * (L.keyboardFrontY - L.keyboardBackY);
      blackFaceGradient = c.createLinearGradient(0, faceTop, 0, faceTop + blackFaceDepth);
      blackFaceGradient.addColorStop(0, skin.keys.blackBody);
      blackFaceGradient.addColorStop(0.32, skin.keys.blackBottom);
      blackFaceGradient.addColorStop(1, '#000000');
      this.blackKeyFaceGradient = blackFaceGradient;
    }
    for (const key of KEYBOARD_LAYOUT) {
      if (!key.isBlack) continue;
      const centerLocal = L.cheek + keyCenterOffsetUnits(key.midi) * L.whiteW;
      const half = L.blackW / 2;
      const anim = this.pressed.get(key.midi) ?? 0;
      const off = anim * travelBlack;
      const backL = project(centerLocal - half, BLACK_KEY_DEPTH_BACK, off);
      const backR = project(centerLocal + half, BLACK_KEY_DEPTH_BACK, off);
      const frontR = project(centerLocal + half * 0.92, BLACK_KEY_DEPTH_FRONT, off);
      const frontL = project(centerLocal - half * 0.92, BLACK_KEY_DEPTH_FRONT, off);
      const baseBackL = project(centerLocal - half, BLACK_KEY_DEPTH_BACK, off + blackBackDepth);
      const baseBackR = project(centerLocal + half, BLACK_KEY_DEPTH_BACK, off + blackBackDepth);
      const faceR = project(centerLocal + half * 0.92, BLACK_KEY_DEPTH_FRONT, off + blackFaceDepth);
      const faceL = project(centerLocal - half * 0.92, BLACK_KEY_DEPTH_FRONT, off + blackFaceDepth);
      if (!wire) {
        const shadowDrop = Math.max(2, L.whiteH * 0.055);
        fillQuad([
          { x: backL.x + shadowDrop * 0.35, y: backL.y + shadowDrop },
          { x: backR.x + shadowDrop * 0.35, y: backR.y + shadowDrop },
          { x: frontR.x + shadowDrop * 0.7, y: frontR.y + shadowDrop * 1.35 },
          { x: frontL.x + shadowDrop * 0.7, y: frontL.y + shadowDrop * 1.35 },
        ], 'rgba(0,0,0,0.42)', null, 0);
        fillQuad([backL, frontL, faceL, baseBackL], skin.keys.blackBody, skin.keys.blackTip, 0.55);
        fillQuad([backR, baseBackR, faceR, frontR], skin.keys.blackBottom, 'rgba(0,0,0,0.7)', 0.55);
        fillQuad([frontL, frontR, faceR, faceL], blackFaceGradient, 'rgba(0,0,0,0.7)', 0.7);
      }
      // Guaranteed base wash keeps ebony present even if sprite blitting is
      // unavailable in a constrained environment.
      fillQuad([backL, backR, frontR, frontL], wire ? 'rgba(14,28,46,0.55)' : skin.keys.blackBody, null, 0);
      if (this.blackSprite !== undefined) {
        c.save();
        c.beginPath();
        c.moveTo(backL.x, backL.y); c.lineTo(backR.x, backR.y); c.lineTo(frontR.x, frontR.y); c.lineTo(frontL.x, frontL.y);
        c.closePath();
        c.clip();
        if (wire) c.globalAlpha = 0.5;
        c.drawImage(this.blackSprite, Math.min(backL.x, frontL.x), backL.y, L.blackW, L.blackH + 4);
        c.restore();
      }
      if (wire) {
        fillQuad([backL, backR, frontR, frontL], null, skin.grand.lineStrong, 1);
      } else {
        // Crisp crown edges keep the raised top distinct from its side faces.
        c.strokeStyle = skin.keys.blackTip;
        c.lineWidth = 0.8;
        c.beginPath();
        c.moveTo(backL.x + 0.7, backL.y + 1);
        c.lineTo(frontL.x + 0.7, frontL.y - 0.4);
        c.stroke();
        c.strokeStyle = 'rgba(0,0,0,0.78)';
        c.beginPath();
        c.moveTo(frontL.x + 0.5, frontL.y + 0.4);
        c.lineTo(frontR.x - 0.5, frontR.y + 0.4);
        c.stroke();
      }
      if (anim > 0.02) {
        fillQuad([backL, backR, frontR, frontL], rgba(skin.notes.tip, 0.42 * anim), null, 0);
      }
    }

    // Key cage depth shadow.
    let kg = this.keybedShadowGradient;
    if (kg === undefined) {
      kg = c.createLinearGradient(0, L.keyTop, 0, L.keyTop + L.whiteH * 0.24);
      kg.addColorStop(0, skin.case.keybedShadow);
      kg.addColorStop(1, 'rgba(0,0,0,0)');
      this.keybedShadowGradient = kg;
    }
    c.fillStyle = kg;
    c.fillRect(L.x0 + L.keyboardBackInset - 2, L.keyboardBackY, L.pw - L.keyboardBackInset * 2 + 4, L.whiteH * 0.24);
  }

  /* ------------------------------ glass water ------------------------------ */

  /** Visual horizon used for subtle reflection light, not a separate backdrop band. */
  private seaHorizonY(L: PianoLayout): number {
    return Math.max(L.top + L.grandH * 0.25, L.waterY - Math.max(34, this.height * 0.16));
  }

  /** Paint reflection details over the single, continuous backdrop. */
  private drawWaterAndReflection(
    c: CanvasRenderingContext2D,
    L: PianoLayout,
    dyn: { energy: number; loudness: number; low: number },
    reduced: boolean,
    q: QualityPreset,
    skin: PianoSkin,
    transientEffects: boolean,
  ): void {
    const wy = L.waterY;
    const H = this.height;
    const W = this.width;
    // These translucent details add depth without introducing a second
    // background color below the instrument.
    const horizonY = this.seaHorizonY(L);

    // Warm light path falling from the horizon glow onto the sea.
    if (transientEffects && this.moonSprite !== undefined) {
      c.save();
      c.globalCompositeOperation = 'screen';
      const pathW = L.pw * (0.4 + dyn.low * 0.16);
      c.globalAlpha = 0.14 + dyn.loudness * 0.12;
      c.drawImage(this.moonSprite, W / 2 - pathW / 2, horizonY + 2, pathW, Math.max(10, wy - horizonY));
      // Moon path shimmering on the waterline.
      c.globalAlpha = 0.16 + dyn.loudness * 0.13;
      const ph = pathW * 0.36;
      c.drawImage(this.moonSprite, W / 2 - pathW / 2, wy + 18 - ph / 2, pathW, ph);
      c.restore();
    }

    // Piano reflection on wet sand: only the base of the instrument — legs,
    // pedal lyre and case foot — is mirrored. Reflecting the whole body used
    // to float bright key-white rectangles across the shore.
    const n = q.reflectionSlices;
    const sliceH = 4.5;
    // The mirrored band never reaches above the lower quarter of the body.
    const refSpan = Math.min(L.grandH * 0.26, sliceH * n);
    const refA = (0.06 + dyn.loudness * 0.04) * (reduced ? 0.45 : 1);
    if (this.layer !== undefined && refA > 0.01) {
      c.save();
      for (let i = 0; i < n; i += 1) {
        const syCss = L.grandH - (i + 1) * sliceH;
        if (syCss < 0 || L.grandH - syCss > refSpan) break;
        const fade = Math.pow(1 - i / n, 2.1);
        const off = reduced ? 0 : Math.sin(this.ambientT * 0.7 + i * 0.55) * (1 + i * 0.16);
        c.globalAlpha = refA * fade;
        c.drawImage(
          this.layer,
          0, Math.max(0, syCss) * this.dpr, this.layer.width, Math.min(sliceH, L.grandH - syCss) * this.dpr,
          L.x0 + off, wy + 2 + i * sliceH * 0.94, L.pw, sliceH * 0.94,
        );
      }
      c.restore();
    }

    // Glassy light streaks + impact light pillars.
    c.save();
    const darkMoon = scaleRgb(skin.atmosphere.moon, 0.30);
    // Cached horizontal unit gradients, stretched per streak through the
    // transform so the loop allocates nothing per frame.
    if (this.streakUnits === undefined || this.streakUnitsSkinId !== skin.id) {
      const unit = (col: Rgb): CanvasGradient => {
        const ug = c.createLinearGradient(0, 0, 1, 0);
        ug.addColorStop(0, rgba(col, 0));
        ug.addColorStop(0.5, rgba(col, 1));
        ug.addColorStop(1, rgba(col, 0));
        return ug;
      };
      this.streakUnits = { dark: unit(darkMoon), light: unit([252, 240, 224] as const) };
      this.streakUnitsSkinId = skin.id;
    }
    for (const st of this.streaks) {
      const yy = wy + 8 + st.fy * Math.min(H - wy, H * 0.3);
      const drift = reduced ? 0 : Math.sin(this.ambientT * st.sp + st.ph) * (12 + dyn.low * 26);
      const xx = W * st.fx + drift;
      const ww = W * st.fw;
      const a = (st.dark ? 0.05 : 0.05 + dyn.low * 0.05) * st.a;
      c.save();
      c.translate(xx, yy);
      c.scale(Math.max(1, ww), 1);
      c.globalAlpha = Math.max(0, Math.min(1, a));
      c.fillStyle = st.dark ? this.streakUnits.dark : this.streakUnits.light;
      c.fillRect(0, 0, 1, 1);
      c.restore();
    }

    if (transientEffects) {
      c.globalCompositeOperation = 'screen';
      for (const impact of this.impacts) {
        if (impact.kind !== 'pillar') continue;
        const k = this.impactAge(impact) / 1.8;
        if (k >= 1) continue;
        const a = (1 - k) * 0.12 * impact.v;
        const hh = 50 + k * 50;
        const pg = c.createLinearGradient(0, wy, 0, wy + hh);
        pg.addColorStop(0, rgba(skin.notes.high, a));
        pg.addColorStop(1, rgba(skin.notes.high, 0));
        c.fillStyle = pg;
        c.fillRect(impact.x - (1.5 + k * 5), wy, 3 + k * 10, hh);
      }
    }
    c.restore();
  }

  /* ------------------------------ music glyphs ------------------------------ */

  /** Warm luminous notes floating around the instrument (seaside family). */
  private drawMusicNotes(c: CanvasRenderingContext2D, L: PianoLayout, reduced: boolean): void {
    if (this.noteSprites.length === 0 || this.notesAmbient.length === 0) return;
    c.save();
    c.globalCompositeOperation = 'screen';
    const t = this.ambientT;
    const W = this.width;
    const riseSpan = Math.max(60, L.top + L.grandH * 0.42);
    for (const n of this.notesAmbient) {
      const sprite = this.noteSprites[n.glyph];
      if (sprite === undefined) continue;
      const cycle = reduced ? n.fy : ((t * 0.012 * n.sp + n.fy) % 1 + 1) % 1;
      const x = W / 2 + (n.fx - 0.5) * L.pw * 1.75 + Math.sin(t * 0.05 + n.ph) * 10;
      const y = L.top + L.grandH * 0.55 + cycle * -riseSpan;
      if (y < -30) continue;
      const twinkle = Math.max(0, Math.sin(t * n.sp + n.ph));
      const alpha = reduced ? 0.16 : (0.14 + twinkle * 0.34) * Math.min(1, cycle * 4 + 0.25);
      const w = n.size * 1.7;
      c.globalAlpha = alpha;
      c.drawImage(sprite, x - w / 2, y - w / 2, w, w);
    }
    c.restore();
  }

  /* ------------------------------ impacts & ambient ------------------------------ */

  private drawImpacts(c: CanvasRenderingContext2D, L: PianoLayout): void {
    c.save();
    c.globalCompositeOperation = 'screen';
    for (const impact of this.impacts) {
      if (impact.kind !== 'flash') continue;
      const k = this.impactAge(impact) / 0.45;
      if (k >= 1) continue;
      const a = (1 - k) * (0.12 + impact.v * 0.14);
      const rg = c.createRadialGradient(impact.x, impact.y, 0, impact.x, impact.y, 6 + k * 14);
      // The core stays warm and hue-tinted so chord clusters glow instead of
      // blowing out into white patches.
      rg.addColorStop(0, 'rgba(255,250,238,0.85)');
      rg.addColorStop(0.45, rgba(impact.hue, a * 0.36));
      rg.addColorStop(1, rgba(impact.hue, 0));
      c.fillStyle = rg;
      c.beginPath();
      c.arc(impact.x, impact.y, 6 + k * 14, 0, Math.PI * 2);
      c.fill();
    }
    for (const impact of this.impacts) {
      if (impact.kind !== 'ring') continue;
      const k = this.impactAge(impact) / 0.85;
      if (k >= 1) continue;
      c.globalAlpha = (1 - k) * (0.20 + impact.v * 0.14);
      c.strokeStyle = rgba(impact.hue, 1);
      c.lineWidth = 1;
      c.beginPath();
      c.arc(impact.x, impact.y, 6 + easeOutCubic(k) * (30 + impact.v * 26), 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'lighter';
    for (const impact of this.impacts) {
      if (impact.kind !== 'spark' || impact.life === undefined) continue;
      const k = this.impactAge(impact) / impact.life;
      if (k >= 1) continue;
      const a = (1 - k) * 0.6;
      c.globalAlpha = a;
      c.fillStyle = rgba(impact.hue, 1);
      c.beginPath();
      c.arc(impact.x, impact.y, (impact.r ?? 1) * (1 - k * 0.5), 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
    // Ripples on the water (immersive only — never emitted in compact cards).
    const wy = L.waterY;
    for (const impact of this.impacts) {
      if (impact.kind !== 'ripple') continue;
      const k = this.impactAge(impact) / 2.6;
      if (k >= 1) continue;
      const rx = 8 + easeOutCubic(k) * (40 + impact.v * 40);
      c.globalAlpha = (1 - k) * 0.15;
      c.strokeStyle = rgba(impact.hue, 1);
      c.lineWidth = 1;
      c.save();
      c.translate(impact.x, wy + 10);
      c.scale(1, 0.22);
      c.beginPath();
      c.arc(0, 0, rx, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
    c.globalAlpha = 1;
    c.restore();
  }

  private drawAmbient(
    c: CanvasRenderingContext2D,
    L: PianoLayout,
    dyn: { energy: number; high: number },
    reduced: boolean,
    q: QualityPreset,
    particles: boolean,
    skin: PianoSkin,
  ): void {
    const { width: W, height: H } = this;
    const wy = L.waterY;
    if (!reduced && skin.atmosphere.meteors) this.drawMeteors(c, this.wallSeconds, dyn.high, skin);
    if (!reduced && particles) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const mote of this.motes) {
        mote.x += mote.vx * this.wallDelta;
        mote.y += mote.vy * this.wallDelta;
        if (mote.y < H * 0.18) { mote.y = wy + 6; mote.x = (mote.x + W * 0.37) % W; }
        if (mote.x < -12) mote.x = W + 10;
        if (mote.x > W + 12) mote.x = -10;
        const tw = 0.4 + 0.6 * Math.sin(this.ambientT * mote.sp + mote.ph);
        const a = 0.05 * tw * (0.35 + dyn.high * 0.5);
        if (a < 0.004) continue;
        c.globalAlpha = a;
        if (this.dropletSprite !== undefined) c.drawImage(this.dropletSprite, mote.x - mote.r * 4, mote.y - mote.r * 4, mote.r * 8, mote.r * 8);
      }
      c.restore();
    }
    if (particles) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const glint of this.glints) {
        const tw = Math.sin(this.ambientT * glint.sp + glint.ph);
        const a = Math.max(0, tw) * (0.16 + dyn.high * 0.2);
        if (a < 0.012) continue;
        const gx = W / 2 + glint.x * L.pw * 2.6;
        const gy = wy + 6 + glint.y * H * 0.22;
        c.globalAlpha = a;
        c.fillStyle = rgba(skin.notes.tip, 1);
        c.beginPath();
        c.arc(gx, gy, glint.r, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
    c.globalAlpha = 1;
  }

  private drawMeteors(c: CanvasRenderingContext2D, time: number, high: number, skin: PianoSkin): void {
    const W = this.width;
    const H = this.height * 0.58;
    c.save();
    c.globalCompositeOperation = 'lighter';
    if (this.ambientWorker !== undefined) {
      if (time - this.lastWorkerRequest >= 1 / 30 || time < this.lastWorkerRequest) {
        const accepted = this.ambientWorker.request(time, high);
        if (accepted) {
          this.lastWorkerRequest = time;
        } else {
          this.ambientWorker.dispose();
          this.ambientWorker = undefined;
          this.workerMeteors = undefined;
          this.workerFrameReady = false;
          this.ambientWorkerCreationFailed = true;
        }
      }
      if (this.ambientWorker !== undefined && this.workerFrameReady && this.workerMeteors !== undefined) {
        const values = this.workerMeteors;
        for (let index = 0; index + AMBIENT_METEOR_STRIDE - 1 < values.length; index += AMBIENT_METEOR_STRIDE) {
          const x = values[index]!;
          const y = values[index + 1]!;
          if (x < -160 || x > W + 160 || y > H + 160) continue;
          this.drawMeteor(c, x, y, values[index + 2]!, values[index + 3]!, values[index + 4]!, values[index + 5]!, skin);
        }
        c.restore();
        return;
      }
    }
    for (const meteor of this.meteors) {
      const elapsed = ((time + meteor.phase) % meteor.cycle + meteor.cycle) % meteor.cycle;
      if (elapsed > meteor.travel) continue;
      const progress = elapsed / meteor.travel;
      const envelope = Math.sin(Math.PI * Math.pow(progress, 0.72));
      const x = meteor.x + elapsed * meteor.vx;
      const y = meteor.y + elapsed * meteor.vy;
      if (x < -meteor.length || x > W + meteor.length || y > H + meteor.length) continue;
      const tailX = x - meteor.length;
      const tailY = y - meteor.length * meteor.vy / meteor.vx;
      const alpha = meteor.alpha * envelope * (0.72 + high * 0.35);
      this.drawMeteor(c, x, y, tailX, tailY, meteor.width, alpha, skin);
    }
    c.restore();
  }

  private drawMeteor(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    tailX: number,
    tailY: number,
    width: number,
    alpha: number,
    skin: PianoSkin,
  ): void {
    // The trail inherits the family's moonlight so it never clashes with the
    // active palette. A cached horizontal unit gradient is stretched along
    // the tail axis, so per-frame drawing allocates nothing; stop alphas are
    // baked at unit strength and scaled through globalAlpha.
    if (this.meteorTrailUnit === undefined || this.meteorTrailSkinId !== skin.id) {
      const ug = c.createLinearGradient(0, 0, 1, 0);
      ug.addColorStop(0, rgba(skin.atmosphere.moon, 0));
      ug.addColorStop(0.62, rgba(skin.atmosphere.moon, 0.16));
      ug.addColorStop(0.9, rgba(skin.notes.tip, 0.58));
      ug.addColorStop(1, rgba(skin.notes.high, 1));
      this.meteorTrailUnit = ug;
      this.meteorTrailSkinId = skin.id;
    }
    const len = Math.max(1, Math.hypot(x - tailX, y - tailY));
    const angle = Math.atan2(y - tailY, x - tailX);
    c.save();
    c.globalAlpha = clamp(alpha, 0, 1);
    c.translate(tailX, tailY);
    c.rotate(angle);
    c.scale(len, 1);
    c.fillStyle = this.meteorTrailUnit;
    c.fillRect(0, -width / 2, 1, width);
    c.restore();
    c.globalAlpha = clamp(alpha * 0.65, 0, 0.28);
    c.strokeStyle = rgba(skin.atmosphere.moon, 1);
    c.lineWidth = width * 3.4;
    c.beginPath();
    c.moveTo(lerp(tailX, x, 0.76), lerp(tailY, y, 0.76));
    c.lineTo(x, y);
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = rgba(skin.notes.high, alpha);
    c.beginPath();
    c.arc(x, y, width * 1.6, 0, Math.PI * 2);
    c.fill();
  }

  private impactAge(impact: Impact): number {
    return impact.wallT0 === undefined ? this.lastMusic - impact.t0 : this.wallSeconds - impact.wallT0;
  }

  /* ------------------------------ film grain ------------------------------ */

  private ensureGrainTile(): HTMLCanvasElement | undefined {
    if (this.grainTile !== undefined) return this.grainTile;
    const tile = document.createElement('canvas');
    tile.width = 96;
    tile.height = 96;
    const tc = tile.getContext('2d');
    if (tc === null) return undefined;
    const random = mulberry32(20260821);
    for (let y = 0; y < 96; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const v = Math.floor(108 + random() * 44);
        tc.fillStyle = `rgb(${v},${v},${v})`;
        tc.fillRect(x, y, 1, 1);
      }
    }
    this.grainTile = tile;
    return tile;
  }

  private drawGrain(c: CanvasRenderingContext2D): void {
    if (this.grainPattern === undefined) {
      const tile = this.ensureGrainTile();
      if (tile === undefined) return;
      const pattern = c.createPattern(tile, 'repeat');
      if (pattern === null) return;
      this.grainPattern = pattern;
    }
    c.save();
    c.globalAlpha = 0.022;
    c.fillStyle = this.grainPattern;
    c.fillRect(0, 0, this.width, this.height);
    c.restore();
  }

  /* ------------------------------ helpers ------------------------------ */
}

/** Ivory / ebony key sprites with rounded corners, shading, gloss — and the black-key drop shadow baked in. */
function keySprite(kind: 'white' | 'black', w: number, h: number, s: number, skin: PianoSkin): HTMLCanvasElement {
  const shadowPad = kind === 'black' ? 4 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(Math.max(1, w + 2) * s);
  canvas.height = Math.ceil(Math.max(1, h + shadowPad) * s);
  const c = canvas.getContext('2d');
  if (c === null) return canvas;
  c.scale(s, s);
  if (kind === 'white') {
    const edge = hexRgb(skin.keys.whiteBottom);
    const sideShade = scaleRgb(hexRgb(skin.keys.blackBody), 1);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, skin.keys.whiteBottom);
    g.addColorStop(0.09, skin.keys.whiteTop);
    g.addColorStop(0.5, skin.keys.whiteMid);
    g.addColorStop(0.9, skin.keys.whiteTop);
    g.addColorStop(1, skin.keys.whiteBottom);
    roundedRect(c, 0.6, 0, w - 0.2, h, 2.4);
    c.fillStyle = g;
    c.fill();
    const shade = skin.keys.whiteShade;
    const topShade = c.createLinearGradient(0, 0, 0, h * 0.34);
    topShade.addColorStop(0, rgba(shade, 0.30));
    topShade.addColorStop(1, rgba(shade, 0));
    roundedRect(c, 0.6, 0, w - 0.2, h * 0.34, 2.4);
    c.fillStyle = topShade;
    c.fill();
    const left = c.createLinearGradient(0, 0, w * 0.3, 0);
    left.addColorStop(0, rgba(sideShade, 0.15));
    left.addColorStop(1, rgba(sideShade, 0));
    c.fillStyle = left;
    c.fillRect(0.6, 0, w * 0.3, h);
    const right = c.createLinearGradient(w, 0, w * 0.72, 0);
    right.addColorStop(0, rgba(sideShade, 0.13));
    right.addColorStop(1, rgba(sideShade, 0));
    c.fillStyle = right;
    c.fillRect(w * 0.7, 0, w * 0.3, h);
    const bottom = c.createLinearGradient(0, h - 6, 0, h);
    bottom.addColorStop(0, 'rgba(255,255,255,0)');
    bottom.addColorStop(0.6, 'rgba(255,255,255,0.26)');
    bottom.addColorStop(1, rgba(edge, 0.30));
    c.fillStyle = bottom;
    c.fillRect(0.8, h - 6, w - 1.6, 6);
  } else {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, skin.keys.blackTop);
    g.addColorStop(0.08, skin.keys.blackBody);
    g.addColorStop(0.78, skin.keys.blackBody);
    g.addColorStop(1, skin.keys.blackBottom);
    roundedRect(c, 0, 0, w, h, 2.2);
    c.fillStyle = g;
    c.fill();
    c.fillStyle = skin.keys.blackTip;
    c.fillRect(1.4, 1, w - 2.8, 1.1);
    const sheen = c.createLinearGradient(0, h * 0.5, 0, h * 0.88);
    sheen.addColorStop(0, 'rgba(255,230,200,0)');
    sheen.addColorStop(0.5, 'rgba(255,230,200,0.07)');
    sheen.addColorStop(1, 'rgba(255,230,200,0)');
    c.fillStyle = sheen;
    c.fillRect(1, h * 0.46, w - 2, h * 0.4);
    const left = c.createLinearGradient(0, 0, w * 0.34, 0);
    left.addColorStop(0, 'rgba(0,0,0,0.55)');
    left.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = left;
    c.fillRect(0, 0, w * 0.34, h);
    const right = c.createLinearGradient(w, 0, w * 0.66, 0);
    right.addColorStop(0, 'rgba(0,0,0,0.55)');
    right.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = right;
    c.fillRect(w * 0.62, 0, w * 0.38, h);
    const shadow = c.createLinearGradient(0, h + 0.5, 0, h + shadowPad);
    shadow.addColorStop(0, 'rgba(0,0,0,0.40)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = shadow;
    c.fillRect(1.5, h + 0.5, w - 3, shadowPad);
  }
  return canvas;
}

function woodTexture(w: number, h: number, s: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(Math.max(8, w) * s);
  canvas.height = Math.ceil(Math.max(8, h) * s);
  const c = canvas.getContext('2d');
  if (c === null) return canvas;
  c.scale(s, s);
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#332014');
  g.addColorStop(0.35, '#221409');
  g.addColorStop(0.7, '#2b1a0e');
  g.addColorStop(1, '#1c1008');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const R = mulberry32(88);
  for (let i = 0; i < 24; i += 1) {
    const y0 = R() * h;
    const warm = R() > 0.45;
    c.strokeStyle = warm ? `rgba(92,58,30,${0.08 + R() * 0.14})` : `rgba(14,8,4,${0.12 + R() * 0.2})`;
    c.lineWidth = 0.5 + R() * 1.1;
    c.beginPath();
    let y = y0;
    c.moveTo(0, y);
    for (let x = 0; x <= w; x += Math.max(1, w / 4)) {
      y = y0 + Math.sin(x * 0.35 + i) * 1.6 + (R() - 0.5) * 2;
      c.lineTo(x, y);
    }
    c.stroke();
  }
  const gloss = c.createLinearGradient(0, 0, w, 0);
  gloss.addColorStop(0, 'rgba(255,226,190,0.12)');
  gloss.addColorStop(0.4, 'rgba(255,226,190,0)');
  gloss.addColorStop(1, 'rgba(0,0,0,0.25)');
  c.fillStyle = gloss;
  c.fillRect(0, 0, w, h);
  return canvas;
}

function radialSprite(color: Rgb, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  if (c === null) return canvas;
  const g = c.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size / 2);
  g.addColorStop(0, rgba(color, 0.6));
  g.addColorStop(0.5, rgba(color, 0.2));
  g.addColorStop(1, rgba(color, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Falling-note comets, pre-rendered once per hue so the per-frame cost is a
 * single drawImage per note: no gradients, paths or shadows on the hot path.
 * The teardrop tapers to a bright head that lands exactly on its key column.
 */
function cometSprite(hue: Rgb, tip: Rgb): HTMLCanvasElement {
  const w = 36;
  const h = 180;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  if (c === null) return canvas;
  // Beam body: alpha ramps from invisible tail to bright head.
  const beam = c.createLinearGradient(0, 0, 0, h);
  beam.addColorStop(0, rgba(hue, 0));
  beam.addColorStop(0.45, rgba(hue, 0.30));
  beam.addColorStop(0.8, rgba(hue, 0.62));
  beam.addColorStop(1, rgba(tip, 0.95));
  c.fillStyle = beam;
  c.fillRect(w * 0.5 - w * 0.16, 2, w * 0.32, h - 6);
  // Soft horizontal falloff bakes the glow into the sprite.
  c.globalCompositeOperation = 'destination-in';
  const soft = c.createLinearGradient(0, 0, w, 0);
  soft.addColorStop(0, 'rgba(0,0,0,0)');
  soft.addColorStop(0.32, 'rgba(0,0,0,0.55)');
  soft.addColorStop(0.5, 'rgba(0,0,0,1)');
  soft.addColorStop(0.68, 'rgba(0,0,0,0.55)');
  soft.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = soft;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'source-over';
  // Bright rounded head at the bottom edge of the beam.
  const head = c.createRadialGradient(w / 2, h * 0.955, 0.5, w / 2, h * 0.955, w * 0.3);
  head.addColorStop(0, rgba(tip, 1));
  head.addColorStop(0.4, rgba(tip, 0.85));
  head.addColorStop(1, rgba(hue, 0));
  c.fillStyle = head;
  c.beginPath();
  c.arc(w / 2, h * 0.955, w * 0.3, 0, Math.PI * 2);
  c.fill();
  return canvas;
}

/** Pre-rendered luminous music glyphs (♪ ♫) for the seaside ambience. */function buildNoteSprites(skin: PianoSkin): HTMLCanvasElement[] {
  const glyphs = ['\u266A', '\u266B'];
  return glyphs.map((glyph) => {
    const size = 44;
    const pad = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size + pad * 2;
    canvas.height = size + pad * 2;
    const nc = canvas.getContext('2d');
    if (nc === null) return canvas;
    nc.font = `600 ${size}px "Segoe UI Symbol", Inter, system-ui, sans-serif`;
    nc.textAlign = 'center';
    nc.textBaseline = 'middle';
    nc.shadowColor = rgba(skin.notes.tip, 0.9);
    nc.shadowBlur = 10;
    nc.fillStyle = rgba(skin.notes.tip, 0.95);
    nc.fillText(glyph, canvas.width / 2, canvas.height / 2 + 2);
    return canvas;
  });
}

/** Create the piano scene renderer for a dedicated transparent canvas. */
export function createImmersivePianoScene(canvas: HTMLCanvasElement): PianoRenderer {
  try {
    return new ImmersivePianoScene(canvas);
  } catch {
    const noop: PianoRenderer = { backend: 'none', resize: () => {}, render: () => {}, dispose: () => {} };
    return noop;
  }
}
