import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandler, ConnectionRpcHandlerOptions } from '@deepseek-ai/dsh-client-connection';
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver';
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, apply } from '../src/host/index.js';
import { PIANIST_PACKAGE_NAME, PIANIST_PACKAGE_VERSION } from '../src/host/package-meta.js';
import { DEFAULT_PIANIST_SETTINGS, PIANIST_SETTINGS_NS } from '../src/shared/pianist-settings.js';
import { SALAMANDER_SAMPLE_ROUTE } from '../src/shared/salamander-samples.js';
import { PIANIST_SETTINGS_RPC, PIANIST_SETTINGS_RPC_CHANNEL } from '../src/shared/settings-api.js';
import type { PianoToolResult } from '../src/shared/piano-tool.js';

class MemorySettings extends SettingsProvider {
  static initial: Record<string, unknown> = {};
  static writableFlag = true;
  private readonly writableValue = MemorySettings.writableFlag;

  get writable(): boolean {
    return this.writableValue;
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(MemorySettings.initial));
  }

  protected persist(_namespace: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve();
  }
}

interface RpcRegistration {
  channel: string;
  handler: ConnectionRpcHandler;
  options: ConnectionRpcHandlerOptions;
}

const profiles = new Set<string>();

afterEach(() => {
  for (const profile of profiles) {
    rmSync(profile, { recursive: true, force: true });
  }
  profiles.clear();
});

function profileDir(): string {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-pianist-profile-'));
  profiles.add(profile);
  return profile;
}

function profileBaseUrl(specifier: string, bundled = true): string {
  const profile = profileDir();
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-pianist-test-profile',
    private: true,
    dependencies: { [PIANIST_PACKAGE_NAME]: specifier },
    dsh: { profile: { bundles: bundled ? [PIANIST_PACKAGE_NAME] : [] } },
  }), 'utf8');
  return `${pathToFileURL(profile).href}/`;
}

async function mountHost(options: {
  baseUrl: string;
  initial?: Record<string, unknown>;
  writable?: boolean;
}): Promise<{
  ctx: Context;
  fiber: ReturnType<Context['plugin']>;
  registration: RpcRegistration;
  routes: WebRoute[];
}> {
  const ctx = new Context();
  ctx.baseUrl = options.baseUrl;
  const routes: WebRoute[] = [];
  ctx.provide('webServer', {
    register(route: WebRoute) {
      routes.push(route);
      return () => { routes.splice(routes.indexOf(route), 1); };
    },
  } as WebServer);
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, {}).await();
  let registration: RpcRegistration | undefined;
  ctx.provide('connection', {
    rpc: {
      handle(channel: string, handler: ConnectionRpcHandler, rpcOptions: ConnectionRpcHandlerOptions): () => Promise<void> {
        registration = { channel, handler, options: rpcOptions };
        return async () => {};
      },
    },
  } as never);

  const previousInitial = MemorySettings.initial;
  const previousWritable = MemorySettings.writableFlag;
  MemorySettings.initial = options.initial ?? {};
  MemorySettings.writableFlag = options.writable ?? true;
  try {
    await ctx.plugin(MemorySettings).await();
  } finally {
    MemorySettings.initial = previousInitial;
    MemorySettings.writableFlag = previousWritable;
  }

  const fiber = ctx.plugin({ apply, Config });
  await fiber.await();
  // Cordis starts dependency-injected child fibers on the next scheduler turn.
  // Let the tools registration settle before inspecting the composed catalog.
  await new Promise<void>(resolve => { setImmediate(resolve); });
  if (registration === undefined) throw new Error('dsh-pianist RPC was not registered');
  return { ctx, fiber, registration, routes };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('dsh-pianist Host settings RPC', () => {
  it('registers and disposes the bundled sample route through the DSH WebServer lifecycle', async () => {
    const mounted = await mountHost({ baseUrl: profileBaseUrl('^0.1.0') });

    expect(mounted.routes).toEqual([
      expect.objectContaining({ kind: 'prefix', path: SALAMANDER_SAMPLE_ROUTE }),
    ]);
    expect(mounted.routes[0]?.handler).toBeTypeOf('function');

    await mounted.fiber.dispose();
    expect(mounted.routes).toHaveLength(0);
  });

  it('registers piano_perform in the model-visible Harness tool catalog', async () => {
    const mounted = await mountHost({ baseUrl: profileBaseUrl('^0.1.0') });

    const assembly = await mounted.ctx.systemPrompt.assemble({});
    expect(assembly.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'piano_perform',
        description: expect.stringContaining('Render and play a piano performance'),
      }),
    ]));
    expect(assembly.sections.find(section => section.name === 'tool:piano-perform')?.text)
      .toContain('quarter=1, eighth=1/2');

    await mounted.fiber.dispose();
  });

  it('keeps a Code Mode performance available through the loopback reader', async () => {
    const mounted = await mountHost({ baseUrl: profileBaseUrl('^0.1.0') });
    const tool = mounted.ctx.tools.get('piano_perform');
    if (tool === undefined) throw new Error('piano_perform was not registered');
    const value = await tool.execute({
      title: 'RPC recovery',
      bpm: 120,
      notes: [{ pitches: ['C4'], startBeat: 0, durationBeats: 1 }],
      autoplay: false,
    }, {
      callId: 'code-rpc-1',
      name: 'piano_perform',
      arguments: {},
      agent: {},
      token: {},
      signal: signal(),
    } as never) as PianoToolResult;
    expect(value.performanceId).toMatch(/^piano-[0-9a-f-]{36}$/);

    const recovered = await mounted.registration.handler(PIANIST_SETTINGS_RPC.performanceRead, {
      performanceId: value.performanceId,
    }, signal());
    expect(recovered).toMatchObject({ ok: true, value: { performanceId: value.performanceId, title: 'RPC recovery' } });
    const missing = await mounted.registration.handler(PIANIST_SETTINGS_RPC.performanceRead, {
      performanceId: 'piano-expired',
    }, signal());
    expect(missing).toMatchObject({ ok: false, error: { message: 'piano performance is no longer available' } });
    await mounted.fiber.dispose();
  });

  it('loads the package root in Node for the Cordis Host entry', async () => {
    const entry = await import('../src/index.js');
    expect(entry.apply).toBe(apply);
    expect(entry).not.toHaveProperty('createInMemoryPianistHost');
    expect(entry).not.toHaveProperty('mountPianoSettingsCard');
  });

  it('serves a narrow loopback-only view and deep-merges a sparse browser mutation', async () => {
    const mounted = await mountHost({ baseUrl: profileBaseUrl('^0.1.0') });
    const { ctx, fiber, registration } = mounted;

    expect(registration).toMatchObject({
      channel: PIANIST_SETTINGS_RPC_CHANNEL,
      options: { authority: 'loopback' },
    });
    const initial = await registration.handler(PIANIST_SETTINGS_RPC.read, {}, signal());
    expect(initial).toMatchObject({
      ok: true,
      value: {
        version: PIANIST_PACKAGE_VERSION,
        installation: 'registry',
        writable: true,
        canUpgrade: true,
        settings: DEFAULT_PIANIST_SETTINGS,
      },
    });

    const updated = await registration.handler(PIANIST_SETTINGS_RPC.write, {
      volume: 0.31,
      events: { notes: false },
    }, signal());
    expect(updated).toMatchObject({
      ok: true,
      value: {
        settings: {
          volume: 0.31,
          events: { notes: false, pedal: true, tempo: true, particles: false },
        },
      },
    });
    expect(ctx.settings.get(settingsNamespace(PIANIST_SETTINGS_NS))).toEqual({
      ...DEFAULT_PIANIST_SETTINGS,
      volume: 0.31,
      events: { ...DEFAULT_PIANIST_SETTINGS.events, notes: false },
    });

    const rejected = await registration.handler(PIANIST_SETTINGS_RPC.write, {
      events: { notes: false, futureSetting: true },
    }, signal());
    expect(rejected).toMatchObject({ ok: false, error: { code: 'settings-rejected' } });
    await fiber.dispose();
  });

  it('keeps the card readable but rejects mutations when the profile is read-only', async () => {
    const mounted = await mountHost({ baseUrl: profileBaseUrl('^0.1.0'), writable: false });
    const { ctx, fiber, registration } = mounted;

    const initial = await registration.handler(PIANIST_SETTINGS_RPC.read, {}, signal());
    expect(initial).toMatchObject({ ok: true, value: { writable: false } });

    const rejected = await registration.handler(PIANIST_SETTINGS_RPC.write, { volume: 0.4 }, signal());
    expect(rejected).toMatchObject({ ok: false, error: { code: 'settings-rejected' } });
    expect(ctx.settings.get(settingsNamespace(PIANIST_SETTINGS_NS))).toEqual(DEFAULT_PIANIST_SETTINGS);
    await fiber.dispose();
  });

  it('normalizes a partial legacy section before exposing it to the browser', async () => {
    const mounted = await mountHost({
      baseUrl: profileBaseUrl('^0.1.0'),
      initial: { [PIANIST_SETTINGS_NS]: { version: 1, volume: 0.25 } },
    });
    const { fiber, registration } = mounted;

    const result = await registration.handler(PIANIST_SETTINGS_RPC.read, {}, signal());
    expect(result).toMatchObject({
      ok: true,
      value: {
        settings: { ...DEFAULT_PIANIST_SETTINGS, volume: 0.25 },
      },
    });
    await fiber.dispose();
  });

  it('refuses an update request for a development profile dependency', async () => {
    const mounted = await mountHost({ baseUrl: profileBaseUrl('link:../dsh-pianist') });
    const { fiber, registration } = mounted;

    const result = await registration.handler(PIANIST_SETTINGS_RPC.upgrade, {}, signal());
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
    await fiber.dispose();
  });

  it('shows an exact registry pin but leaves its update action disabled', async () => {
    const mounted = await mountHost({ baseUrl: profileBaseUrl('1.2.3') });
    const { fiber, registration } = mounted;

    const result = await registration.handler(PIANIST_SETTINGS_RPC.read, {}, signal());
    expect(result).toMatchObject({ ok: true, value: { installation: 'registry', canUpgrade: false } });
    const rejected = await registration.handler(PIANIST_SETTINGS_RPC.upgrade, {}, signal());
    expect(rejected).toMatchObject({ ok: false, error: { code: 'internal' } });
    await fiber.dispose();
  });
});
