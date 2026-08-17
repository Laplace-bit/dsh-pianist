import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import {
  DEFAULT_PIANIST_SETTINGS,
  mergePianistSettings,
  type PianistSettings,
  type PianistSettingsPatch,
} from '../shared/pianist-settings.js';
import type { PianistInstallationKind, PianistSettingsView } from '../shared/settings-api.js';
import type { PianistSettingsApi } from './pianist-settings-api.js';

export interface PianistCardState {
  status: 'loading' | 'ready' | 'unavailable';
  writable: boolean;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  failed: boolean;
  settings: PianistSettings;
  version: string | undefined;
  installation: PianistInstallationKind;
  canUpgrade: boolean;
  upgrading: boolean;
  upgradeFailed: boolean;
  restartRequired: boolean;
  repairRequired: boolean;
}

export interface PianistCardFace {
  hooks: {
    pianistSettingsCard: SnapshotStore<PianistCardState>;
  };
  edit: (patch: PianistSettingsPatch) => void;
  save: () => void;
  discard: () => void;
  reload: () => void;
  upgrade: () => void;
}

function mergePatches(current: PianistSettingsPatch, patch: PianistSettingsPatch): PianistSettingsPatch {
  return {
    ...current,
    ...patch,
    ...(current.events !== undefined || patch.events !== undefined
      ? { events: { ...current.events, ...patch.events } }
      : {}),
  };
}

/** Staged form controller; only changed fields cross the Host boundary. */
export class PianistCardController {
  private readonly store: SnapshotStore<PianistCardState>;
  private loaded: PianistSettingsView | undefined;
  private staged: PianistSettingsPatch | undefined;
  private saving = false;
  private saved = false;
  private failed = false;
  private upgrading = false;
  private upgradeFailed = false;
  private restartRequired = false;
  private repairRequired = false;
  private loadGeneration = 0;
  private loadStatus: PianistCardState['status'] = 'loading';

  constructor(private readonly api: PianistSettingsApi) {
    this.store = createSnapshotStore<PianistCardState>(this.projection());
  }

  start(): void { void this.load(); }

  stop(): void { this.loadGeneration += 1; }

  getSnapshot(): PianistCardState { return this.store.getSnapshot(); }

  subscribe(listener: () => void): () => void { return this.store.subscribe(listener); }

  inject(): PianistCardFace {
    return {
      hooks: { pianistSettingsCard: this.store },
      edit: (patch) => {
        this.staged = mergePatches(this.staged ?? {}, patch);
        this.saved = false;
        this.failed = false;
        this.publish();
      },
      save: () => { void this.save(); },
      discard: () => {
        if (this.staged === undefined && !this.failed && !this.saved) return;
        this.staged = undefined;
        this.failed = false;
        this.saved = false;
        this.publish();
      },
      reload: () => { void this.load(); },
      upgrade: () => { void this.upgrade(); },
    };
  }

  private formSettings(): PianistSettings {
    const base = this.loaded?.settings ?? DEFAULT_PIANIST_SETTINGS;
    return this.staged === undefined ? structuredClone(base) : mergePianistSettings(base, this.staged);
  }

  private projection(): PianistCardState {
    return {
      status: this.loadStatus,
      writable: this.loaded?.writable ?? false,
      dirty: this.staged !== undefined,
      saving: this.saving,
      saved: this.saved,
      failed: this.failed,
      settings: this.formSettings(),
      version: this.loaded?.version,
      installation: this.loaded?.installation ?? 'unmanaged',
      canUpgrade: this.loaded?.canUpgrade ?? false,
      upgrading: this.upgrading,
      upgradeFailed: this.upgradeFailed,
      restartRequired: this.restartRequired,
      repairRequired: this.repairRequired,
    };
  }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loadStatus = 'loading';
    this.publish();
    try {
      const view = await this.api.read();
      if (generation !== this.loadGeneration) return;
      this.loaded = view;
      this.loadStatus = 'ready';
    } catch {
      if (generation !== this.loadGeneration) return;
      this.loadStatus = 'unavailable';
    }
    this.publish();
  }

  private async save(): Promise<void> {
    const patch = this.staged;
    if (patch === undefined || this.saving || this.loaded?.writable !== true) return;
    this.saving = true;
    this.saved = false;
    this.failed = false;
    this.publish();
    try {
      this.loaded = await this.api.write(patch);
      this.staged = undefined;
      this.saved = true;
    } catch {
      this.failed = true;
    }
    this.saving = false;
    this.publish();
  }

  private async upgrade(): Promise<void> {
    if (this.loaded?.canUpgrade !== true || this.upgrading || this.restartRequired) return;
    this.upgrading = true;
    this.upgradeFailed = false;
    this.repairRequired = false;
    this.publish();
    try {
      const result = await this.api.upgrade();
      this.restartRequired = result.restartRequired;
      this.repairRequired = result.repairRequired;
    } catch {
      this.upgradeFailed = true;
    }
    this.upgrading = false;
    this.publish();
  }

  private publish(): void { this.store.set(this.projection()); }
}
