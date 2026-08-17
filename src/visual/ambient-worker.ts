/**
 * Optional worker for the arithmetic-only part of the atmosphere.
 *
 * The worker never touches audio, DOM, or Canvas2D. It integrates the short
 * lived meteor events and returns a compact Float32Array so the main thread
 * only performs the compositing and piano interaction work. A Blob-backed
 * module keeps this optional path usable from the bundled client without a
 * separate public worker URL; CSP or older browsers simply fall back.
 */

export interface AmbientMeteorSeed {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  width: number;
  phase: number;
  cycle: number;
  travel: number;
  alpha: number;
}

/** x, y, tailX, tailY, width, alpha. */
export const AMBIENT_METEOR_STRIDE = 6;

export type AmbientMeteorFrame = Float32Array;

interface AmbientWorkerResizeMessage {
  type: 'resize';
  meteors: AmbientMeteorSeed[];
}

interface AmbientWorkerFrameMessage {
  type: 'frame';
  time: number;
  high: number;
}

type AmbientWorkerMessage = AmbientWorkerResizeMessage | AmbientWorkerFrameMessage;

interface AmbientWorkerResponse {
  type: 'frame';
  values: Float32Array;
}

const WORKER_SOURCE = `
  let meteors = [];
  self.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'resize') {
      meteors = Array.isArray(message.meteors) ? message.meteors : [];
      return;
    }
    if (message.type !== 'frame') return;
    const time = Number(message.time) || 0;
    const high = Number(message.high) || 0;
    const values = new Float32Array(meteors.length * ${String(AMBIENT_METEOR_STRIDE)});
    let count = 0;
    for (const meteor of meteors) {
      const cycle = Math.max(0.1, meteor.cycle);
      const travel = Math.max(0.05, meteor.travel);
      const elapsed = ((time + meteor.phase) % cycle + cycle) % cycle;
      if (elapsed > travel) continue;
      const progress = elapsed / travel;
      const envelope = Math.sin(Math.PI * Math.pow(progress, 0.72));
      const x = meteor.x + elapsed * meteor.vx;
      const y = meteor.y + elapsed * meteor.vy;
      const tailX = x - meteor.length;
      const tailY = y - meteor.length * meteor.vy / meteor.vx;
      const offset = count * ${String(AMBIENT_METEOR_STRIDE)};
      values[offset] = x;
      values[offset + 1] = y;
      values[offset + 2] = tailX;
      values[offset + 3] = tailY;
      values[offset + 4] = meteor.width;
      values[offset + 5] = meteor.alpha * envelope * (0.72 + high * 0.35);
      count += 1;
    }
    const output = values.slice(0, count * ${String(AMBIENT_METEOR_STRIDE)});
    self.postMessage({ type: 'frame', values: output }, [output.buffer]);
  };
`;

export interface AmbientWorkerBridge {
  resize(seeds: readonly AmbientMeteorSeed[]): void;
  /** False means the worker failed and the caller should use its local path. */
  request(time: number, high: number): boolean;
  onFrame(callback: (frame: AmbientMeteorFrame) => void): void;
  dispose(): void;
}

export function createAmbientWorker(): AmbientWorkerBridge | undefined {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return undefined;
  }
  let url: string | undefined;
  let worker: Worker;
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url, { type: 'module', name: 'dsh-pianist-atmosphere' });
  } catch {
    if (url !== undefined) URL.revokeObjectURL(url);
    return undefined;
  }
  let callback: ((frame: AmbientMeteorFrame) => void) | undefined;
  let disabled = false;
  let frameInFlight = false;
  let queuedFrame: AmbientWorkerFrameMessage | undefined;
  const disable = (): void => {
    if (disabled) return;
    disabled = true;
    frameInFlight = false;
    queuedFrame = undefined;
    worker.terminate();
    if (url !== undefined) URL.revokeObjectURL(url);
  };
  const send = (message: AmbientWorkerMessage): boolean => {
    if (disabled) return false;
    try {
      worker.postMessage(message);
      return true;
    } catch {
      disable();
      return false;
    }
  };
  worker.addEventListener('error', disable);
  worker.addEventListener('message', (event: MessageEvent<AmbientWorkerResponse>) => {
    if (event.data?.type !== 'frame' || !(event.data.values instanceof Float32Array)) return;
    frameInFlight = false;
    callback?.(event.data.values);
    if (queuedFrame !== undefined) {
      const next = queuedFrame;
      queuedFrame = undefined;
      frameInFlight = true;
      send(next);
    }
  });
  return {
    resize(seeds) {
      send({ type: 'resize', meteors: [...seeds] });
    },
    request(time, high) {
      if (disabled) return false;
      const next: AmbientWorkerFrameMessage = { type: 'frame', time, high };
      if (frameInFlight) {
        // Rendering is latency-sensitive, not lossless. Replace stale queued
        // work so a slow worker can never build an ever-growing frame backlog.
        queuedFrame = next;
        return true;
      }
      frameInFlight = true;
      return send(next);
    },
    onFrame(next) { callback = next; },
    dispose() {
      disable();
      queuedFrame = undefined;
      callback = undefined;
    },
  };
}
