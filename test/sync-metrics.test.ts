import { describe, expect, it } from 'vitest';
import { computeDroppedEvents, computeSyncMetrics } from '../src/sync/metrics.js';

describe('sync metrics', () => {
  it('computes p95/p99 error in milliseconds', () => {
    const samples = Array.from({ length: 100 }, (_, index) => ({
      eventId: `e${index}`,
      expectedTime: index * 0.1,
      observedTime: index * 0.1 + (index % 10) / 1000,
    }));
    const metrics = computeSyncMetrics(samples);
    expect(metrics.count).toBe(100);
    expect(metrics.p95Ms).toBeLessThanOrEqual(9.001);
    expect(metrics.p99Ms).toBeLessThanOrEqual(9.001);
    expect(metrics.maxErrorMs).toBeCloseTo(9, 6);
    expect(metrics.duplicated).toBe(0);
    expect(metrics.outOfOrder).toBe(0);
  });

  it('detects duplicates and out-of-order timeline samples', () => {
    const metrics = computeSyncMetrics([
      { eventId: 'b', expectedTime: 0.2, observedTime: 0.2 },
      { eventId: 'a', expectedTime: 0.1, observedTime: 0.1 },
      { eventId: 'a', expectedTime: 0.1, observedTime: 0.1 },
    ]);
    expect(metrics.duplicated).toBe(1);
    expect(metrics.outOfOrder).toBe(1);
  });

  it('reports dropped events', () => {
    expect(computeDroppedEvents(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
  });
});
