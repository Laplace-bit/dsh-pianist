import type { TimelineData } from '../core/types.js';
import { computeVisualState, type VisualState } from './visual-state.js';
import { VisualTimeline, type VisualTimelineWindow } from './visual-timeline.js';

export interface OfflineVisualFrame {
  readonly frameIndex: number;
  readonly fps: number;
  readonly musicalTime: number;
  readonly state: VisualState;
  readonly window: VisualTimelineWindow;
}

export interface OfflineVisualFrameOptions {
  readonly lookBehindSeconds?: number;
  readonly lookAheadSeconds?: number;
}

function assertFrameIndex(frameIndex: number): number {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError('frameIndex must be a non-negative integer');
  }
  return frameIndex;
}

function assertFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError('fps must be a positive finite number');
  }
  return fps;
}

/** Convert a frame number to the canonical musical time without accumulated deltas. */
export function musicalTimeForFrame(frameIndex: number, fps: number): number {
  return assertFrameIndex(frameIndex) / assertFps(fps);
}

/**
 * Stateful only in its immutable timeline projection. Each output frame is
 * reconstructed from `frameIndex / fps`, suitable for a future video exporter
 * that calls the existing WebGL renderer without recording live playback.
 */
export class OfflineVisualFrameRenderer {
  private readonly visualTimeline: VisualTimeline;

  constructor(private readonly timeline: TimelineData) {
    this.visualTimeline = new VisualTimeline(timeline);
  }

  render(
    frameIndex: number,
    fps: number,
    options: OfflineVisualFrameOptions = {},
  ): OfflineVisualFrame {
    const musicalTime = musicalTimeForFrame(frameIndex, fps);
    const lookBehind = options.lookBehindSeconds ?? 1.2;
    const lookAhead = options.lookAheadSeconds ?? 8;
    if (!Number.isFinite(lookBehind) || lookBehind < 0 || !Number.isFinite(lookAhead) || lookAhead < 0) {
      throw new RangeError('visual frame window sizes must be non-negative finite numbers');
    }
    return Object.freeze({
      frameIndex,
      fps,
      musicalTime,
      state: computeVisualState(this.timeline, musicalTime),
      window: this.visualTimeline.window(Math.max(0, musicalTime - lookBehind), musicalTime + lookAhead),
    });
  }
}
