// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAmbientWorker } from '../src/visual/ambient-worker.js';

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly messages: unknown[] = [];
  readonly listeners = new Map<string, (event: { data?: unknown }) => void>();
  terminated = false;

  constructor(readonly url: string, readonly options: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as unknown as (event: { data?: unknown }) => void);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitError(): void {
    this.listeners.get('error')?.({});
  }

  emitFrame(values: Float32Array): void {
    this.listeners.get('message')?.({ data: { type: 'frame', values } });
  }
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ambient worker bridge', () => {
  it('transfers layout seeds once and decodes compact frame data', () => {
    const createObjectURL = vi.fn(() => 'blob:pianist-worker');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('Worker', FakeWorker);

    const bridge = createAmbientWorker();
    expect(bridge).toBeDefined();
    const worker = FakeWorker.instances[0]!;
    expect(worker.options).toMatchObject({ type: 'module', name: 'dsh-pianist-atmosphere' });

    bridge!.resize([{
      x: 10, y: 20, vx: 180, vy: 90, length: 100, width: 1,
      phase: 2, cycle: 8, travel: 1, alpha: 0.5,
    }]);
    bridge!.request(4.2, 0.3);

    expect(worker.messages[0]).toMatchObject({ type: 'resize', meteors: [{ x: 10, y: 20 }] });
    expect(worker.messages[1]).toEqual({ type: 'frame', time: 4.2, high: 0.3 });

    const frames: unknown[] = [];
    bridge!.onFrame(frame => frames.push(frame));
    worker.emitFrame(new Float32Array([40, 30, -60, -20, 1.5, 0.42]));
    expect(frames).toHaveLength(1);
    expect([...frames[0] as Float32Array]).toEqual([40, 30, -60, -20, 1.5, expect.closeTo(0.42, 5)]);

    bridge!.dispose();
    expect(worker.terminated).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pianist-worker');
  });

  it('coalesces requests while a frame is in flight', () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:pianist-worker', revokeObjectURL: vi.fn() });
    vi.stubGlobal('Worker', FakeWorker);
    const bridge = createAmbientWorker()!;
    const worker = FakeWorker.instances[0]!;

    bridge.request(1, 0.1);
    bridge.request(2, 0.2);
    bridge.request(3, 0.3);
    expect(worker.messages).toEqual([{ type: 'frame', time: 1, high: 0.1 }]);

    worker.emitFrame(new Float32Array());
    expect(worker.messages).toEqual([
      { type: 'frame', time: 1, high: 0.1 },
      { type: 'frame', time: 3, high: 0.3 },
    ]);

    worker.emitError();
    expect(bridge.request(4, 0.4)).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it('uses the synchronous scene fallback when workers are unavailable', () => {
    vi.stubGlobal('Worker', undefined);
    expect(createAmbientWorker()).toBeUndefined();
  });
});
