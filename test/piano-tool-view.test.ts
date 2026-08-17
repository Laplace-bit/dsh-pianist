/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compilePianoPerformance } from '../src/shared/piano-tool.js';
import { PianoToolView } from '../src/client/PianoToolView.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconFullscreenOutline16: () => createElement('span', null, 'fullscreen-icon'),
  IconPauseOutline16: () => createElement('span', null, 'pause-icon'),
  IconPlayOutline16: () => createElement('span', null, 'play-icon'),
  IconStopFill16: () => createElement('span', null, 'stop-icon'),
}));

const setScore = vi.fn();
const updateScore = vi.fn(() => Promise.resolve());
const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();
const stop = vi.fn();
const seek = vi.fn();
const readPerformance = vi.fn();

class FakePianoView extends HTMLElement {
  currentTime = 0;
  duration = 2;
  playbackState = 'ready';
  setScore = setScore;
  updateScore = updateScore;
  play = play;
  pause = pause;
  stop = stop;
  seek = seek;
  toggleFullscreen = vi.fn(() => Promise.resolve());
}

const mounted = new Set<ReturnType<typeof createRoot>>();

beforeEach(() => {
  if (customElements.get('dsh-piano-view') === undefined) {
    customElements.define('dsh-piano-view', FakePianoView);
  }
  setScore.mockClear();
  updateScore.mockClear();
  play.mockClear();
  pause.mockClear();
  stop.mockClear();
  seek.mockClear();
  readPerformance.mockReset();
});

afterEach(() => {
  for (const root of mounted) act(() => { root.unmount(); });
  mounted.clear();
  document.body.replaceChildren();
});

function settledBlock() {
  const result = compilePianoPerformance({
    title: 'Conversation nocturne',
    bpm: 80,
    notes: [{ pitches: ['C4'], startBeat: 0, durationBeats: 1 }],
    autoplay: true,
  }, 'piano-call-1');
  return {
    kind: 'tool-result',
    callId: 'call-1',
    call: { name: 'piano_perform', argsRaw: '{}' },
    content: [],
    isError: false,
    meta: { kind: 'dsh-pianist-performance', ...result },
    subCalls: [],
  };
}

describe('piano_perform conversation view', () => {
  it('keeps one presentation action instead of separate immersive and fullscreen buttons', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.add(root);

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform',
        block: settledBlock(),
        callId: 'call-one-presentation-action',
        openFile: () => {},
        t: (key: string) => key,
        readPerformance,
      } as never));
    });

    expect(container.querySelectorAll('button[aria-label="playerImmersive"]')).toHaveLength(1);
    expect(container.querySelector('button[aria-label="playerFullscreen"]')).toBeNull();
  });

  it('restores a persisted tool result without autoplaying conversation history', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.add(root);

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform',
        block: settledBlock(),
        callId: 'call-1',
        openFile: () => {},
        t: (key: string) => key,
        readPerformance,
      } as never));
    });

    expect(container.querySelector('dsh-piano-view')).not.toBeNull();
    expect(setScore).toHaveBeenCalledWith(expect.objectContaining({ title: 'Conversation nocturne' }));
    expect(play).not.toHaveBeenCalled();

    act(() => { container.querySelector<HTMLButtonElement>('button[aria-label="playerStop"]')?.click(); });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not reload and interrupt the same logical performance when DSH refreshes its block', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.add(root);
    const first = settledBlock();

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform',
        block: first,
        callId: 'call-stable',
        openFile: () => {},
        t: (key: string) => key,
        readPerformance,
      } as never));
    });
    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform',
        block: structuredClone(first),
        callId: 'call-stable',
        openFile: () => {},
        t: (key: string) => key,
        readPerformance,
      } as never));
    });

    expect(setScore).toHaveBeenCalledTimes(1);
  });

  it('autoplays a newly completed live call only once across a view remount', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const firstRoot = createRoot(container);
    const running = {
      callId: 'call-live-once',
      name: 'piano_perform',
      argsRaw: '{"title":"Live nocturne"',
      turn: 1,
      step: 1,
      time: Date.now(),
      callView: null,
      subCalls: [],
    };
    const settled = settledBlock();
    settled.callId = 'call-live-once';

    await act(async () => {
      firstRoot.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: running, callId: 'call-live-once',
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
    });
    await act(async () => {
      firstRoot.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: settled, callId: 'call-live-once',
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
    });
    await act(async () => { firstRoot.unmount(); });

    const secondRoot = createRoot(container);
    mounted.add(secondRoot);
    await act(async () => {
      secondRoot.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: structuredClone(settled), callId: 'call-live-once',
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
    });

    expect(play).toHaveBeenCalledTimes(1);
  });

  it('renders and starts a safe streamed prefix, then appends without restarting playback', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.add(root);
    const notes = Array.from({ length: 9 }, (_, index) => ({
      pitches: ['C4'], startBeat: index, durationBeats: 1, hand: 'right',
    }));
    const input = {
      title: 'Streaming prelude',
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      pedals: [],
      tempoChanges: [],
      autoplay: true,
      notes,
    };
    const running = {
      callId: 'call-stream-prefix', name: 'piano_perform',
      argsRaw: JSON.stringify(input).slice(0, -2),
      turn: 1, step: 1, time: Date.now() - 2_000, callView: null, subCalls: [],
    };

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: running, callId: running.callId,
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-pianist-streaming="true"]')).not.toBeNull();
    expect(setScore).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);

    const extended = {
      ...running,
      argsRaw: JSON.stringify({ ...input, notes: [...notes, { ...notes[0], startBeat: 9 }] }).slice(0, -2),
    };
    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: extended, callId: running.callId,
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
      await Promise.resolve();
    });

    expect(updateScore).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('batches large streamed prefixes instead of recompiling every note delta', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.add(root);
    const makeNotes = (count: number) => Array.from({ length: count }, (_, index) => ({
      pitches: ['C4'], startBeat: index, durationBeats: 1,
    }));
    const block = (count: number) => ({
      callId: 'call-stream-batched', name: 'piano_perform',
      argsRaw: JSON.stringify({ title: 'Batched stream', bpm: 120, notes: makeNotes(count) }).slice(0, -2),
      turn: 1, step: 1, time: 8_000, callView: null, subCalls: [],
    });

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: block(40), callId: 'call-stream-batched',
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: block(41), callId: 'call-stream-batched',
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
      await Promise.resolve();
    });

    expect(setScore).toHaveBeenCalledTimes(1);
    expect(updateScore).not.toHaveBeenCalled();

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: block(56), callId: 'call-stream-batched',
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
      await Promise.resolve();
    });
    expect(updateScore).toHaveBeenCalledTimes(1);
  });

  it('keeps the last playable streamed prefix while the next JSON delta is incomplete', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.add(root);
    const input = {
      title: 'Streaming continuity',
      bpm: 120,
      notes: Array.from({ length: 9 }, (_, index) => ({
        pitches: ['C4'], startBeat: index, durationBeats: 1,
      })),
      autoplay: true,
    };
    const running = {
      callId: 'call-stream-gap', name: 'piano_perform',
      argsRaw: JSON.stringify(input).slice(0, -2),
      turn: 1, step: 1, time: Date.now() - 2_000, callView: null, subCalls: [],
    };

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform', block: running, callId: running.callId,
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
      await Promise.resolve();
    });
    expect(container.querySelector('dsh-piano-view')).not.toBeNull();
    expect(play).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform',
        block: { ...running, argsRaw: '{"title":"Streaming continuity","bpm":120,"notes":[{"pitches":["C' },
        callId: running.callId,
        openFile: () => {}, t: (key: string) => key, readPerformance,
      } as never));
      await Promise.resolve();
    });

    expect(container.querySelector('dsh-piano-view')).not.toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('recovers a Code Mode subcall through the bounded performance reader', async () => {
    const result = compilePianoPerformance({
      title: 'Code mode scale',
      bpm: 100,
      notes: [{ pitches: ['C4'], startBeat: 0, durationBeats: 1 }],
      autoplay: false,
    }, 'piano-code-1');
    readPerformance.mockResolvedValue(result);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.add(root);

    await act(async () => {
      root.render(createElement(PianoToolView, {
        toolName: 'piano_perform',
        block: {
          kind: 'tool-result',
          callId: 'call-code',
          call: { name: 'piano_perform', argsRaw: '{}' },
          content: [{ type: 'text', text: 'Prepared piano performance "Code mode scale". Performance ID: piano-code-1. The inline player is ready.' }],
          isError: false,
          subCalls: [],
        },
        callId: 'call-code',
        openFile: () => {},
        t: (key: string) => key,
        readPerformance,
      } as never));
      await Promise.resolve();
    });

    expect(readPerformance).toHaveBeenCalledWith('piano-code-1');
    expect(setScore).toHaveBeenCalledWith(expect.objectContaining({ title: 'Code mode scale' }));
  });
});
