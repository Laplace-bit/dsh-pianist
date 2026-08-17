import { describe, expect, it } from 'vitest';
import { MusicalClock } from '../src/audio/musical-clock.js';

class FakeContext {
  private now = 0;
  get currentTime(): number {
    return this.now;
  }
  advance(seconds: number): void {
    this.now += seconds;
  }
}

describe('MusicalClock', () => {
  it('advances from AudioContext currentTime while playing', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    clock.play();
    context.advance(1);
    expect(clock.currentTime).toBeCloseTo(1, 10);
    clock.pause();
    expect(clock.currentTime).toBeCloseTo(1, 10);
    context.advance(10);
    expect(clock.currentTime).toBeCloseTo(1, 10);
  });

  it('seeks without accumulating frame time', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    clock.play();
    context.advance(2);
    clock.seek(5);
    context.advance(1);
    expect(clock.currentTime).toBeCloseTo(6, 10);
  });

  it('applies playback rate to context time but not to musical time', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    clock.play();
    clock.setRate(2);
    context.advance(3);
    expect(clock.currentTime).toBeCloseTo(6, 10);
    expect(clock.toContextTime(8)).toBeCloseTo(4, 10);
  });

  it('keeps elapsed musical time when changing rate during playback', () => {
    const context = new FakeContext();
    const clock = new MusicalClock(context);
    clock.play();
    context.advance(2);

    clock.setRate(1.5);
    expect(clock.currentTime).toBeCloseTo(2, 10);

    context.advance(2);
    expect(clock.currentTime).toBeCloseTo(5, 10);
  });

  it('rejects non-positive rates', () => {
    const clock = new MusicalClock(new FakeContext());
    expect(() => clock.setRate(0)).toThrow(/rate/);
  });
});
