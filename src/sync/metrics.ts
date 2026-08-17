export interface SyncSample {
  eventId: string;
  /** Expected timeline time in seconds. */
  expectedTime: number;
  /** Observed audio/visual time in seconds. */
  observedTime: number;
}

export interface SyncMetrics {
  count: number;
  meanErrorMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxErrorMs: number;
  dropped: number;
  duplicated: number;
  outOfOrder: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function computeSyncMetrics(samples: readonly SyncSample[]): SyncMetrics {
  const sortedByExpected = [...samples].sort((a, b) => a.expectedTime - b.expectedTime);
  const errorsMs = samples.map((sample) => Math.abs(sample.observedTime - sample.expectedTime) * 1000);
  errorsMs.sort((a, b) => a - b);

  const seen = new Set<string>();
  let duplicated = 0;
  let outOfOrder = 0;
  let lastExpected = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (seen.has(sample.eventId)) {
      duplicated += 1;
    }
    seen.add(sample.eventId);
    if (sample.expectedTime < lastExpected - 1e-9) {
      outOfOrder += 1;
    }
    lastExpected = sample.expectedTime;
  }

  return {
    count: samples.length,
    meanErrorMs: samples.length === 0 ? 0 : errorsMs.reduce((sum, value) => sum + value, 0) / samples.length,
    p50Ms: percentile(errorsMs, 50),
    p95Ms: percentile(errorsMs, 95),
    p99Ms: percentile(errorsMs, 99),
    maxErrorMs: errorsMs.length === 0 ? 0 : errorsMs[errorsMs.length - 1],
    dropped: 0,
    duplicated,
    outOfOrder,
  };
}

/**
 * Given the full timeline and the observed event IDs, compute how many timeline
 * events were not observed.
 */
export function computeDroppedEvents(
  timelineEventIds: readonly string[],
  observedEventIds: readonly string[],
): number {
  const observed = new Set(observedEventIds);
  return timelineEventIds.filter((id) => observed.has(id) === false).length;
}
