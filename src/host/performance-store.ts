import type { PianoToolResult } from '../shared/piano-tool.js';

const DEFAULT_PERFORMANCE_LIMIT = 32;

/**
 * Bounded live fallback for Code Mode subcalls, whose presentation metadata is
 * intentionally not persisted by DSH. Native calls replay from session meta.
 */
export class PianoPerformanceStore {
  private readonly entries = new Map<string, PianoToolResult>();

  constructor(private readonly limit = DEFAULT_PERFORMANCE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('performance store limit must be a positive integer');
    }
  }

  set(result: PianoToolResult): void {
    const copy = structuredClone(result);
    this.entries.delete(result.performanceId);
    this.entries.set(result.performanceId, copy);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(performanceId: string): PianoToolResult | undefined {
    const value = this.entries.get(performanceId);
    if (value === undefined) return undefined;
    // Refresh access order so an actively displayed Code Mode result survives.
    this.entries.delete(performanceId);
    this.entries.set(performanceId, value);
    return structuredClone(value);
  }
}
