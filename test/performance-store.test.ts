import { describe, expect, it } from 'vitest';
import { PianoPerformanceStore } from '../src/host/performance-store.js';
import { compilePianoPerformance } from '../src/shared/piano-tool.js';

function performance(id: string) {
  return compilePianoPerformance({
    title: id,
    bpm: 120,
    notes: [{ pitches: ['C4'], startBeat: 0, durationBeats: 1 }],
  }, id);
}

describe('PianoPerformanceStore', () => {
  it('keeps a bounded cloneable LRU view for Code Mode', () => {
    const store = new PianoPerformanceStore(2);
    const first = performance('piano-1');
    store.set(first);
    first.title = 'mutated outside store';
    store.set(performance('piano-2'));
    store.set(performance('piano-3'));

    expect(store.get('piano-1')).toBeUndefined();
    expect(store.get('piano-2')?.title).toBe('piano-2');
    const copy = store.get('piano-3');
    expect(copy?.title).toBe('piano-3');
    if (copy !== undefined) copy.title = 'mutated copy';
    expect(store.get('piano-3')?.title).toBe('piano-3');
  });

  it('refreshes active entries before evicting the oldest one', () => {
    const store = new PianoPerformanceStore(2);
    store.set(performance('piano-1'));
    store.set(performance('piano-2'));
    expect(store.get('piano-1')).toBeDefined();
    store.set(performance('piano-3'));

    expect(store.get('piano-1')).toBeDefined();
    expect(store.get('piano-2')).toBeUndefined();
  });
});
