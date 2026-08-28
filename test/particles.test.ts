import { describe, expect, it } from 'vitest';
import { applySparkGravity } from '../src/visual/particles.js';

describe('applySparkGravity', () => {
  it('decelerates an upward-launched spark, arcs it over, and brings it back down', () => {
    // Canvas space: y grows downward, so a spark launched toward the sky has
    // negative vy and gravity increases vy over time.
    const spark = { vx: 12, vy: -20, g: 7 };
    for (let step = 0; step < 40; step += 1) {
      applySparkGravity(spark, 0.1); // Four seconds of integration.
    }
    expect(spark.vy).toBeCloseTo(-20 + 7 * 4, 10);
    expect(spark.vy).toBeGreaterThan(0); // Past its apex, falling toward the keys.
  });

  it('never touches horizontal velocity', () => {
    const spark = { vx: 30, vy: -20, g: 7 };
    applySparkGravity(spark, 1.5);
    expect(spark.vx).toBe(30);

    const driftless = { vx: -4, vy: 10, g: 100 };
    applySparkGravity(driftless, 0.5);
    expect(driftless.vx).toBe(-4);
    expect(driftless.vy).toBeCloseTo(60, 10);
  });

  it('is inert without gravity or velocity fields', () => {
    const spark = { vy: -9 };
    applySparkGravity(spark, 0.25);
    expect(spark.vy).toBe(-9);

    const empty: { vx?: number; vy?: number; g?: number } = {};
    applySparkGravity(empty, 0.25);
    expect(empty.vy).toBe(0);
  });
});
