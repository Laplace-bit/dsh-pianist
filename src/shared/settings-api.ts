import type { PianistSettings, PianistSettingsPatch } from './pianist-settings.js';

/** Dedicated, loopback-only RPC channel for this plugin's browser half. */
export const PIANIST_SETTINGS_RPC_CHANNEL = '/dsh-pianist';

export const PIANIST_SETTINGS_RPC = {
  read: 'settings.read',
  write: 'settings.write',
  upgrade: 'plugin.upgrade',
  performanceRead: 'performance.read',
} as const;

/** How the active profile supplied the currently running package. */
export type PianistInstallationKind = 'registry' | 'development' | 'unmanaged';

/** Minimal state the Host allows the browser card to observe. */
export interface PianistSettingsView {
  version: string;
  installation: PianistInstallationKind;
  writable: boolean;
  settings: PianistSettings;
  canUpgrade: boolean;
}

/** Outcome of the fixed package update operation. */
export interface PianistUpgradeView {
  restartRequired: boolean;
  /** Package installation succeeded, but bundle reconciliation must be retried. */
  repairRequired: boolean;
}

/** Browser mutations remain sparse so an older card cannot erase newer settings fields. */
export type { PianistSettingsPatch };
