import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PianistCardFace } from '../src/client/pianist-card-controller.js';
import { DEFAULT_PIANIST_SETTINGS } from '../src/shared/pianist-settings.js';
import { PIANIST_SETTINGS_RPC, PIANIST_SETTINGS_RPC_CHANNEL } from '../src/shared/settings-api.js';

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore<T>(initial: T) {
    let snapshot = initial;
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      set(next: T) {
        snapshot = next;
        for (const listener of listeners) listener();
      },
    };
  },
}));

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
  IconRefreshOutline14: () => null,
}));

interface RegisteredCard {
  options: {
    name?: string;
    key?: string;
    id?: string;
    order?: number;
    locale?: string;
    inject?: () => unknown;
  };
}

interface FakeContext {
  inject(_dependencies: readonly string[], callback: (ctx: FakeContext) => (() => void) | void): void;
  get(name: 'connection'): { rpc: { call: ReturnType<typeof vi.fn> } };
  effect(callback: () => (() => void) | void): void;
  slots: {
    inject(slot: string, callback: () => unknown): unknown;
    register(options: RegisteredCard['options'], component: unknown): () => void;
    entries(slot: string): RegisteredCard[];
  };
  locale: { register(namespace: string, dictionaries: unknown): void };
}

interface Bench {
  cards: RegisteredCard[];
  toolViews: RegisteredCard[];
  context: FakeContext;
  rpcCall: ReturnType<typeof vi.fn>;
}

function bench(response: () => Promise<unknown>): Bench {
  const cards: RegisteredCard[] = [];
  const toolViews: RegisteredCard[] = [];
  const rpcCall = vi.fn(response);
  const effects: Array<() => void> = [];
  const context: FakeContext = {
    inject(_dependencies, callback) {
      const dispose = callback(context);
      if (dispose !== undefined) effects.push(dispose);
    },
    get() {
      return { rpc: { call: rpcCall } };
    },
    effect(callback) {
      const dispose = callback();
      if (dispose !== undefined) effects.push(dispose);
    },
    slots: {
      inject: vi.fn((_slot: string, callback: () => unknown) => callback()),
      register: vi.fn((options: RegisteredCard['options']) => {
        const entry = { options };
        const target = options.name === 'tool.call.toolview' ? toolViews : cards;
        target.push(entry);
        return () => {
          const index = target.indexOf(entry);
          if (index >= 0) target.splice(index, 1);
        };
      }),
      entries: vi.fn((slot: string) => slot === 'settings.plugin.item' ? cards : []),
    },
    locale: { register: vi.fn() },
  };
  return { cards, toolViews, context, rpcCall };
}

beforeEach(() => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', {
    documentElement: {},
    querySelectorAll: () => [],
  });
  vi.stubGlobal('customElements', {
    define: vi.fn(),
    get: vi.fn(() => undefined),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dsh-pianist browser integration', () => {
  it('registers its settings card through the dedicated RPC without settings.describe', async () => {
    const client = await import('../src/client/index.js');
    const state = {
      version: '0.1.0',
      installation: 'development',
      writable: true,
      settings: DEFAULT_PIANIST_SETTINGS,
      canUpgrade: false,
    };
    const mounted = bench(async () => ({ ok: true, value: state }));

    client.apply(mounted.context as never);

    await vi.waitFor(() => {
      expect(mounted.cards).toHaveLength(1);
      expect(mounted.rpcCall).toHaveBeenCalledWith(
        PIANIST_SETTINGS_RPC_CHANNEL,
        PIANIST_SETTINGS_RPC.read,
        {},
      );
      const face = mounted.cards[0]!.options.inject!() as PianistCardFace;
      expect(face.hooks.pianistSettingsCard.getSnapshot().status).toBe('ready');
    });

    expect(mounted.context.slots.inject).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function));
    expect(mounted.context.slots.inject).toHaveBeenCalledWith('tool.call.toolview', expect.any(Function));
    expect(mounted.toolViews).toHaveLength(1);
    expect(mounted.toolViews[0]!.options).toMatchObject({ key: 'piano_perform', locale: 'settings.pianist' });
    expect(mounted.cards[0]!.options).toMatchObject({ id: 'pianist', order: 50, locale: 'settings.pianist' });
    const face = mounted.cards[0]!.options.inject!() as PianistCardFace;
    expect(face.hooks.pianistSettingsCard.getSnapshot()).toMatchObject({
      status: 'ready',
      settings: DEFAULT_PIANIST_SETTINGS,
    });
  });

  it('keeps the card registered and exposes a retryable unavailable state when its RPC fails', async () => {
    const client = await import('../src/client/index.js');
    const mounted = bench(async () => {
      throw new Error('connection unavailable');
    });

    client.apply(mounted.context as never);

    await vi.waitFor(() => {
      expect(mounted.cards).toHaveLength(1);
      const face = mounted.cards[0]!.options.inject!() as PianistCardFace;
      expect(face.hooks.pianistSettingsCard.getSnapshot().status).toBe('unavailable');
    });
  });
});
