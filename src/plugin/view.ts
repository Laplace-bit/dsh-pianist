import type { PerformanceEvent, Score } from '../core/types.js';
import { buildTimeline } from '../core/timeline.js';
import { MusicalClock } from '../audio/musical-clock.js';
import { PlaybackController, type PlaybackControllerState } from '../audio/playback-controller.js';
import {
  createPianoEngine,
  createMasterAnalyser,
  PianoAudioAnalyzer,
  samplePreloadRequests,
  type PianoSamplePack,
} from '../audio/index.js';
import type { PianoAudioAnalysis } from '../audio/audio-analyzer.js';
import type { PianistRenderMode } from './config.js';
import { computeVisualState } from '../visual/visual-state.js';
import type { PianoRenderer } from '../visual/piano-renderer.js';
import { createImmersivePianoScene } from '../visual/immersive-scene.js';
import { VisualTimeline } from '../visual/visual-timeline.js';
import { VisualEventCursor } from '../visual/event-cursor.js';
import { createParticleBurst, type PianoParticle } from '../visual/particles.js';
import {
  MAX_PIANO_MIDI,
  MIN_PIANO_MIDI,
  keyName,
  pianoKeyAtPoint,
  PIANO_IMMERSIVE_KEYBOARD_HEIGHT,
  PIANO_KEYBOARD_HEIGHT,
} from '../visual/keyboard.js';
import { sceneKeyAtPoint } from '../visual/key-geometry.js';
import { PianoKeyInputController } from '../visual/key-input.js';
import { PIANO_SKIN_IDS } from '../visual/skin.js';
import {
  DEFAULT_SYNC_DRIFT_THRESHOLD_MS,
  SyncDiagnostics,
  assessSyncRecovery,
  type PianistRuntimeLogEntry,
  type SyncDiagnosticSnapshot,
  type SyncRecovery,
} from '../sync/diagnostics.js';
import {
  DEFAULT_PIANIST_SETTINGS,
  normalizePianistSettings,
  type PianistSettings,
} from '../shared/pianist-settings.js';

// The package root doubles as the Cordis Host entry and is evaluated in Node.
// Resolve the DOM base lazily so importing the root does not require browser
// globals before the client bundle reaches a browser.
const HTMLElementBase: typeof HTMLElement = typeof HTMLElement === 'undefined'
  ? class {} as unknown as typeof HTMLElement
  : HTMLElement;

// This wakes the lookahead scheduler; it is never used to derive musical time.
const SCHEDULER_WAKEUP_MILLISECONDS = 25;

/** Effective audio source after resolving browser-only runtime capabilities. */
export interface PianistAudioSourceStatus {
  requested: 'sample-pack';
  effective: 'generated' | 'sample-pack';
  fallbackReason?: 'sample-pack-unavailable' | 'sample-pack-load-failed';
}

export type PianistAudioRuntimeErrorCode =
  | 'audio-context-unavailable'
  | 'audio-initialization-failed'
  | 'audio-resume-failed'
  | 'audio-playback-failed';

/** An audio failure that the embedding UI can localize and present to the user. */
export interface PianistAudioRuntimeErrorDetail {
  code: PianistAudioRuntimeErrorCode;
}

/** Why the view entered or left the immersive presentation. */
export type PianistRenderModeReason = 'user' | 'setting' | 'ended';

/** Emitted whenever the immersive presentation opens or closes. */
export interface PianistRenderModeDetail {
  mode: PianistRenderMode;
  immersive: boolean;
  reason: PianistRenderModeReason;
}

/** A playback transport command from the immersive bottom bar. */
export type PianistImmersiveCommand =
  | 'close'
  | 'togglePlay'
  | 'stop'
  | 'seek';

export class PianistAudioRuntimeError extends Error {
  constructor(
    readonly code: PianistAudioRuntimeErrorCode,
    cause?: unknown,
  ) {
    super(`dsh-pianist audio runtime error: ${code}`, { cause });
    this.name = 'PianistAudioRuntimeError';
  }
}

/** Outcome of applying durable profile settings to one browser view. */
export interface PianistViewSettingsResult {
  audioSource: PianistAudioSourceStatus;
}

/** An enabled score event delivered from the component's deterministic timeline. */
export interface PianistPerformanceEventDetail {
  event: PerformanceEvent;
}

/** Deterministic particles derived from an enabled note-on event. */
export interface PianistParticleEventDetail {
  event: PerformanceEvent;
  particles: readonly PianoParticle[];
}

/** A manual UI-key transition, exposed for embedding diagnostics. */
export interface PianistKeyAuditionEventDetail {
  midi: number;
  state: 'pressed' | 'released';
  source: 'pointer' | 'keyboard';
}

interface ActiveAudition {
  midi: number;
  voiceId: string;
  source: PianistKeyAuditionEventDetail['source'];
  started: boolean;
}

const AUDITION_VELOCITY = 0.78;
const MIN_AUDITION_TAP_SECONDS = 0.08;

export class DshPianoView extends HTMLElementBase {
  private shadow: ShadowRoot;
  private canvas: HTMLCanvasElement;
  private renderer: PianoRenderer | null = null;
  private score: Score | null = null;
  private timeline = buildTimeline(emptyScore());
  private visualTimeline = new VisualTimeline(this.timeline);
  private eventCursor = new VisualEventCursor(this.timeline.events);
  private previousEventTime = -Number.EPSILON;
  private clock: MusicalClock | null = null;
  private audioContext: AudioContext | null = null;
  private engine: ReturnType<typeof createPianoEngine> | null = null;
  private playback: PlaybackController | null = null;
  private audioInitialization: Promise<void> | null = null;
  private engineRecreation: Promise<void> | null = null;
  private sampleAuxiliaryWarmupTimer: number | undefined;
  private scoreUpdateGeneration = 0;
  private animationFrame = 0;
  private lastVisualFrameSeconds = Number.NEGATIVE_INFINITY;
  private visualFrameCostMs = 0;
  private disposed = false;
  private samplePack: PianoSamplePack | null = null;
  private runtimeVolume = 1;
  private muted = false;
  private visualStateReset = true;
  private audioRuntimeError: PianistAudioRuntimeError | undefined;
  private readonly activeAuditions = new Map<string, ActiveAudition>();
  private readonly pendingTapAuditions = new Set<ActiveAudition>();
  private auditionSequence = 0;
  private selectedAuditionMidi = 60;
  private resizeObserver: ResizeObserver | undefined;
  private readonly onWindowResize = (): void => { this.resizeCanvas(); };
  private rendererRecoveryAttempted = false;
  private readonly onWindowBlur = (): void => { this.releaseAllAuditions(); };
  private readonly keyInputs: PianoKeyInputController[] = [];
  private skinOverride: string | undefined;
  private motionQuery: MediaQueryList | undefined;
  private motionReduced = false;
  private readonly onMotionChange = (event: MediaQueryListEvent): void => { this.motionReduced = event.matches; };
  private readonly diagnostics = new SyncDiagnostics();
  private readonly diagnosticsOverlay: HTMLElement;
  private diagnosticsOverlayEnabled = false;
  private lastExpectedEventId: string | undefined;
  private lastActualEventId: string | undefined;
  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.releaseAllAuditions();
      this.playback?.setSchedulingMode('background');
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.playback?.setSchedulingMode('foreground');
      this.render(this.visualStateAt(this.clock?.currentTime ?? 0));
    }
  };
  private pianistSettings: PianistSettings = structuredClone(DEFAULT_PIANIST_SETTINGS);
  private audioSourceStatus: PianistAudioSourceStatus = {
    requested: 'sample-pack',
    effective: 'generated',
    fallbackReason: 'sample-pack-unavailable',
  };
  private _renderMode: PianistRenderMode = 'embedded';
  private immersive = false;
  private returnToEmbeddedOnEnd = true;
  private immersiveUi!: HTMLElement;
  private immersiveTitle!: HTMLElement;
  private immersiveProgress!: HTMLElement;
  private immersivePlay!: HTMLButtonElement;
  private immersiveCanvas!: HTMLCanvasElement;
  private immersiveRenderer: PianoRenderer | null = null;
  private immersiveTopLayer = false;
  private analyserNode: AnalyserNode | undefined;
  private audioAnalyzer: PianoAudioAnalyzer | null = null;
  private readonly analysisFrame: PianoAudioAnalysis = {
    loudness: 0, low: 0, mid: 0, high: 0, energy: 0, noteActivity: 0, usingAnalyser: false,
  };
  private nowSeconds = 0;
  private seenEnded = false;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.immersive) return;
    event.stopPropagation();
    this.requestExitImmersive('user');
  };

  private readonly onFullscreenChange = (): void => {
    // Fullscreen can be exited by Escape or the browser chrome. Keep the
    // immersive render mode in sync with that external transition.
    if (typeof document === 'undefined' || document.fullscreenElement !== null) return;
    if (this.immersive && this.renderMode === 'immersive') {
      this.requestExitImmersive('user');
    }
  };

  private readonly onPopoverToggle = (event: Event): void => {
    const toggle = event as ToggleEvent;
    if (toggle.newState === 'closed' && this.immersive && this.immersiveTopLayer) {
      this.immersiveTopLayer = false;
      this.requestExitImmersive('user');
    }
  };

  private readonly onPianoAudition = (event: Event): void => {
    const detail = (event as CustomEvent<PianistKeyAuditionEventDetail>).detail;
    if (detail?.state !== 'pressed') return;
    this.immersiveRenderer?.audition?.(detail.midi, AUDITION_VELOCITY, this.nowSeconds);
    this.renderer?.audition?.(detail.midi, AUDITION_VELOCITY, this.nowSeconds);
    this.lastVisualFrameSeconds = Number.NEGATIVE_INFINITY;
  };

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-roledescription', 'piano keyboard');
    this.diagnosticsOverlay = document.createElement('output');
    this.diagnosticsOverlay.dataset.pianistDebugOverlay = 'true';
    this.diagnosticsOverlay.hidden = true;
    this.diagnosticsOverlay.setAttribute('aria-live', 'off');
    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        position: relative;
        overflow: hidden;
        border-radius: 14px;
        /* A whisper of tint only. The embedding card owns the liquid-glass
           blur layer; nesting backdrop-filters would double the sampling
           cost, so this surface stays cheap and lets the glass show. */
        background: linear-gradient(165deg, rgba(40,46,68,0.22) 0%, rgba(20,23,36,0.26) 55%, rgba(32,37,58,0.20) 100%);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
      }
      canvas {
        display: block;
        cursor: pointer;
        touch-action: none;
        user-select: none;
        background: transparent;
      }
      @media (prefers-reduced-motion: reduce) { canvas { transition: none; } }
      canvas:focus-visible {
        outline: 2px solid var(--dsw-alias-border-focus, #68a8ff);
        outline-offset: -2px;
      }
      [data-pianist-immersive-canvas] {
        background: transparent !important;
        cursor: pointer;
        pointer-events: auto;
      }
      [data-pianist-debug-overlay] {
        position: absolute;
        top: 8px;
        right: 8px;
        margin: 0;
        padding: 6px 8px;
        border: 1px solid rgba(224, 235, 229, 0.45);
        background: rgba(11, 17, 14, 0.82);
        color: #eef5f0;
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre;
        pointer-events: none;
      }
      :host([data-pianist-immersive]),
      :host(:popover-open) {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        width: 100% !important;
        height: 100% !important;
        max-width: none;
        max-height: none;
        margin: 0;
        box-sizing: border-box;
        border: none;
        border-radius: 0;
        background: transparent;
        transition: opacity 420ms ease;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      }
      [data-pianist-immersive-ui] {
        position: fixed;
        inset: 0;
        pointer-events: none;
        transition: opacity 420ms ease, transform 420ms ease;
      }
      [data-pianist-immersive-veil] {
        position: absolute;
        inset: 0;
        background: radial-gradient(ellipse at 50% 40%, rgba(38, 44, 66, 0.14), rgba(10, 11, 22, 0.62) 74%);
      }
      [data-pianist-immersive-close],
      [data-pianist-immersive-play],
      [data-pianist-immersive-stop] {
        pointer-events: auto;
        min-width: 44px;
        min-height: 44px;
        border: 1px solid rgba(222, 216, 244, 0.24);
        border-radius: 12px;
        background: rgba(16, 18, 30, 0.62);
        color: #ece9f6;
        backdrop-filter: blur(10px);
        cursor: pointer;
        font: 500 14px/1 system-ui, sans-serif;
        transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
      }
      [data-pianist-immersive-close]:hover,
      [data-pianist-immersive-play]:hover,
      [data-pianist-immersive-stop]:hover {
        background: rgba(44, 48, 72, 0.74);
        border-color: rgba(238, 232, 255, 0.46);
      }
      [data-pianist-immersive-close]:active,
      [data-pianist-immersive-play]:active,
      [data-pianist-immersive-stop]:active {
        transform: translateY(1px);
      }
      [data-pianist-immersive-close]:focus-visible,
      [data-pianist-immersive-play]:focus-visible,
      [data-pianist-immersive-stop]:focus-visible {
        outline: 2px solid var(--dsw-alias-border-focus, #68a8ff);
        outline-offset: 2px;
      }
      [data-pianist-immersive-close] {
        position: absolute;
        top: calc(env(safe-area-inset-top) + 12px);
        right: calc(env(safe-area-inset-right) + 12px);
        width: 46px;
        font-size: 24px;
        line-height: 40px;
        color: rgba(236, 242, 246, 0.92);
      }
      [data-pianist-immersive-bar] {
        position: absolute;
        left: 50%;
        bottom: calc(env(safe-area-inset-bottom) + 20px);
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: min(92vw, 720px);
        min-width: 300px;
        padding: 8px 12px;
        border: 1px solid rgba(210, 206, 240, 0.20);
        border-radius: 16px;
        background: rgba(13, 15, 25, 0.64);
        backdrop-filter: blur(14px);
        color: #e6e4f2;
        font: 12px/1.4 system-ui, sans-serif;
      }
      [data-pianist-immersive-title] {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }
      [data-pianist-immersive-progress] {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      [data-pianist-immersive-ui][data-pianist-animating] {
        opacity: 0;
        transform: scale(0.985);
      }
      @media (prefers-reduced-motion: reduce) {
        :host([data-pianist-immersive]),
        :host(:popover-open),
        [data-pianist-immersive-ui] {
          transition: opacity 120ms ease;
        }
        [data-pianist-immersive-ui][data-pianist-animating] {
          transform: none;
        }
      }
    `;
    this.shadow.append(style, this.canvas, this.diagnosticsOverlay);
    this.buildImmersiveUi();
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.motionReduced = this.motionQuery.matches;
      try { this.motionQuery.addEventListener('change', this.onMotionChange); } catch { /* older engines */ }
    }
    this.bindCanvasListeners(this.canvas);
    if (this.immersiveCanvas !== undefined) this.bindCanvasListeners(this.immersiveCanvas);
    this.updateKeyboardAccessibility();
    // The luxury Canvas2D scene is the primary renderer for both the embedded
    // card and the immersive overlay; it degrades to a no-op renderer when a
    // 2d context cannot be created.
    this.renderer = createImmersivePianoScene(this.canvas);
    this.applySkinToRenderers();
    const clockSource = this.createClockSource();
    this.clock = new MusicalClock(clockSource);
  }

  private buildImmersiveUi(): void {
    const ui = document.createElement('div');
    ui.dataset.pianistImmersiveUi = 'true';
    ui.hidden = true;

    const scene = document.createElement('canvas');
    scene.dataset.pianistImmersiveCanvas = 'true';
    scene.style.position = 'absolute';
    scene.style.inset = '0';
    scene.style.width = '100%';
    scene.style.height = '100%';
    this.immersiveCanvas = scene;
    this.immersiveRenderer = createImmersivePianoScene(scene);
    this.applySkinToRenderers();

    const veil = document.createElement('div');
    veil.dataset.pianistImmersiveVeil = 'true';

    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.pianistImmersiveClose = 'true';
    close.setAttribute('aria-label', 'Close immersive piano');
    close.textContent = '×';

    const bar = document.createElement('div');
    bar.dataset.pianistImmersiveBar = 'true';

    const title = document.createElement('span');
    title.dataset.pianistImmersiveTitle = 'true';

    const progress = document.createElement('span');
    progress.dataset.pianistImmersiveProgress = 'true';

    const playPause = document.createElement('button');
    playPause.type = 'button';
    playPause.dataset.pianistImmersivePlay = 'true';
    this.immersivePlay = playPause;

    const stop = document.createElement('button');
    stop.type = 'button';
    stop.dataset.pianistImmersiveStop = 'true';
    stop.textContent = 'Stop';

    close.addEventListener('click', () => this.requestExitImmersive('user'));
    playPause.addEventListener('click', () => this.handleImmersiveCommand('togglePlay'));
    stop.addEventListener('click', () => this.handleImmersiveCommand('stop'));

    bar.append(title, progress, playPause, stop);
    // The veil dims the page behind; the transparent scene canvas paints above
    // it so the piano and glass stay crisp.
    ui.append(veil, scene, close, bar);
    this.immersiveUi = ui;
    this.immersiveTitle = title;
    this.immersiveProgress = progress;
    this.shadow.append(ui);
  }

  private handleImmersiveCommand(command: PianistImmersiveCommand): void {
    if (command === 'close') {
      this.requestExitImmersive('user');
    } else if (command === 'togglePlay') {
      if (this.playback?.state === 'playing') this.pause();
      else void this.play();
    } else if (command === 'stop') {
      this.stop();
    }
  }

  get currentTime(): number {
    return this.clock?.currentTime ?? 0;
  }

  get duration(): number {
    return this.playback?.duration ?? this.timeline.durationSeconds;
  }

  /** Current controller state for embedding playback controls. */
  get playbackState(): PlaybackControllerState {
    if (this.playback !== null) return this.playback.state;
    if (this.score === null) return 'idle';
    if (this.audioInitialization !== null) return 'loading';
    return 'ready';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Current sustain-pedal position reconstructed from the shared timeline. */
  get pedal(): number {
    return this.visualStateAt(this.clock?.currentTime ?? 0).pedal;
  }

  get audioErrorCode(): PianistAudioRuntimeErrorCode | undefined {
    return this.audioRuntimeError?.code;
  }

  /** Currently presented render mode (embedded inline vs immersive overlay). */
  get renderMode(): PianistRenderMode {
    return this._renderMode;
  }

  /** Whether the full-viewport immersive presentation is active. */
  get isImmersive(): boolean {
    return this.immersive;
  }

  /** The committed profile preference, before any user-driven toggle. */
  get preferredRenderMode(): PianistRenderMode {
    return this.pianistSettings.renderMode;
  }

  /** Lowest-latency snapshot of the last analyser frame (mutable copy). */
  get audioAnalysis(): Readonly<PianoAudioAnalysis> {
    const active = this.playback?.state === 'playing' || this.activeAuditions.size > 0;
    return { ...(active ? this.audioAnalyzer?.read() ?? this.analysisFrame : this.analysisFrame) };
  }

  /** Latest bounded development-time measurement from the shared clock. */
  get syncDiagnosticSnapshot(): SyncDiagnosticSnapshot {
    return this.diagnostics.snapshot;
  }

  /** Recent important runtime transitions, bounded by SyncDiagnostics. */
  get syncRuntimeLog(): readonly PianistRuntimeLogEntry[] {
    return this.diagnostics.logs;
  }

  connectedCallback(): void {
    this.disposed = false;
    this.rendererRecoveryAttempted = false;
    if (this.renderer === null) {
      this.renderer = createImmersivePianoScene(this.canvas);
      this.applySkinToRenderers();
    }
    if (this.immersiveRenderer === null && this.immersiveCanvas !== undefined) {
      this.immersiveRenderer = createImmersivePianoScene(this.immersiveCanvas);
      this.applySkinToRenderers();
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onWindowResize);
      this.resizeObserver.observe(this);
    } else {
      window.addEventListener('resize', this.onWindowResize);
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.addEventListener('pianist-key-audition', this.onPianoAudition);
    this.addEventListener('toggle', this.onPopoverToggle);
    this.resizeCanvas();
    if (this.immersive) this.promoteImmersiveToTopLayer();
    if (this.animationFrame === 0) this.tick();
  }

  disconnectedCallback(): void {
    if (this.disposed) {
      return;
    }
    this.withdrawImmersiveFromTopLayer();
    this.disposed = true;
    this.scoreUpdateGeneration += 1;
    if (this.sampleAuxiliaryWarmupTimer !== undefined) {
      window.clearTimeout(this.sampleAuxiliaryWarmupTimer);
      this.sampleAuxiliaryWarmupTimer = undefined;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    for (const controller of this.keyInputs) controller.detach();
    this.keyInputs.length = 0;
    try { this.motionQuery?.removeEventListener('change', this.onMotionChange); } catch { /* older engines */ }
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.removeEventListener('pianist-key-audition', this.onPianoAudition);
    this.removeEventListener('toggle', this.onPopoverToggle);
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.renderer?.dispose();
    this.renderer = null;
    this.immersiveRenderer?.dispose();
    this.immersiveRenderer = null;
    this.visualStateReset = true;
    this.releaseAllAuditions(false);
    this.resetAudioRuntime();
  }

  setScore(score: Score): void {
    this.scoreUpdateGeneration += 1;
    if (this.sampleAuxiliaryWarmupTimer !== undefined) {
      window.clearTimeout(this.sampleAuxiliaryWarmupTimer);
      this.sampleAuxiliaryWarmupTimer = undefined;
    }
    this.releaseAllAuditions();
    this.score = score;
    this.timeline = buildTimeline(score);
    this.visualTimeline = new VisualTimeline(this.timeline);
    this.eventCursor = new VisualEventCursor(this.timeline.events);
    this.previousEventTime = -Number.EPSILON;
    this.visualStateReset = true;
    this.playback?.load(this.timeline);
    this.clock?.seek(0);
    this.resizeCanvas();
    if (this.audioContext !== null) {
      this.queueEngineRecreation();
    }
  }

  /** Append a validated streaming score prefix without restarting playback. */
  async updateScore(score: Score): Promise<void> {
    const generation = ++this.scoreUpdateGeneration;
    const timeline = buildTimeline(score);
    const context = this.audioContext;
    if (context !== null
      && this.audioSourceStatus.effective === 'sample-pack'
      && this.samplePack !== null) {
      await this.samplePack.preloadAttacks(
        context,
        samplePreloadRequests(timeline),
      );
    }
    if (generation !== this.scoreUpdateGeneration || this.disposed) return;
    const resumeAfterExtension = this.playback?.state === 'ended';
    this.score = score;
    this.timeline = timeline;
    this.visualTimeline = new VisualTimeline(timeline);
    this.eventCursor = new VisualEventCursor(timeline.events);
    const musicalTime = this.clock?.currentTime ?? 0;
    this.previousEventTime = musicalTime;
    this.visualStateReset = false;
    this.playback?.updateTimeline(timeline);
    if (resumeAfterExtension) this.playback?.play();
    this.synchronizeEventCursor(musicalTime);
    this.resizeCanvas();
    this.queueSampleAuxiliaryWarmup(timeline, generation);
  }

  private queueSampleAuxiliaryWarmup(timeline: ReturnType<typeof buildTimeline>, generation: number): void {
    if (this.sampleAuxiliaryWarmupTimer !== undefined) {
      window.clearTimeout(this.sampleAuxiliaryWarmupTimer);
    }
    this.sampleAuxiliaryWarmupTimer = window.setTimeout(() => {
      this.sampleAuxiliaryWarmupTimer = undefined;
      if (generation !== this.scoreUpdateGeneration || this.disposed) return;
      const context = this.audioContext;
      const samplePack = this.samplePack;
      if (context === null || samplePack === null || this.audioSourceStatus.effective !== 'sample-pack') return;
      void samplePack.preloadAuxiliary(
        context,
        samplePreloadRequests(timeline),
        timeline.events.some(event => event.type === 'pedalDown' || event.type === 'pedalUp'),
      ).catch(() => undefined);
    }, 750);
  }

  /**
   * Apply the settings committed by the profile-backed Host RPC. This element
   * intentionally does not persist or fetch them itself.
   */
  setPianistSettings(settings: PianistSettings): PianistViewSettingsResult {
    const previousEnabled = this.pianistSettings.enabled;
    this.pianistSettings = normalizePianistSettings(settings);
    // The profile owns one shared skin. Keep the public setSkin() override
    // intact, but ensure normal settings updates apply immediately to both
    // canvases without coupling the renderer to profile state.
    this.applySkinToRenderers();
    this.audioSourceStatus = this.resolveAudioSourceStatus();
    this.applyAudioSourceDataset();
    this.returnToEmbeddedOnEnd = this.pianistSettings.returnToEmbeddedOnEnd;

    this.canvas.style.visibility = this.pianistSettings.enabled ? '' : 'hidden';
    if (previousEnabled && !this.pianistSettings.enabled) {
      this.releaseAllAuditions();
    }
    if (previousEnabled && !this.pianistSettings.enabled) {
      this.pause();
    }
    this.updateKeyboardAccessibility();
    this.engine?.setGain?.(this.effectiveGain());
    this.resizeCanvas();
    this.render(this.visualStateAt(this.clock?.currentTime ?? 0));

    this.dispatchAudioSourceStatus();
    return { audioSource: { ...this.audioSourceStatus } };
  }

  /** Register a decoded/manifest-backed pack owned by the embedding browser code. */
  setSamplePack(samplePack: PianoSamplePack | null): PianistViewSettingsResult {
    const changed = this.samplePack !== samplePack;
    this.samplePack = samplePack;
    this.audioSourceStatus = this.resolveAudioSourceStatus();
    this.applyAudioSourceDataset();
    this.dispatchAudioSourceStatus();
    if (changed && this.audioContext !== null) {
      this.queueEngineRecreation();
    }
    return { audioSource: { ...this.audioSourceStatus } };
  }

  /**
   * Switch the registered skin used by every presentation. Unknown ids are
   * ignored so embedders can pass user data straight through. Renderers that
   * do not model skins (the no-op fallback) simply skip the advisory call.
   */
  setSkin(id: string): void {
    if (!PIANO_SKIN_IDS.includes(id as never)) return;
    this.skinOverride = id;
    this.dataset.pianistSkin = id;
    this.applySkinToRenderers();
    this.resizeCanvas();
    this.render(this.visualStateAt(this.clock?.currentTime ?? 0));
  }

  /** The active registered skin id shared by every presentation. */
  get skin(): string | undefined {
    return this.skinOverride ?? this.pianistSettings.skin;
  }

  private applySkinToRenderers(): void {
    const skin = this.skinOverride ?? this.pianistSettings.skin;
    this.renderer?.setSkin?.(skin);
    this.immersiveRenderer?.setSkin?.(skin);
    // Custom-element constructors cannot mutate attributes in jsdom (and the
    // platform enforces the same invariant during upgrade). Publish datasets
    // once the element is connected; renderer state itself is safe to update
    // before connection.
    if (this.isConnected) {
      // Both presentations share one skin; the two legacy datasets stay in
      // sync for any CSS/DOM observer that keyed on them.
      this.dataset.pianistEmbeddedSkin = skin;
      this.dataset.pianistImmersiveSkin = skin;
      this.dataset.pianistSkin = skin;
    }
  }

  /** Show or hide the non-interactive development timing overlay. */
  setDebugOverlay(enabled: boolean): void {
    this.diagnosticsOverlayEnabled = Boolean(enabled);
    this.diagnosticsOverlay.hidden = !this.diagnosticsOverlayEnabled;
    this.recordDiagnostics(this.visualStateAt(this.clock?.currentTime ?? 0));
  }

  /**
   * Compare an observed visual timestamp with the musical clock. A breach is
   * recovered by reconstructing visual state directly from the immutable
   * timeline, never by gradually nudging a secondary visual clock.
   */
  checkSync(
    observedVisualTime = this.currentTime,
    thresholdMs = DEFAULT_SYNC_DRIFT_THRESHOLD_MS,
  ): SyncRecovery {
    const musicalTime = this.clock?.currentTime ?? 0;
    const recovery = assessSyncRecovery(musicalTime, observedVisualTime, thresholdMs);
    // stop() and a newly loaded score intentionally display an empty reset
    // state, including for timeline events exactly at zero. Recovery only
    // applies after visual playback/seek state has been established.
    if (!recovery.required || this.visualStateReset) {
      return recovery;
    }

    this.diagnostics.log({
      type: 'SYNC_WARNING',
      musicalTime,
      message: `visual drift ${recovery.driftMs.toFixed(2)}ms`,
    });
    this.visualStateReset = false;
    this.synchronizeEventCursor(musicalTime);
    const state = this.visualStateAt(musicalTime);
    this.render(state);
    this.recordDiagnostics(state);
    this.diagnostics.log({ type: 'SYNC_RECOVERY', musicalTime });
    return recovery;
  }

  async play(): Promise<void> {
    if (!this.pianistSettings.enabled || this.clock === null || this.score === null) {
      return;
    }
    this.seenEnded = false;
    try {
      await this.ensureRunningAudio();
      if (this.audioContext === null || this.playback === null) {
        throw new PianistAudioRuntimeError('audio-initialization-failed');
      }
      this.playback.play();
      this.visualStateReset = false;
      this.lastVisualFrameSeconds = Number.NEGATIVE_INFINITY;
      this.clearAudioRuntimeError();
      this.diagnostics.log({ type: 'PLAY', musicalTime: this.clock.currentTime });
    } catch (error) {
      const runtimeError = error instanceof PianistAudioRuntimeError
        ? error
        : new PianistAudioRuntimeError('audio-playback-failed', error);
      this.reportAudioRuntimeError(runtimeError);
      this.resetAudioRuntime();
      throw runtimeError;
    }
  }

  pause(): void {
    if (this.playback !== null) {
      this.playback.pause();
    } else {
      this.clock?.pause();
    }
    this.audioAnalyzer?.reset();
    Object.assign(this.analysisFrame, PianoAudioAnalyzer.emptyFrame);
    this.renderer?.resetVisualState?.();
    this.immersiveRenderer?.resetVisualState?.();
    // A pause stops the normal active-frame cadence. Paint once immediately so
    // the immersive canvas settles on a complete frame instead of retaining a
    // partially composited animation pass.
    this.lastVisualFrameSeconds = Number.NEGATIVE_INFINITY;
    this.render(this.visualStateAt(this.clock?.currentTime ?? 0));
    this.diagnostics.log({ type: 'PAUSE', musicalTime: this.clock?.currentTime ?? 0 });
  }

  seek(seconds: number): void {
    const target = Number.isNaN(seconds)
      ? 0
      : Math.min(Math.max(seconds, 0), this.duration);
    if (this.playback !== null) {
      this.playback.seek(target);
    } else {
      this.clock?.seek(target);
    }
    const musicalTime = this.clock?.currentTime ?? 0;
    this.visualStateReset = false;
    this.synchronizeEventCursor(musicalTime);
    this.render(this.visualStateAt(musicalTime));
    this.diagnostics.log({ type: 'SEEK', musicalTime });
  }

  setRate(rate: number): void {
    if (this.playback !== null) {
      this.playback.setPlaybackRate(rate);
    } else {
      this.clock?.setRate(rate);
    }
  }

  stop(): void {
    this.releaseAllAuditions();
    if (this.playback !== null) this.playback.stop();
    else this.clock?.reset();
    this.audioAnalyzer?.reset();
    Object.assign(this.analysisFrame, PianoAudioAnalyzer.emptyFrame);
    this.renderer?.resetVisualState?.();
    this.immersiveRenderer?.resetVisualState?.();
    this.visualStateReset = true;
    this.synchronizeEventCursor(0);
    this.lastVisualFrameSeconds = Number.NEGATIVE_INFINITY;
    this.render(this.visualStateAt(0));
    this.diagnostics.log({ type: 'STOP', musicalTime: 0 });
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new RangeError('volume must be a finite number in [0, 1]');
    }
    this.runtimeVolume = volume;
    this.engine?.setGain?.(this.effectiveGain());
  }

  setMuted(muted: boolean): void {
    this.muted = Boolean(muted);
    this.engine?.setGain?.(this.effectiveGain());
  }

  /** Enter or leave the full-viewport immersive presentation. */
  setRenderMode(mode: PianistRenderMode, reason: PianistRenderModeReason = 'user'): void {
    if (mode !== 'immersive' && mode !== 'embedded') {
      throw new RangeError(`invalid render mode ${String(mode)}`);
    }
    if (mode === this._renderMode) return;
    this._renderMode = mode;
    this.applyImmersivePresentation(reason);
  }

  /** Present the poetic full-screen piano. Never implies playback. */
  requestImmersive(): void {
    this.setRenderMode('immersive', 'user');
  }

  /** Smoothly withdraw the immersive layer. Does not restart music. */
  requestExitImmersive(reason: PianistRenderModeReason = 'user'): void {
    if (!this.immersive) return;
    this.setRenderMode('embedded', reason);
    if (typeof document !== 'undefined' && document.fullscreenElement !== null) {
      void document.exitFullscreen?.();
    }
  }

  private applyImmersivePresentation(reason: PianistRenderModeReason): void {
    const immersive = this.renderMode === 'immersive';
    this.immersive = immersive;
    this.applySkinToRenderers();
    this.lastVisualFrameSeconds = Number.NEGATIVE_INFINITY;
    this.immersiveRenderer?.setActive?.(immersive);
    const settle = this.reducedMotion() ? 120 : 420;
    if (immersive) {
      this.setAttribute('data-pianist-immersive', '');
      this.promoteImmersiveToTopLayer();
      this.canvas.style.visibility = 'hidden';
      this.immersiveUi.hidden = false;
      this.immersiveUi.setAttribute('data-pianist-animating', '');
      this.immersiveRenderer?.resize(innerWidth, innerHeight, this.renderPixelRatio());
      this.schedule(() => { if (this.immersive) this.immersiveUi.removeAttribute('data-pianist-animating'); });
    } else {
      this.withdrawImmersiveFromTopLayer();
      this.removeAttribute('data-pianist-immersive');
      this.canvas.style.visibility = '';
      this.immersiveUi.setAttribute('data-pianist-animating', '');
      this.schedule(() => { if (!this.immersive) this.immersiveUi.hidden = true; }, settle);
    }
    this.updateImmersiveUi();
    this.resizeCanvas();
    this.emitRenderMode(reason);
  }

  /**
   * A fixed descendant can still be clipped by a chat host's transform or
   * containment. The popover API moves this element into the browser top
   * layer while preserving the custom element and its audio state.
   */
  private promoteImmersiveToTopLayer(): void {
    if (this.immersiveTopLayer || typeof this.showPopover !== 'function') return;
    this.setAttribute('popover', 'manual');
    try {
      this.showPopover();
      this.immersiveTopLayer = true;
    } catch {
      // Older engines may expose no working popover implementation. The
      // fixed host presentation remains the compatibility fallback.
      this.removeAttribute('popover');
    }
  }

  private withdrawImmersiveFromTopLayer(): void {
    if (!this.immersiveTopLayer) return;
    try {
      this.hidePopover();
    } catch {
      // The element may already have been dismissed by the user agent.
    }
    this.immersiveTopLayer = false;
    this.removeAttribute('popover');
  }

  private emitRenderMode(reason: PianistRenderModeReason): void {
    if (typeof CustomEvent === 'undefined') return;
    this.dataset.pianistRenderMode = this.renderMode;
    this.dispatchEvent(new CustomEvent<PianistRenderModeDetail>('pianist-render-mode', {
      detail: { mode: this.renderMode, immersive: this.immersive, reason },
    }));
  }

  private updateImmersiveUi(): void {
    if (this.immersiveUi.hidden) return;
    const title = this.score?.title ?? '';
    if (this.immersiveTitle.textContent !== title) this.immersiveTitle.textContent = title;
    const current = this.currentTime;
    const duration = this.duration;
    const progress = `${formatImmersionTime(current)} / ${formatImmersionTime(duration)}`;
    if (this.immersiveProgress.textContent !== progress) this.immersiveProgress.textContent = progress;
    const playLabel = this.playback?.state === 'playing' ? 'Pause' : 'Play';
    if (this.immersivePlay.textContent !== playLabel) this.immersivePlay.textContent = playLabel;
  }

  private reducedMotion(): boolean {
    return this.motionReduced;
  }

  private activeKeyboardHeight(): number {
    return this.immersive ? PIANO_IMMERSIVE_KEYBOARD_HEIGHT : PIANO_KEYBOARD_HEIGHT;
  }

  private schedule(callback: () => void, delay = 0): void {
    requestAnimationFrame(() => { window.setTimeout(callback, delay); });
  }

  async toggleFullscreen(): Promise<void> {
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement !== null) {
      await document.exitFullscreen?.();
      return;
    }
    this.requestImmersive();
    try {
      if (typeof this.requestFullscreen === 'function') {
        await this.requestFullscreen();
      } else if (typeof document.documentElement.requestFullscreen === 'function') {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Immersive mode remains useful when the browser denies native fullscreen.
    }
  }

  private async initAudio(): Promise<void> {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) {
      throw new PianistAudioRuntimeError('audio-context-unavailable');
    }
    try {
      let audioContext: AudioContext;
      try {
        audioContext = new Ctor({ latencyHint: 'interactive' });
      } catch {
        // Older WebKit builds expose the constructor but reject options.
        audioContext = new Ctor();
      }
      const previousTime = this.clock?.currentTime ?? 0;
      const previousRate = this.clock?.rate ?? 1;
      this.audioContext = audioContext;
      this.analyserNode = createMasterAnalyser(audioContext);
      this.audioAnalyzer = new PianoAudioAnalyzer(this.analyserNode, audioContext);
      this.clock = new MusicalClock(audioContext);
      this.clock.seek(previousTime);
      this.clock.setRate(previousRate);
      const playback = await this.createEngine(audioContext);
      if (playback === null) {
        throw new PianistAudioRuntimeError('audio-initialization-failed');
      }
      if (previousTime > 0) {
        playback.seek(previousTime);
      }
    } catch (error) {
      if (error instanceof PianistAudioRuntimeError) {
        throw error;
      }
      throw new PianistAudioRuntimeError('audio-initialization-failed', error);
    }
  }

  /**
   * AudioContext creation and sample preload are asynchronous. Coalesce
   * adjacent play requests so one caller cannot tear down another caller's
   * partially initialized graph.
   */
  private async ensureAudioInitialized(): Promise<void> {
    if (this.audioInitialization !== null) {
      await this.audioInitialization;
    }
    if (this.engineRecreation !== null) await this.waitForEngineRecreation();
    if (this.audioContext !== null && this.playback !== null) return;

    const initialization = this.initAudio();
    this.audioInitialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.audioInitialization === initialization) {
        this.audioInitialization = null;
      }
    }
    if (this.engineRecreation !== null) await this.waitForEngineRecreation();
  }

  /** Resume immediately while a pointer/key gesture is still on the stack. */
  private async ensureRunningAudio(): Promise<void> {
    const initialization = this.ensureAudioInitialized();
    const eagerContext = this.audioContext;
    if (eagerContext !== null && eagerContext.state !== 'running') {
      try {
        await eagerContext.resume();
      } catch (error) {
        await initialization.catch(() => undefined);
        throw new PianistAudioRuntimeError('audio-resume-failed', error);
      }
    }
    await initialization;
    const context = this.audioContext;
    if (context === null) throw new PianistAudioRuntimeError('audio-initialization-failed');
    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch (error) {
        throw new PianistAudioRuntimeError('audio-resume-failed', error);
      }
      if ((context.state as AudioContextState) !== 'running') {
        throw new PianistAudioRuntimeError('audio-resume-failed');
      }
    }
  }

  /** Serialize score/source rebuilds and let an immediate play() await them. */
  private queueEngineRecreation(): void {
    const previous = this.engineRecreation;
    const operation = (async () => {
      if (previous !== null) await previous;
      const initialization = this.audioInitialization;
      if (initialization !== null) {
        try {
          await initialization;
        } catch {
          return;
        }
      }
      await this.recreateEngine();
    })();
    this.engineRecreation = operation;
    void operation.then(() => {
      if (this.engineRecreation === operation) this.engineRecreation = null;
    }, () => {
      if (this.engineRecreation === operation) this.engineRecreation = null;
    });
  }

  private async waitForEngineRecreation(): Promise<void> {
    while (this.engineRecreation !== null) {
      await this.engineRecreation;
    }
  }

  private createClockSource(): { readonly currentTime: number } {
    // Do not create AudioContext in the constructor. The performance clock is a
    // visual-only placeholder; play() swaps in the AudioContext master clock.
    return { get currentTime() { return performance.now() / 1000; } };
  }

  private tick = (): void => {
    if (this.disposed) {
      return;
    }
    this.nowSeconds = typeof performance === 'undefined' ? Date.now() / 1000 : performance.now() / 1000;
    if (this.clock) {
      const wasPlaying = this.clock.state === 'playing';
      const musicalTime = this.clock.currentTime;
      if (this.pianistSettings.enabled && (wasPlaying || this.clock.state === 'playing')) {
        this.emitTimelineEvents(musicalTime);
      }
      this.updateAnalysis();
      if (this.shouldPaintFrame()) {
        const state = this.visualStateAt(musicalTime);
        const renderStartedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
        this.render(state);
        const renderFinishedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
        const frameCost = renderFinishedAt - renderStartedAt;
        if (Number.isFinite(frameCost) && frameCost > 0) {
          this.visualFrameCostMs = this.visualFrameCostMs === 0
            ? frameCost
            : this.visualFrameCostMs * 0.85 + frameCost * 0.15;
        }
        this.recordDiagnostics(state);
      }
      this.detectEndOfPlayback();
      this.updateImmersiveUi();
    }
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private shouldPaintFrame(): boolean {
    const active = this.playback?.state === 'playing'
      || this.activeAuditions.size > 0
      || this.analysisFrame.energy > 0.025;
    const activeFps = this.pianistSettings.visualQuality === 'high'
      ? 60
      : this.pianistSettings.visualQuality === 'medium' ? 45 : 30;
    // Keep headroom for input, layout and audio callbacks when Canvas2D gets
    // expensive on a high-DPR or integrated-GPU display. The animation itself
    // uses wall-clock deltas, so adaptive frame pacing never changes its speed.
    const sustainableFps = this.visualFrameCostMs > 0
      ? Math.max(20, Math.floor(1000 / (this.visualFrameCostMs * 1.35)))
      : activeFps;
    const targetFps = active
      ? Math.min(activeFps, sustainableFps)
      : Math.min(this.immersive ? 30 : 20, sustainableFps);
    const elapsed = this.nowSeconds - this.lastVisualFrameSeconds;
    if (elapsed >= 0 && elapsed < 1 / targetFps) return false;
    this.lastVisualFrameSeconds = this.nowSeconds;
    return true;
  }

  private updateAnalysis(): void {
    // Paused/stopped views stay visually silent even while the audio graph is
    // releasing its final sample tails into the analyser.
    if (this.playback?.state !== 'playing' && this.activeAuditions.size === 0) {
      Object.assign(this.analysisFrame, PianoAudioAnalyzer.emptyFrame);
      return;
    }
    const analysis = this.audioAnalyzer?.read();
    if (analysis === undefined) {
      Object.assign(this.analysisFrame, PianoAudioAnalyzer.emptyFrame);
      return;
    }
    Object.assign(this.analysisFrame, analysis);
    // Muted output, keep responding to events but soften the whole frame.
    if (this.muted) {
      this.analysisFrame.loudness *= 0.3;
      this.analysisFrame.energy *= 0.45;
      this.analysisFrame.high *= 0.4;
    }
  }

  private detectEndOfPlayback(): void {
    if (this.seenEnded || this.playback?.state !== 'ended') return;
    this.seenEnded = true;
    if (this.immersive
      && this.returnToEmbeddedOnEnd
      && this.pianistSettings.enabled
      && this.renderMode === 'immersive') {
      this.requestExitImmersive('ended');
    }
  }

  private resizeCanvas(): void {
    const rect = this.getBoundingClientRect();
    const dpr = this.renderPixelRatio();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.canvas.width = Math.max(1, Math.floor(width * dpr));
    this.canvas.height = Math.max(1, Math.floor(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.renderer?.resize(width, height, dpr);
    if (this.immersiveRenderer !== null && this.immersive) {
      const viewWidth = typeof innerWidth === 'number' ? innerWidth : width;
      const viewHeight = typeof innerHeight === 'number' ? innerHeight : height;
      this.immersiveRenderer.resize(viewWidth, viewHeight, this.renderPixelRatio());
    }
  }

  private render(state: ReturnType<typeof computeVisualState>): void {
    // Auditions overlay on top of the timeline's own pressed state; skip the
    // copy entirely on the common frame where none are held.
    let pressedMidi = state.pressedMidi;
    if (this.activeAuditions.size > 0) {
      const merged = new Set(state.pressedMidi);
      for (const audition of this.activeAuditions.values()) merged.add(audition.midi);
      pressedMidi = merged;
    }
    const reducedMotion = this.motionReduced;
    const options: import('../visual/piano-renderer.js').PianoRenderOptions = {
      musicalTime: state.musicalTime,
      state: pressedMidi === state.pressedMidi ? state : { ...state, pressedMidi },
      timeline: this.visualTimeline,
      showWaterfall: this.pianistSettings.enabled && this.pianistSettings.showWaterfall,
      showKeyboard: this.pianistSettings.enabled,
      particles: this.pianistSettings.enabled && this.pianistSettings.events.particles && !reducedMotion,
      quality: this.pianistSettings.visualQuality,
      immersive: this.immersive,
      atmosphere: this.analysisFrame,
      transientEffects: this.playback?.state === 'playing' || this.activeAuditions.size > 0,
      nowSeconds: this.nowSeconds,
      reducedMotion,
      keyboardHeight: this.activeKeyboardHeight(),
    };
    try {
      if (this.immersive) {
        this.immersiveRenderer?.render(options);
        return;
      }
      this.renderer?.render(options);
    } catch (error) {
      // A lost WebGL context must never stop the shared clock or audio. Replace
      // the canvas and use the Canvas2D path on the next frame.
      this.diagnostics.log({ type: 'SYNC_WARNING', musicalTime: state.musicalTime, message: 'visual renderer recovered' });
      if (!this.immersive) this.recoverRenderer(error);
    }
  }

  /**
   * One reusable input controller per surface. Pointer capture, multi-touch,
   * arrow-key selection and Space/Enter auditioning all live in
   * PianoKeyInputController so any renderer backend (2D today, 3D tomorrow)
   * shares the same input path.
   */
  private bindCanvasListeners(canvas: HTMLCanvasElement): void {
    const controller = new PianoKeyInputController(
      { element: canvas, fallbackBounds: () => this.getBoundingClientRect() },
      {
        canInput: () => this.canAudition(),
        keyAtPoint: (x, y) => this.keyMidiAtSurfacePoint(x, y),
        selection: {
          get: () => this.selectedAuditionMidi,
          set: (midi) => {
            const next = Math.min(MAX_PIANO_MIDI, Math.max(MIN_PIANO_MIDI, midi));
            if (next === this.selectedAuditionMidi) return;
            this.selectedAuditionMidi = next;
            this.updateKeyboardAccessibility();
          },
          min: MIN_PIANO_MIDI,
          max: MAX_PIANO_MIDI,
        },
        press: (inputId, midi, source, velocity) => { void this.beginAudition(inputId, midi, source, velocity); },
        release: (inputId) => { this.endAudition(inputId); },
        releaseAll: () => { this.releaseAllAuditions(); },
      },
    );
    controller.attach();
    this.keyInputs.push(controller);
  }

  private recoverRenderer(_error: unknown): void {
    if (this.rendererRecoveryAttempted || this.disposed) return;
    this.rendererRecoveryAttempted = true;
    try { this.renderer?.dispose(); } catch { /* context may already be lost */ }
    const previous = this.canvas;
    const replacement = document.createElement('canvas');
    replacement.tabIndex = previous.tabIndex;
    replacement.style.cssText = previous.style.cssText;
    for (const attribute of ['role', 'aria-roledescription', 'aria-label', 'aria-disabled']) {
      const value = previous.getAttribute(attribute);
      if (value !== null) replacement.setAttribute(attribute, value);
    }
    this.shadow.replaceChild(replacement, previous);
    this.canvas = replacement;
    this.bindCanvasListeners(replacement);
    this.renderer = createImmersivePianoScene(replacement);
    this.applySkinToRenderers();
    this.resizeCanvas();
  }

  private recordDiagnostics(state: ReturnType<typeof computeVisualState>): void {
    const timestamp = typeof performance === 'undefined' ? Date.now() : performance.now();
    const musicalTime = this.clock?.currentTime ?? state.musicalTime;
    const snapshot = this.diagnostics.recordFrame({
      frameTimestampMs: timestamp,
      audioTime: this.audioContext?.currentTime ?? musicalTime,
      musicalTime,
      visualTime: state.musicalTime,
      scheduledEvents: this.playback?.scheduledEvents ?? 0,
      activeNotes: state.activeNotes.length,
      expectedEventId: this.lastExpectedEventId,
      actualEventId: this.lastActualEventId,
    });
    if (this.diagnosticsOverlayEnabled) {
      this.diagnosticsOverlay.textContent = this.formatDiagnosticOverlay(snapshot);
    }
  }

  private formatDiagnosticOverlay(snapshot: SyncDiagnosticSnapshot): string {
    const signedOffset = `${snapshot.avOffsetMs >= 0 ? '+' : ''}${snapshot.avOffsetMs.toFixed(1)}ms`;
    return [
      `Audio Time: ${snapshot.audioTime.toFixed(3)}`,
      `Musical Time: ${snapshot.musicalTime.toFixed(3)}`,
      `Visual Time: ${snapshot.visualTime.toFixed(3)}`,
      `FPS: ${snapshot.fps.toFixed(0)}`,
      `Frame: ${snapshot.frameTimeMs.toFixed(1)}ms`,
      `Scheduled: ${snapshot.scheduledEvents}`,
      `Active Notes: ${snapshot.activeNotes}`,
      `A/V Drift: ${signedOffset}`,
    ].join('\n');
  }

  /** Reset state is an explicit playback state, not another musical clock. */
  private visualStateAt(musicalTime: number): ReturnType<typeof computeVisualState> {
    if (!this.visualStateReset) {
      return computeVisualState(this.timeline, musicalTime);
    }
    return {
      musicalTime,
      activeNotes: [],
      pressedMidi: new Set<number>(),
      pedal: 0,
    };
  }

  private effectiveGain(): number {
    return this.pianistSettings.enabled && !this.muted
      ? this.pianistSettings.volume * this.runtimeVolume
      : 0;
  }

  private renderPixelRatio(): number {
    const devicePixelRatio = window.devicePixelRatio || 1;
    const maximum = this.pianistSettings.visualQuality === 'low'
      ? 1
      : this.pianistSettings.visualQuality === 'medium' ? 1.5 : 2;
    return Math.min(devicePixelRatio, maximum);
  }

  private resolveAudioSourceStatus(): PianistAudioSourceStatus {
    if (this.samplePack !== null) {
      return { requested: 'sample-pack', effective: 'sample-pack' };
    }
    return {
      requested: 'sample-pack',
      effective: 'generated',
      fallbackReason: 'sample-pack-unavailable',
    };
  }

  private async recreateEngine(): Promise<void> {
    const audioContext = this.audioContext;
    if (audioContext === null || audioContext.state === 'closed') return;
    try {
      const wasPlaying = this.playback?.state === 'playing';
      const musicalTime = this.clock?.currentTime ?? 0;
      const rate = this.clock?.rate ?? 1;
      this.playback?.pause();
      this.engine?.dispose();
      this.engine = null;
      this.playback = null;
      this.clock = new MusicalClock(audioContext);
      this.clock.seek(musicalTime);
      this.clock.setRate(rate);
      const playback = await this.createEngine(audioContext);
      if (playback === null) {
        throw new PianistAudioRuntimeError('audio-initialization-failed');
      }
      playback.seek(musicalTime);
      if (wasPlaying) playback.play();
      this.clearAudioRuntimeError();
    } catch (error) {
      const runtimeError = error instanceof PianistAudioRuntimeError
        ? error
        : new PianistAudioRuntimeError('audio-initialization-failed', error);
      this.reportAudioRuntimeError(runtimeError);
      this.resetAudioRuntime();
    }
  }

  private async createEngine(audioContext: AudioContext): Promise<PlaybackController | null> {
    const requestedSamplePack = this.samplePack;
    const createFallback = async (reason?: PianistAudioSourceStatus['fallbackReason']): Promise<void> => {
      this.engine = createPianoEngine({
        source: 'generated',
        analyser: this.analyserNode,
        gain: this.effectiveGain(),
      });
      await this.engine.init(audioContext);
      if (reason !== undefined) {
        this.audioSourceStatus = { requested: 'sample-pack', effective: 'generated', fallbackReason: reason };
        this.applyAudioSourceDataset();
        this.dispatchAudioSourceStatus();
      }
    };

    if (requestedSamplePack === null) {
      await createFallback('sample-pack-unavailable');
    } else {
      try {
        this.engine = createPianoEngine({
          source: 'sample-pack',
          samplePack: requestedSamplePack,
          analyser: this.analyserNode,
          preload: samplePreloadRequests(this.timeline),
          preloadPedalActions: this.timeline.events.some(event => event.type === 'pedalDown' || event.type === 'pedalUp'),
          gain: this.effectiveGain(),
        });
        await this.engine.init(audioContext);
        this.audioSourceStatus = { requested: 'sample-pack', effective: 'sample-pack' };
        this.applyAudioSourceDataset();
        this.dispatchAudioSourceStatus();
      } catch {
        this.engine?.dispose();
        this.engine = null;
        await createFallback('sample-pack-load-failed');
      }
    }

    if (this.engine === null || this.clock === null) return null;
    const playback = new PlaybackController({
      clock: this.clock,
      engine: this.engine,
      timeline: this.timeline,
      schedulerWakeupMilliseconds: SCHEDULER_WAKEUP_MILLISECONDS,
    });
    this.playback = playback;
    return playback;
  }

  private applyAudioSourceDataset(): void {
    this.dataset.pianistAudioSource = this.audioSourceStatus.effective;
    if (this.audioSourceStatus.fallbackReason === undefined) {
      delete this.dataset.pianistAudioSourceFallback;
    } else {
      this.dataset.pianistAudioSourceFallback = this.audioSourceStatus.fallbackReason;
    }
  }

  private dispatchAudioSourceStatus(): void {
    if (typeof CustomEvent === 'undefined') return;
    this.dispatchEvent(new CustomEvent<PianistAudioSourceStatus>('pianist-audio-source-status', {
      detail: { ...this.audioSourceStatus },
    }));
  }

  private reportAudioRuntimeError(error: PianistAudioRuntimeError): void {
    this.audioRuntimeError = error;
    this.dataset.pianistAudioError = error.code;
    this.diagnostics.log({ type: 'AUDIO_ERROR', musicalTime: this.clock?.currentTime ?? 0, message: error.code });
    if (typeof CustomEvent === 'undefined') return;
    this.dispatchEvent(new CustomEvent<PianistAudioRuntimeErrorDetail>('pianist-audio-error', {
      detail: { code: error.code },
    }));
  }

  private clearAudioRuntimeError(): void {
    this.audioRuntimeError = undefined;
    delete this.dataset.pianistAudioError;
  }

  /** Tear down a failed/unmounted audio graph while preserving musical position. */
  private resetAudioRuntime(): void {
    this.releaseAllAuditions(false);
    const musicalTime = this.clock?.currentTime ?? 0;
    const rate = this.clock?.rate ?? 1;
    try {
      this.playback?.pause();
    } catch {
      // A failed graph may reject its final scheduler cleanup.
    }
    try {
      this.engine?.dispose();
    } catch {
      // Browser context shutdown can release nodes before component cleanup.
    }
    this.engine = null;
    this.playback = null;
    this.analyserNode = undefined;
    this.audioAnalyzer = null;
    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext !== null && audioContext.state !== 'closed') {
      void audioContext.close();
    }
    this.clock = new MusicalClock(this.createClockSource());
    this.clock.seek(musicalTime);
    this.clock.setRate(rate);
    this.synchronizeEventCursor(musicalTime);
  }

  private synchronizeEventCursor(musicalTime: number): void {
    this.eventCursor.seek(musicalTime);
    this.previousEventTime = musicalTime;
  }

  private emitTimelineEvents(musicalTime: number): void {
    if (musicalTime < this.previousEventTime) {
      this.synchronizeEventCursor(musicalTime);
      return;
    }
    for (const event of this.eventCursor.advance(this.previousEventTime, musicalTime)) {
      this.lastExpectedEventId = event.id;
      this.lastActualEventId = event.id;
      if (event.type === 'noteOn') {
        this.audioAnalyzer?.pushNote(event.velocity ?? 0);
        this.diagnostics.log({ type: 'NOTE_ON', musicalTime: event.time, eventId: event.id });
      } else if (event.type === 'noteOff') {
        this.diagnostics.log({ type: 'NOTE_OFF', musicalTime: event.time, eventId: event.id });
      } else if (event.type === 'pedalDown' || event.type === 'pedalUp') {
        this.diagnostics.log({ type: 'PEDAL', musicalTime: event.time, eventId: event.id });
      }
      if (this.isEnabledPerformanceEvent(event) && typeof CustomEvent !== 'undefined') {
        this.dispatchEvent(new CustomEvent<PianistPerformanceEventDetail>('pianist-performance-event', {
          detail: { event: structuredClone(event) },
        }));
      }
      if (event.type === 'noteOn' && this.pianistSettings.events.particles && typeof CustomEvent !== 'undefined') {
        const particles = createParticleBurst(event);
        this.dispatchEvent(new CustomEvent<PianistParticleEventDetail>('pianist-particle', {
          detail: { event: structuredClone(event), particles },
        }));
      }
    }
    this.previousEventTime = musicalTime;
  }

  private isEnabledPerformanceEvent(event: PerformanceEvent): boolean {
    if (event.type === 'noteOn' || event.type === 'noteOff') return this.pianistSettings.events.notes;
    if (event.type === 'pedalDown' || event.type === 'pedalUp') return this.pianistSettings.events.pedal;
    return this.pianistSettings.events.tempo;
  }

  private canAudition(): boolean {
    return this.pianistSettings.enabled && !this.disposed;
  }

  /**
   * Resolve a canvas point to a playable midi number. Scene renderers expose
   * their own geometry so clicks land on the keys the user actually sees; the
   * legacy bottom-strip heuristic remains as the fallback for no-op renderers.
   */
  private keyMidiAtSurfacePoint(x: number, y: number): number | undefined {
    const geometry = this.immersive
      ? this.immersiveRenderer?.keyGeometry?.()
      : this.renderer?.keyGeometry?.();
    if (geometry !== undefined) {
      return sceneKeyAtPoint(x, y, geometry)?.midi;
    }
    const rect = this.getBoundingClientRect();
    return pianoKeyAtPoint(x, y, Math.max(1, rect.width), Math.max(1, rect.height), this.activeKeyboardHeight())?.midi;
  }

  private async beginAudition(
    inputId: string,
    midi: number,
    source: PianistKeyAuditionEventDetail['source'],
    velocity?: number,
  ): Promise<void> {
    if (!this.canAudition() || this.activeAuditions.has(inputId)) return;
    const velocityClamped = Math.min(1, Math.max(0, velocity ?? AUDITION_VELOCITY));
    const audition: ActiveAudition = {
      midi,
      voiceId: `dsh-pianist-audition-${String(++this.auditionSequence)}`,
      source,
      started: false,
    };
    this.activeAuditions.set(inputId, audition);
    this.updateAuditionState();
    try {
      await this.ensureRunningAudio();
      if (!this.isTrackedAudition(inputId, audition)) return;
      const context = this.audioContext;
      const engine = this.engine;
      if (context === null || engine === null) {
        throw new PianistAudioRuntimeError('audio-initialization-failed');
      }
      if (this.audioSourceStatus.effective === 'sample-pack' && this.samplePack !== null) {
        await this.samplePack.preloadAttacks(context, [{ midi, velocity: velocityClamped }]);
        if (!this.isTrackedAudition(inputId, audition)) return;
      }
      const pendingTap = this.pendingTapAuditions.has(audition);
      engine.noteOn(
        audition.voiceId,
        midi,
        velocityClamped,
        context.currentTime,
        pendingTap ? MIN_AUDITION_TAP_SECONDS : undefined,
      );
      audition.started = true;
      this.clearAudioRuntimeError();
      this.dispatchAuditionEvent(audition, 'pressed');
      if (pendingTap) {
        this.pendingTapAuditions.delete(audition);
        this.dispatchAuditionEvent(audition, 'released');
      }
    } catch (error) {
      const wasActive = this.activeAuditions.get(inputId) === audition;
      const wasPending = this.pendingTapAuditions.delete(audition);
      if (!wasActive && !wasPending) return;
      if (wasActive) this.activeAuditions.delete(inputId);
      this.updateAuditionState();
      const runtimeError = error instanceof PianistAudioRuntimeError
        ? error
        : new PianistAudioRuntimeError('audio-playback-failed', error);
      this.reportAudioRuntimeError(runtimeError);
    }
  }

  private isTrackedAudition(inputId: string, audition: ActiveAudition): boolean {
    return this.activeAuditions.get(inputId) === audition || this.pendingTapAuditions.has(audition);
  }

  private endAudition(
    inputId: string,
    releaseVoice = true,
    preservePendingTap = releaseVoice,
  ): void {
    const audition = this.activeAuditions.get(inputId);
    if (audition === undefined) return;
    this.activeAuditions.delete(inputId);
    if (!audition.started && preservePendingTap) {
      this.pendingTapAuditions.add(audition);
    } else if (releaseVoice && audition.started && this.engine !== null && this.audioContext !== null) {
      this.engine.noteOff(audition.voiceId, this.audioContext.currentTime);
      this.dispatchAuditionEvent(audition, 'released');
    }
    this.updateAuditionState();
  }

  private releaseAllAuditions(releaseVoices = true): void {
    for (const inputId of [...this.activeAuditions.keys()]) {
      this.endAudition(inputId, releaseVoices, false);
    }
    this.pendingTapAuditions.clear();
  }

  private updateAuditionState(): void {
    this.dataset.pianistActiveAuditions = String(this.activeAuditions.size);
    this.render(this.visualStateAt(this.clock?.currentTime ?? 0));
  }

  private updateKeyboardAccessibility(): void {
    const interactive = this.pianistSettings.enabled;
    const label = `Interactive 88-key piano keyboard, selected ${keyName(this.selectedAuditionMidi)}. Use Left and Right Arrow to select a key, then hold Space or Enter to play it.`;
    for (const canvas of [this.canvas, this.immersiveCanvas]) {
      if (canvas === undefined) continue;
      canvas.tabIndex = interactive ? 0 : -1;
      canvas.setAttribute('aria-disabled', String(!interactive));
      canvas.setAttribute('aria-label', label);
    }
  }

  private dispatchAuditionEvent(
    audition: ActiveAudition,
    state: PianistKeyAuditionEventDetail['state'],
  ): void {
    this.dataset.pianistLastAudition = `${state}:${String(audition.midi)}`;
    if (typeof CustomEvent === 'undefined') return;
    this.dispatchEvent(new CustomEvent<PianistKeyAuditionEventDetail>('pianist-key-audition', {
      detail: { midi: audition.midi, state, source: audition.source },
    }));
  }

}

function emptyScore(): Score {
  return {
    id: 'empty',
    title: 'Empty',
    ppq: 960,
    tracks: [],
    tempoMap: [{ tick: 0n, bpm: 120 }],
    timeSignatureMap: [{ tick: 0n, numerator: 4, denominator: 4 }],
  };
}

function formatImmersionTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function registerDshPianoView(): void {
  if (typeof customElements === 'undefined') {
    return;
  }
  if (customElements.get('dsh-piano-view') === undefined) {
    customElements.define('dsh-piano-view', DshPianoView);
  }
}
