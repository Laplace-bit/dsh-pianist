import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import Schema from '@deepseek-ai/schemastery';
import { PIANIST_PACKAGE_NAME, PIANIST_PACKAGE_VERSION } from './package-meta.js';
import {
  inspectProfileInstallation,
  canUpdateProfileInstallation,
  ProfileBundleReconciliationError,
  ProfileUpdateCoordinator,
  ProfileUpdateInProgressError,
} from './profile-installation.js';
import {
  DEFAULT_PIANIST_SETTINGS,
  normalizePianistSettings,
  parsePianistSettingsPatch,
  PIANIST_SETTINGS_NS,
  type PianistSettings,
} from '../shared/pianist-settings.js';
import {
  PIANIST_SETTINGS_RPC,
  PIANIST_SETTINGS_RPC_CHANNEL,
  type PianistSettingsView,
} from '../shared/settings-api.js';
import { createPianoPerformTool } from './piano-tool.js';
import { PianoPerformanceStore } from './performance-store.js';
import { createPianoSampleAssetHandler } from './sample-assets.js';
import { SALAMANDER_SAMPLE_ROUTE } from '../shared/salamander-samples.js';
import { PIANO_SKIN_COMPAT_IDS, PIANO_SKIN_IDS, type PianoSkinId } from '../visual/skin.js';

/** Display name used by the Cordis loader. */
export const name = 'dsh-pianist';

/** Profile composition defaults accepted by the Host plugin entry. */
export interface Config extends PianistSettings {}

/** Keep the Host schema in lockstep with the registry without duplicating ids. */
function skinSchema(): Schema<PianoSkinId> {
  return Schema.union([
    ...PIANO_SKIN_IDS.map(id => Schema.const(id)),
    ...PIANO_SKIN_COMPAT_IDS.map(id => Schema.const(id)),
  ]) as Schema<PianoSkinId>;
}

function settingsSchema(defaults: PianistSettings): Schema<PianistSettings> {
  return Schema.object({
    enabled: Schema.boolean().default(defaults.enabled),
    renderMode: Schema.union([Schema.const('immersive'), Schema.const('embedded')]).default(defaults.renderMode),
    skin: skinSchema().default(defaults.skin),
    returnToEmbeddedOnEnd: Schema.boolean().default(defaults.returnToEmbeddedOnEnd),
    visualQuality: Schema.union([Schema.const('low'), Schema.const('medium'), Schema.const('high')]).default(defaults.visualQuality),
    volume: Schema.number().min(0).max(1).default(defaults.volume),
    showWaterfall: Schema.boolean().default(defaults.showWaterfall),
    events: Schema.object({
      notes: Schema.boolean().default(defaults.events.notes),
      pedal: Schema.boolean().default(defaults.events.pedal),
      tempo: Schema.boolean().default(defaults.events.tempo),
      particles: Schema.boolean().default(defaults.events.particles),
    }),
  });
}

export const Config: Schema<Config> = settingsSchema(DEFAULT_PIANIST_SETTINGS);

const profileUpdates = new ProfileUpdateCoordinator();

/**
 * Production DSH Host entry. Settings remain profile-backed; the browser only
 * receives this plugin's small typed view through a loopback-only RPC channel.
 */
export function apply(ctx: Context, config: Config): void {
  const performances = new PianoPerformanceStore();
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createPianoSampleAssetHandler();
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: SALAMANDER_SAMPLE_ROUTE,
      handler,
    }), 'dsh-pianist: Salamander sample assets');
  });
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'tool:piano-perform',
      order: 115,
      text: [
        'When the user asks to hear, play, audition, or demonstrate piano music, transcribe the complete requested passage and call piano_perform once.',
        'Use zero-based absolute quarter-note beat positions: quarter=1, eighth=1/2, sixteenth=1/4, dotted values multiply by 3/2, and triplet eighth=1/3.',
        'For long passages minimize tool-call latency with compact notes {p,s,d,h,v}: p is one pitch or a chord array, s is startBeat, d is durationBeats, h is l/r, and v is velocity; omit h/v when using defaults.',
        'Use durationBeats for sounding length, combine tied notes, represent rests as gaps, simultaneous pitches as one chord group, and independent voices as overlapping groups.',
        'Put the initial tempo in bpm and later changes in tempoChanges; preserve meter, left/right hands, written dynamics or accents, and sustain spans when present.',
        'Scientific pitch uses C4=middle C (MIDI 60). Do not claim that a performance was prepared or played when the tool failed.',
      ].join(' '),
    });
  });
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(createPianoPerformTool({
      publish: result => { performances.set(result); },
    }));
  });

  ctx.inject(['settings'], (settingsCtx) => {
    // 0.1.2 kernels dropped the `settingsNamespace()` helper — a validating
    // identity on ≤ 0.1.1 — and take the raw string, so the brand is
    // reproduced locally instead of statically importing a removed symbol.
    // 'pianist' matches the kernel's /^[a-z][a-z0-9-]*$/ pattern.
    const settingsNamespace = PIANIST_SETTINGS_NS as SettingsNamespace;
    const scope = settingsCtx.settings.register(
      settingsNamespace,
      settingsSchema(normalizePianistSettings(config)),
      { applies: 'live' },
    );

    settingsCtx.inject(['connection'], (connectionCtx) => {
      const view = (): PianistSettingsView => {
        const installation = inspectProfileInstallation(connectionCtx.baseUrl, PIANIST_PACKAGE_NAME);
        return {
          version: PIANIST_PACKAGE_VERSION,
          installation: installation.kind,
          writable: connectionCtx.settings.writable,
          settings: normalizePianistSettings(scope.get()),
          canUpgrade: canUpdateProfileInstallation(installation),
        };
      };

      const handler: ConnectionRpcHandler = async (endpoint, payload) => {
        if (endpoint === PIANIST_SETTINGS_RPC.read) return { ok: true, value: view() };
        if (endpoint === PIANIST_SETTINGS_RPC.write) {
          const patch = parsePianistSettingsPatch(payload);
          if (patch === undefined) {
            return {
              ok: false,
              error: { code: 'settings-rejected', message: 'dsh-pianist settings are invalid', details: { ns: PIANIST_SETTINGS_NS } },
            };
          }
          if (!connectionCtx.settings.writable) {
            return {
              ok: false,
              error: { code: 'settings-rejected', message: 'dsh-pianist settings are read-only', details: { ns: PIANIST_SETTINGS_NS } },
            };
          }
          try {
            // SettingsProvider deep-merges this sparse patch, preserving fields
            // introduced by a newer Host or a concurrent browser card.
            await scope.update(patch);
          } catch {
            return {
              ok: false,
              error: { code: 'settings-rejected', message: 'dsh-pianist settings update failed', details: { ns: PIANIST_SETTINGS_NS } },
            };
          }
          return { ok: true, value: view() };
        }
        if (endpoint === PIANIST_SETTINGS_RPC.upgrade) {
          const installation = inspectProfileInstallation(connectionCtx.baseUrl, PIANIST_PACKAGE_NAME);
          if (!canUpdateProfileInstallation(installation)) {
            return { ok: false, error: { code: 'internal', message: 'dsh-pianist cannot be automatically updated in this profile', details: {} } };
          }
          try {
            await profileUpdates.run(installation.profileDir, PIANIST_PACKAGE_NAME);
            return { ok: true, value: { restartRequired: true, repairRequired: false } };
          } catch (error) {
            if (error instanceof ProfileBundleReconciliationError) {
              return { ok: true, value: { restartRequired: false, repairRequired: true } };
            }
            if (error instanceof ProfileUpdateInProgressError) {
              return { ok: false, error: { code: 'internal', message: error.message, details: {} } };
            }
            return { ok: false, error: { code: 'internal', message: 'dsh-pianist update failed', details: {} } };
          }
        }
        if (endpoint === PIANIST_SETTINGS_RPC.performanceRead) {
          const performanceId = typeof payload === 'object' && payload !== null
            ? (payload as { performanceId?: unknown }).performanceId
            : undefined;
          if (typeof performanceId !== 'string' || performanceId.trim() === '') {
            return { ok: false, error: { code: 'internal', message: 'performanceId is required', details: {} } };
          }
          const performance = performances.get(performanceId);
          if (performance === undefined) {
            return { ok: false, error: { code: 'internal', message: 'piano performance is no longer available', details: {} } };
          }
          return { ok: true, value: performance };
        }
        return {
          ok: false,
          error: { code: 'internal', message: `unknown dsh-pianist endpoint ${JSON.stringify(endpoint)}`, details: {} },
        };
      };

      connectionCtx.effect(
        () => connectionCtx.connection.rpc.handle(PIANIST_SETTINGS_RPC_CHANNEL, handler, { authority: 'loopback' }),
        'dsh-pianist: settings RPC',
      );
    });
  });
}
