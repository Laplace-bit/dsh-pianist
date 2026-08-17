import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import {
  IconFullscreenOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { normalizeScore } from '../core/normalizer.js';
import type { Score } from '../core/types.js';
import { validateScore } from '../core/validator.js';
import type {
  PianoPerformanceWirePayload,
  PianoToolResult,
} from '../shared/piano-tool.js';
import { compilePianoPerformance, parsePianoToolResult } from '../shared/piano-tool.js';
import { parsePianoToolStream, type PianoToolStreamPreview } from './piano-tool-stream.js';

type PianoPlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'seeking' | 'ended' | 'error';

interface PianoViewElement extends HTMLElement {
  readonly currentTime: number;
  readonly duration: number;
  readonly playbackState?: PianoPlaybackState;
  readonly isImmersive: boolean;
  readonly preferredRenderMode?: 'immersive' | 'embedded';
  setScore(score: Score): void;
  updateScore(score: Score): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  stop(): void;
  requestImmersive(): void;
  requestExitImmersive(reason?: 'user' | 'setting' | 'ended'): void;
}

const MAX_AUTOPLAY_HISTORY = 256;
const livePianoCalls = new Set<string>();
const autoplayedCalls = new Set<string>();

function rememberBounded(set: Set<string>, value: string): void {
  set.delete(value);
  set.add(value);
  while (set.size > MAX_AUTOPLAY_HISTORY) {
    const oldest = set.values().next().value as string | undefined;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function observeLiveCall(callId: string): void {
  rememberBounded(livePianoCalls, callId);
}

function claimAutoplay(callId: string, requested: boolean): boolean {
  if (!requested || !livePianoCalls.has(callId) || autoplayedCalls.has(callId)) return false;
  rememberBounded(autoplayedCalls, callId);
  return true;
}

interface PreparedPerformance {
  result: PianoToolResult;
  score: Score;
  revision: string;
  streaming: boolean;
}

interface StreamPrefixCache {
  callId: string;
  prepared?: PreparedPerformance;
  compiledAtMs: number;
  noteGroupCount: number;
  readyToPlay: boolean;
}

export interface PianoToolViewInjected {
  /** Read the bounded live copy published for Code Mode subcalls. */
  readPerformance: (performanceId: string) => Promise<PianoToolResult | undefined>;
}

export type PianoToolViewProps = ToolCallViewProps
  & PropsLocale<'settings.pianist'>
  & InjectFace<PianoToolViewInjected>;

/**
 * Liquid-glass card chrome. The wrapper owns the ONLY backdrop-filter on the
 * card: one GPU-composited sampling layer, never animated, while the canvas
 * above paints translucent washes so the blurred chat shows through.
 */
const shellStyle: CSSProperties = {
  position: 'relative',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  borderRadius: 16,
  background: [
    'radial-gradient(130% 70% at 50% -12%, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0) 58%)',
    'linear-gradient(165deg, rgba(40, 46, 68, 0.42) 0%, rgba(24, 27, 42, 0.46) 52%, rgba(32, 37, 58, 0.40) 100%)',
  ].join(', '),
  backdropFilter: 'blur(22px) saturate(155%)',
  WebkitBackdropFilter: 'blur(22px) saturate(155%)',
  color: 'var(--dsw-alias-fg-base)',
  overflow: 'hidden',
  minWidth: 0,
  boxShadow: [
    'inset 0 1px 0 rgba(255, 255, 255, 0.22)',
    'inset 0 -1px 0 rgba(255, 255, 255, 0.05)',
    '0 18px 44px rgba(6, 8, 18, 0.42)',
  ].join(', '),
};

const toolbarStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  minHeight: 42,
  padding: '7px 10px',
  borderTop: '1px solid rgba(255, 255, 255, 0.10)',
  background: 'rgba(14, 16, 26, 0.30)',
};

const iconButtonStyle: CSSProperties = {
  alignItems: 'center',
  background: 'transparent',
  border: '1px solid rgba(255, 255, 255, 0.20)',
  borderRadius: 8,
  color: 'inherit',
  cursor: 'pointer',
  display: 'inline-flex',
  flex: '0 0 30px',
  height: 30,
  justifyContent: 'center',
  padding: 0,
  width: 30,
  transition: 'background 160ms ease, border-color 160ms ease, transform 160ms ease',
};

const immersiveShellStyle: CSSProperties = {
  ...shellStyle,
  border: '0',
  borderRadius: 0,
  background: 'transparent',
  // Fullscreen stages their own atmosphere; blurring the entire page behind
  // every frame would be a needless always-on GPU cost.
  backdropFilter: 'none',
  WebkitBackdropFilter: 'none',
  boxShadow: 'none',
  overflow: 'visible',
  minWidth: 0,
};

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resultFromMeta(meta: unknown): PianoToolResult | undefined {
  const record = object(meta);
  if (record?.kind !== 'dsh-pianist-performance') {
    return undefined;
  }
  return parsePianoToolResult(record);
}

function prepareResult(
  result: PianoToolResult | undefined,
  revision?: string,
  streaming = false,
): PreparedPerformance | undefined {
  if (result === undefined) return undefined;
  try {
    const score = normalizeScore((result.payload as PianoPerformanceWirePayload).score);
    validateScore(score);
    return { result, score, revision: revision ?? result.performanceId, streaming };
  } catch {
    return undefined;
  }
}

const STREAM_COMPILE_BATCH_SIZE = 16;
const STREAM_COMPILE_BATCH_THRESHOLD = 32;
const STREAM_COMPILE_INTERVAL_MS = 500;

function prepareStreamResult(
  callId: string,
  preview: PianoToolStreamPreview,
  cache: StreamPrefixCache,
): PreparedPerformance | undefined {
  if (preview.input === undefined) return undefined;
  const now = Date.now();
  const noteDelta = preview.noteGroupCount - cache.noteGroupCount;
  const shouldCompile = cache.prepared === undefined
    || preview.complete
    || preview.noteGroupCount <= STREAM_COMPILE_BATCH_THRESHOLD
    || noteDelta >= STREAM_COMPILE_BATCH_SIZE
    || preview.readyToPlay !== cache.readyToPlay
    || now - cache.compiledAtMs >= STREAM_COMPILE_INTERVAL_MS;
  if (!shouldCompile) return cache.prepared;
  try {
    const result = compilePianoPerformance(preview.input, `piano-stream-${callId}`);
    const prepared = prepareResult(
      result,
      `${String(preview.noteGroupCount)}:${String(preview.soundedNoteCount)}:${String(preview.bufferedUntilBeat)}`,
      true,
    );
    if (prepared !== undefined) {
      cache.prepared = prepared;
      cache.compiledAtMs = now;
      cache.noteGroupCount = preview.noteGroupCount;
      cache.readyToPlay = preview.readyToPlay;
    }
    return prepared;
  } catch {
    return undefined;
  }
}

/** Recover one playable score from durable DSH tool-result metadata. */
export function preparePianoToolResult(block: PianoToolViewProps['block']): PreparedPerformance | undefined {
  if (!('kind' in block) || block.isError) return undefined;
  return prepareResult(resultFromMeta(block.meta));
}

/**
 * Code Mode persists the rendered text but intentionally drops presentation
 * metadata. The tool's fixed output format gives the browser one opaque,
 * bounded lookup key without exposing arbitrary RPC arguments.
 */
export function performanceIdFromToolBlock(block: PianoToolViewProps['block']): string | undefined {
  if (!('kind' in block) || block.isError) return undefined;
  for (const item of block.content) {
    const candidate = item as unknown as { type?: unknown; text?: unknown };
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue;
    const match = /\bPerformance ID:\s*(piano-[A-Za-z0-9._:-]+)\b/.exec(candidate.text);
    if (match !== null) return match[1];
  }
  return undefined;
}

function formatSeconds(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function iconButton(
  label: string,
  icon: ReturnType<typeof createElement>,
  onClick: () => void,
  disabled = false,
) {
  return (
    <button
      type="button"
      className="dsh-piano-tool-btn"
      style={iconButtonStyle}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function PianoToolView({ block, t, readPerformance }: PianoToolViewProps) {
  const streaming = !('kind' in block);
  const streamPreview = useMemo(() => streaming
    ? parsePianoToolStream(block.argsRaw, { elapsedMs: Math.max(0, Date.now() - block.time) })
    : undefined, [block, streaming]);
  const streamCompileCache = useRef<StreamPrefixCache>();
  if (streamCompileCache.current?.callId !== block.callId) {
    streamCompileCache.current = {
      callId: block.callId,
      compiledAtMs: 0,
      noteGroupCount: 0,
      readyToPlay: false,
    };
  }
  const preparedFromStream = useMemo(() => streamPreview === undefined
    ? undefined
    : prepareStreamResult(block.callId, streamPreview, streamCompileCache.current!), [block.callId, streamPreview]);
  // DSH may publish an argument delta while a JSON string/object is still
  // open. Keep the last validated prefix mounted through that short gap so a
  // transient parser miss cannot unmount the audio element and tear down its
  // AudioContext. A new call starts with a fresh cache.
  const streamedPrefixCache = useRef<{ callId: string; prepared?: PreparedPerformance }>();
  if (streamedPrefixCache.current?.callId !== block.callId) {
    streamedPrefixCache.current = { callId: block.callId };
  }
  if (preparedFromStream !== undefined) {
    streamedPrefixCache.current.prepared = preparedFromStream;
  }
  const stablePreparedFromStream = preparedFromStream ?? streamedPrefixCache.current.prepared;
  const preparedFromMeta = useMemo(() => preparePianoToolResult(block), [block]);
  const fallbackId = useMemo(() => performanceIdFromToolBlock(block), [block]);
  const [fallbackResult, setFallbackResult] = useState<PianoToolResult | undefined>();
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const preparedFromFallback = useMemo(() => prepareResult(fallbackResult), [fallbackResult]);
  const prepared = preparedFromMeta ?? preparedFromFallback ?? stablePreparedFromStream;
  const viewRef = useRef<PianoViewElement | null>(null);
  const loadedPerformance = useRef<{ performanceId: string; revision: string; streaming: boolean }>();
  const [state, setState] = useState<PianoPlaybackState>('ready');
  const [currentTime, setCurrentTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [audioError, setAudioError] = useState(false);
  const [immersive, setImmersive] = useState(false);

  useEffect(() => {
    if (streaming) observeLiveCall(block.callId);
  }, [block.callId, streaming]);

  useEffect(() => {
    if (preparedFromMeta !== undefined || fallbackId === undefined) {
      setFallbackResult(undefined);
      setFallbackLoading(false);
      return;
    }
    let active = true;
    setFallbackLoading(true);
    void readPerformance(fallbackId).then(result => {
      if (!active) return;
      setFallbackResult(result?.performanceId === fallbackId ? result : undefined);
      setFallbackLoading(false);
    }, () => {
      if (!active) return;
      setFallbackResult(undefined);
      setFallbackLoading(false);
    });
    return () => { active = false; };
  }, [fallbackId, preparedFromMeta, readPerformance]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || prepared === undefined) return;
    const loaded = loadedPerformance.current;
    if (loaded?.performanceId === prepared.result.performanceId && loaded.revision === prepared.revision) return;
    const extendsStreamingSession = loaded?.streaming === true;
    loadedPerformance.current = {
      performanceId: prepared.result.performanceId,
      revision: prepared.revision,
      streaming: prepared.streaming,
    };
    if (extendsStreamingSession) {
      void view.updateScore(prepared.score).catch(() => {
        setAudioError(true);
        setState('paused');
      });
    } else {
      view.setScore(prepared.score);
      setCurrentTime(0);
      setState('ready');
    }
    setAudioError(false);
    const streamReady = !prepared.streaming || streamPreview?.readyToPlay === true;
    if (!claimAutoplay(block.callId, prepared.result.autoplay && streamReady)) return;
    void view.play().then(() => {
      setState(view.playbackState ?? 'playing');
      if (view.preferredRenderMode === 'immersive') view.requestImmersive();
    }, () => {
      setAudioError(true);
      setState('paused');
    });
  }, [block.callId, prepared, streamPreview?.readyToPlay]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const onRenderMode = (): void => setImmersive(view.isImmersive ?? false);
    view.addEventListener('pianist-render-mode', onRenderMode);
    setImmersive(view.isImmersive ?? false);
    const interval = window.setInterval(() => {
      const currentView = viewRef.current;
      if (currentView === null) return;
      setCurrentTime(currentView.currentTime);
      if (currentView.playbackState !== undefined) setState(currentView.playbackState);
      setImmersive(currentView.isImmersive ?? false);
    }, 100);
    return () => {
      view.removeEventListener('pianist-render-mode', onRenderMode);
      window.clearInterval(interval);
    };
  }, [prepared?.result.performanceId]);

  if (prepared === undefined) {
    if (streaming || fallbackLoading) {
      return (
        <section style={shellStyle} data-pianist-streaming={streaming ? 'true' : undefined} aria-label={streamPreview?.title ?? t('playerPreparing')}>
          <style>{`
            @keyframes pianist-ready-scan { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
            @media (prefers-reduced-motion: reduce) { [data-pianist-ready-scan] { animation: none !important; } }
          `}</style>
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 12px' }}>
            <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {streamPreview?.title ?? t('playerPreparing')}
            </strong>
            <span style={{ color: 'var(--dsw-alias-fg-muted)', fontSize: 12 }} role="status">
              {streamPreview?.noteGroupCount ? `${String(streamPreview.soundedNoteCount)} ${t('playerNotes')}` : t('playerPreparing')}
            </span>
          </header>
          <div style={{ height: 'clamp(190px, 34vw, 300px)', position: 'relative', overflow: 'hidden', background: 'linear-gradient(180deg, rgba(23,26,38,0.42), rgba(29,34,49,0.38) 55%, rgba(36,43,61,0.40))' }}>
            <div data-pianist-ready-scan style={{ position: 'absolute', inset: 0, width: '35%', background: 'linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.09), transparent)', animation: 'pianist-ready-scan 1.8s ease-in-out infinite' }} />
            <div aria-hidden="true" style={{ position: 'absolute', left: 12, right: 12, bottom: 14, height: 58, display: 'grid', gridTemplateColumns: 'repeat(18, 1fr)', gap: 1, padding: '8px 8px 0', border: '1px solid rgba(255, 255, 255, 0.16)', borderRadius: 6, background: 'linear-gradient(rgba(30,33,46,0.85), rgba(16,18,27,0.9))' }}>
              {Array.from({ length: 18 }, (_, index) => <span key={index} style={{ background: index % 7 === 1 || index % 7 === 4 ? '#262836' : 'linear-gradient(#f5f2ea, #c9c4b8)', opacity: 0.68 }} />)}
            </div>
          </div>
        </section>
      );
    }
    return <div style={{ ...shellStyle, padding: '10px 12px' }} role="status">{t('playerUnavailable')}</div>;
  }

  const view = viewRef.current;
  const duration = prepared.result.payload.duration;
  const playing = state === 'playing';
  const togglePlayback = (): void => {
    const target = viewRef.current;
    if (target === null) return;
    if (playing) {
      target.pause();
      setState('paused');
      return;
    }
    setAudioError(false);
    void target.play().then(() => {
      setState(target.playbackState ?? 'playing');
    }, () => {
      setAudioError(true);
      setState('paused');
    });
  };

  return (
    <section
      style={immersive ? immersiveShellStyle : shellStyle}
      data-pianist-performance={prepared.result.performanceId}
      data-pianist-streaming={prepared.streaming ? 'true' : undefined}
      aria-label={prepared.result.title}
    >
      <style>{`
        .dsh-piano-tool-btn { -webkit-tap-highlight-color: transparent; }
        .dsh-piano-tool-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.10);
          border-color: rgba(255, 255, 255, 0.34);
        }
        .dsh-piano-tool-btn:focus-visible { outline: 2px solid var(--dsw-alias-border-focus, #68a8ff); outline-offset: 1px; }
        .dsh-piano-tool-btn:active:not(:disabled):not(:focus) { transform: translateY(1px) scale(0.97); }
        .dsh-piano-tool-btn:disabled { opacity: 0.42; cursor: default; }
        .dsh-piano-tool input[type="range"]:focus-visible, .dsh-piano-tool select:focus-visible {
          outline: 2px solid var(--dsw-alias-border-focus, #68a8ff); outline-offset: 1px;
        }
        @media (prefers-reduced-motion: reduce) {
          .dsh-piano-tool-btn { transition: none !important; }
        }
      `}</style>
      {!immersive ? (
        <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 12px' }}>
          <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {prepared.result.title}
          </strong>
          <span style={{ color: 'var(--dsw-alias-fg-muted)', fontSize: 12 }}>
            {prepared.result.noteCount} {t('playerNotes')}{prepared.streaming ? ` · ${t('playerStreaming')}` : ''}
          </span>
        </header>
      ) : null}
      {createElement('dsh-piano-view', {
        ref: (element: PianoViewElement | null) => { viewRef.current = element; },
        style: immersive
          ? { display: 'block' }
          : { display: 'block', width: '100%', height: 'clamp(190px, 34vw, 300px)', background: 'transparent' },
      })}
      {!immersive ? (
        <div style={toolbarStyle} className="dsh-piano-tool">
          {iconButton(
            playing ? t('playerPause') : t('playerPlay'),
            playing ? <IconPauseOutline16 /> : <IconPlayOutline16 />,
            togglePlayback,
          )}
          {iconButton(t('playerStop'), <IconStopFill16 />, () => {
            viewRef.current?.stop();
            setCurrentTime(0);
            setState('ready');
          })}
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, minWidth: 78 }}>
            {formatSeconds(currentTime)} / {formatSeconds(duration)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.001)}
            step={0.01}
            value={Math.min(currentTime, duration)}
            aria-label={t('playerSeek')}
            style={{ flex: 1, minWidth: 70 }}
            onChange={(event) => {
              const next = Number(event.target.value);
              viewRef.current?.seek(next);
              setCurrentTime(next);
            }}
          />
          <select
            value={rate}
            aria-label={t('playerRate')}
            title={t('playerRate')}
            style={{ height: 30, maxWidth: 72 }}
            onChange={(event) => {
              const next = Number(event.target.value);
              setRate(next);
              viewRef.current?.setRate(next);
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}x</option>)}
          </select>
          {iconButton(t('playerImmersive'), <IconFullscreenOutline16 />, () => {
            viewRef.current?.requestImmersive();
          }, view === null)}
        </div>
      ) : null}
      {!immersive && audioError ? (
        <div role="status" style={{ color: 'var(--dsw-alias-fg-muted)', fontSize: 12, padding: '0 12px 9px' }}>
          {t('playerAudioBlocked')}
        </div>
      ) : null}
    </section>
  );
}
