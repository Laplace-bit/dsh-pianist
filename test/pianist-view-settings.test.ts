import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PIANIST_SETTINGS, type PianistSettings } from '../src/shared/pianist-settings.js';
import { PianistViewSettingsBridge } from '../src/client/pianist-view-settings.js';
import { PianoSamplePack, type PianoSampleLayer } from '../src/audio/sample-pack.js';

interface FakeView {
  readonly nodeType: 1;
  matches(selector: string): boolean;
  querySelectorAll(selector: string): readonly FakeView[];
  setPianistSettings(settings: PianistSettings): void;
  setSamplePack(samplePack: PianoSamplePack | null): void;
}

function settings(overrides: Partial<PianistSettings> = {}): PianistSettings {
  return {
    ...DEFAULT_PIANIST_SETTINGS,
    ...overrides,
    events: { ...DEFAULT_PIANIST_SETTINGS.events, ...overrides.events },
  };
}

function view(received: PianistSettings[], packs: Array<PianoSamplePack | null> = []): FakeView {
  return {
    nodeType: 1,
    matches: (selector) => selector === 'dsh-piano-view',
    querySelectorAll: () => [],
    setPianistSettings: (next) => { received.push(next); },
    setSamplePack: (next) => { packs.push(next); },
  };
}

function documentWith(views: FakeView[]): Document {
  return {
    documentElement: {} as HTMLElement,
    querySelectorAll: () => views as unknown as NodeListOf<Element>,
  } as unknown as Document;
}

class TestMutationObserver {
  static instance: TestMutationObserver | undefined;

  constructor(readonly callback: MutationCallback) {
    TestMutationObserver.instance = this;
  }

  observe(): void {}

  disconnect(): void {}
}

const originalMutationObserver = globalThis.MutationObserver;

afterEach(() => {
  TestMutationObserver.instance = undefined;
  if (originalMutationObserver === undefined) {
    delete (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  } else {
    (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver = originalMutationObserver;
  }
});

describe('PianistViewSettingsBridge', () => {
  it('publishes the bundled pack before settings to existing and later views', () => {
    (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver = TestMutationObserver as unknown as typeof MutationObserver;
    const layer: PianoSampleLayer = { id: 'c4', rootMidi: 60, velocity: 0.5, load: () => ({}) as AudioBuffer };
    const pack = new PianoSamplePack([layer]);
    const existingSettings: PianistSettings[] = [];
    const existingPacks: Array<PianoSamplePack | null> = [];
    const bridge = new PianistViewSettingsBridge(documentWith([view(existingSettings, existingPacks)]), pack);

    bridge.start();
    bridge.setCommittedSettings(settings());
    const laterSettings: PianistSettings[] = [];
    const laterPacks: Array<PianoSamplePack | null> = [];
    TestMutationObserver.instance?.callback([{
      addedNodes: [view(laterSettings, laterPacks) as unknown as Node],
    } as unknown as MutationRecord], TestMutationObserver.instance as unknown as MutationObserver);

    expect(existingPacks).toEqual([pack, pack]);
    expect(existingSettings).toEqual([settings()]);
    expect(laterPacks).toEqual([pack]);
    expect(laterSettings).toEqual([settings()]);
    bridge.stop();
  });

  it('publishes a committed profile value to existing views without retaining the caller object', () => {
    const received: PianistSettings[] = [];
    const bridge = new PianistViewSettingsBridge(documentWith([view(received)]));
    const committed = settings({ volume: 0.35 });

    bridge.setCommittedSettings(committed);
    committed.volume = 0.9;

    expect(received).toEqual([settings({ volume: 0.35 })]);
  });

  it('remembers a committed value for views connected after the RPC result', () => {
    (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver = TestMutationObserver as unknown as typeof MutationObserver;
    const existing: PianistSettings[] = [];
    const later: PianistSettings[] = [];
    const bridge = new PianistViewSettingsBridge(documentWith([view(existing)]));
    bridge.start();
    bridge.setCommittedSettings(settings({ enabled: false, showWaterfall: false }));

    TestMutationObserver.instance?.callback([{
      addedNodes: [view(later) as unknown as Node],
    } as unknown as MutationRecord], TestMutationObserver.instance as unknown as MutationObserver);

    expect(existing).toEqual([settings({ enabled: false, showWaterfall: false })]);
    expect(later).toEqual([settings({ enabled: false, showWaterfall: false })]);
    bridge.stop();
  });

  it('does not reapply an identical committed payload during unrelated card state changes', () => {
    const received: PianistSettings[] = [];
    const bridge = new PianistViewSettingsBridge(documentWith([view(received)]));
    const committed = settings({ visualQuality: 'high' });

    bridge.setCommittedSettings(committed);
    bridge.setCommittedSettings(structuredClone(committed));

    expect(received).toHaveLength(1);
  });

  it('reapplies views when the shared skin changes', () => {
    const received: PianistSettings[] = [];
    const bridge = new PianistViewSettingsBridge(documentWith([view(received)]));
    bridge.setCommittedSettings(settings());
    bridge.setCommittedSettings(settings({ skin: 'seaside-glass' }));
    expect(received).toHaveLength(2);
    expect(received[1]?.skin).toBe('seaside-glass');
  });
});
