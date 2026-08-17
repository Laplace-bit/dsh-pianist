import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { isPianistSettings, type PianistSettingsPatch } from '../shared/pianist-settings.js';
import {
  PIANIST_SETTINGS_RPC,
  PIANIST_SETTINGS_RPC_CHANNEL,
  type PianistSettingsView,
  type PianistUpgradeView,
} from '../shared/settings-api.js';
import { parsePianoToolResult, type PianoToolResult } from '../shared/piano-tool.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function settingsView(value: unknown): PianistSettingsView {
  const data = record(value);
  if (data === undefined
    || typeof data.version !== 'string'
    || !['registry', 'development', 'unmanaged'].includes(data.installation as string)
    || typeof data.writable !== 'boolean'
    || typeof data.canUpgrade !== 'boolean'
    || !isPianistSettings(data.settings)) {
    throw new Error('dsh-pianist: malformed settings response');
  }
  return data as unknown as PianistSettingsView;
}

function upgradeView(value: unknown): PianistUpgradeView {
  const data = record(value);
  if (data === undefined || typeof data.restartRequired !== 'boolean' || typeof data.repairRequired !== 'boolean') {
    throw new Error('dsh-pianist: malformed update response');
  }
  return { restartRequired: data.restartRequired, repairRequired: data.repairRequired };
}

function accepted(result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>): unknown {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Narrow client facade over the plugin-owned loopback RPC. */
export interface PianistSettingsApi {
  read(): Promise<PianistSettingsView>;
  write(patch: PianistSettingsPatch): Promise<PianistSettingsView>;
  upgrade(): Promise<PianistUpgradeView>;
}

/** Narrow reader used only by the Code Mode tool-view fallback. */
export interface PianoPerformanceApi {
  read(performanceId: string): Promise<PianoToolResult | undefined>;
}

export function createPianistSettingsApi(connection: ConnectionHandle): PianistSettingsApi {
  return {
    async read(): Promise<PianistSettingsView> {
      return settingsView(accepted(await connection.rpc.call(PIANIST_SETTINGS_RPC_CHANNEL, PIANIST_SETTINGS_RPC.read, {})));
    },
    async write(patch: PianistSettingsPatch): Promise<PianistSettingsView> {
      return settingsView(accepted(await connection.rpc.call(PIANIST_SETTINGS_RPC_CHANNEL, PIANIST_SETTINGS_RPC.write, patch)));
    },
    async upgrade(): Promise<PianistUpgradeView> {
      return upgradeView(accepted(await connection.rpc.call(PIANIST_SETTINGS_RPC_CHANNEL, PIANIST_SETTINGS_RPC.upgrade, {})));
    },
  };
}

export function createPianoPerformanceApi(connection: ConnectionHandle): PianoPerformanceApi {
  return {
    async read(performanceId: string): Promise<PianoToolResult | undefined> {
      const result = await connection.rpc.call(
        PIANIST_SETTINGS_RPC_CHANNEL,
        PIANIST_SETTINGS_RPC.performanceRead,
        { performanceId },
      );
      if (!result.ok) return undefined;
      const performance = parsePianoToolResult(result.value);
      return performance?.performanceId === performanceId ? performance : undefined;
    },
  };
}
