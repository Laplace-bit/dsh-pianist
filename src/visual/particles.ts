import type { PerformanceEvent } from '../core/types.js';

export interface PianoParticle {
  id: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  lifeSeconds: number;
  intensity: number;
}

/**
 * One gravity step for a spark impact, in canvas space where y grows
 * downward: `g` is the downward acceleration in px/s², so an upward-launched
 * spark (negative vy) decelerates, arcs over, and falls back toward the
 * keyboard. Horizontal velocity is untouched.
 */
export function applySparkGravity(
  spark: { vx?: number; vy?: number; g?: number },
  deltaSeconds: number,
): void {
  spark.vy = (spark.vy ?? 0) + (spark.g ?? 0) * deltaSeconds;
}

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function nextRandom(seed: number): [number, number] {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return [value >>> 0, (value >>> 0) / 4_294_967_296];
}

/**
 * Make a reproducible note-on particle burst. No visual event depends on
 * Math.random(), so pause, seek, and replay produce the same burst geometry.
 */
export function createParticleBurst(event: PerformanceEvent): PianoParticle[] {
  if (event.type !== 'noteOn' || event.noteId === undefined || event.velocity === undefined) {
    return [];
  }

  const velocity = Math.min(1, Math.max(0, event.velocity));
  const count = 3 + Math.round(velocity * 9);
  const particles: PianoParticle[] = [];
  let seed = hashSeed(event.id);
  for (let index = 0; index < count; index += 1) {
    let random: number;
    [seed, random] = nextRandom(seed);
    const angle = (random - 0.5) * Math.PI;
    [seed, random] = nextRandom(seed);
    const speed = 20 + random * (30 + velocity * 50);
    [seed, random] = nextRandom(seed);
    particles.push({
      id: `${event.id}:particle:${index}`,
      x: 0,
      y: 0,
      velocityX: Math.sin(angle) * speed,
      velocityY: -(Math.cos(angle) * speed),
      lifeSeconds: 0.2 + random * 0.35,
      intensity: 0.35 + velocity * 0.65,
    });
  }
  return particles;
}
