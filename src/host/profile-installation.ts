/** Trusted active-profile inspection plus the fixed, serialized npm update path. */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RegistryProfileInstallation {
  kind: 'registry';
  profileDir: string;
  profileName: string;
  updatePolicy: RegistryProfileUpdatePolicy;
}

export interface DevelopmentProfileInstallation {
  kind: 'development';
}

export interface UnmanagedProfileInstallation {
  kind: 'unmanaged';
}

export type ProfileInstallation = RegistryProfileInstallation | DevelopmentProfileInstallation | UnmanagedProfileInstallation;

/** A profile pin is deliberately not widened by a one-click update. */
export type RegistryProfileUpdatePolicy = 'preserve-spec' | 'pinned';

interface ProfileManifest {
  dependencies?: unknown;
  dsh?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function profileDirectory(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'file:' ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

function readProfileManifest(profileDir: string): ProfileManifest {
  const value = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as unknown;
  if (record(value) === undefined) throw new Error(`dsh-pianist: profile manifest at ${profileDir} must be an object`);
  return value as ProfileManifest;
}

function hasBundle(manifest: ProfileManifest, packageName: string): boolean {
  const dsh = record(manifest.dsh);
  const profile = record(dsh?.profile);
  return Array.isArray(profile?.bundles) && profile.bundles.includes(packageName);
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('link:')
    || specifier.startsWith('file:')
    || specifier.startsWith('.')
    || isAbsolute(specifier)
    || /^[A-Za-z]:[\\/]/.test(specifier);
}

function isRegistryVersionSpecifier(specifier: string): boolean {
  return specifier.length > 0 && !specifier.includes(':') && !/[\\/]/.test(specifier);
}

function npmAliasTarget(specifier: string): { packageName: string; version: string | undefined } | undefined {
  const value = specifier.slice('npm:'.length);
  if (value.length === 0) return undefined;
  const separator = value.startsWith('@')
    ? value.indexOf('@', value.indexOf('/') + 1)
    : value.indexOf('@');
  const packageName = separator === -1 ? value : value.slice(0, separator);
  const version = separator === -1 ? undefined : value.slice(separator + 1);
  const packageNameValid = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName);
  if (!packageNameValid || (version !== undefined && !isRegistryVersionSpecifier(version))) return undefined;
  return { packageName, version };
}

function isRegistrySpecifier(specifier: string): boolean {
  if (isLocalSpecifier(specifier)) return false;
  if (!specifier.startsWith('npm:')) return isRegistryVersionSpecifier(specifier);
  return npmAliasTarget(specifier) !== undefined;
}

function isExactRegistryVersion(specifier: string): boolean {
  return /^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(specifier);
}

/**
 * Decide update eligibility from the trusted manifest declaration. Ranges,
 * tags, and aliases can be refreshed without changing their declaration; an
 * exact pin cannot, so it remains registry-installed but non-updateable.
 */
export function registryProfileUpdatePolicy(specifier: string): RegistryProfileUpdatePolicy | undefined {
  if (!isRegistrySpecifier(specifier)) return undefined;
  const alias = specifier.startsWith('npm:') ? npmAliasTarget(specifier) : undefined;
  const target = alias?.version ?? (alias === undefined ? specifier : undefined);
  return target !== undefined && isExactRegistryVersion(target) ? 'pinned' : 'preserve-spec';
}

/** Whether this trusted installation can be refreshed without widening its spec. */
export function canUpdateProfileInstallation(
  installation: ProfileInstallation,
): installation is RegistryProfileInstallation & { updatePolicy: 'preserve-spec' } {
  return installation.kind === 'registry' && installation.updatePolicy === 'preserve-spec';
}

/** Inspect package ownership from trusted Host context; browser input is never involved. */
export function inspectProfileInstallation(baseUrl: string | undefined, packageName: string): ProfileInstallation {
  const profileDir = profileDirectory(baseUrl);
  if (profileDir === undefined) return { kind: 'unmanaged' };
  let manifest: ProfileManifest;
  try {
    manifest = readProfileManifest(profileDir);
  } catch {
    return { kind: 'unmanaged' };
  }
  const dependencies = record(manifest.dependencies);
  const specifier = dependencies?.[packageName];
  if (typeof specifier !== 'string' || !hasBundle(manifest, packageName)) return { kind: 'unmanaged' };
  if (isLocalSpecifier(specifier)) return { kind: 'development' };
  const updatePolicy = registryProfileUpdatePolicy(specifier);
  if (updatePolicy === undefined) return { kind: 'unmanaged' };
  return { kind: 'registry', profileDir, profileName: basename(profileDir), updatePolicy };
}

function packageExportsBundle(profileDir: string, packageName: string): boolean {
  const anchor = join(profileDir, 'package.json');
  const require = createRequire(anchor);
  const paths = require.resolve.paths(packageName) ?? [];
  for (const searchPath of paths) {
    const manifestPath = join(searchPath, packageName, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = record(JSON.parse(readFileSync(manifestPath, 'utf8')));
      const dsh = record(manifest?.dsh);
      return record(dsh?.bundle)?.patch !== undefined;
    } catch {
      return false;
    }
  }
  return false;
}

function reconcileProfileBundles(profileDir: string, before: ProfileManifest): void {
  const after = readProfileManifest(profileDir);
  const beforeDependencies = new Set(Object.keys(record(before.dependencies) ?? {}));
  const dependencyNames = Object.keys(record(after.dependencies) ?? {});
  const dependencySet = new Set(dependencyNames);
  const dsh = record(after.dsh);
  const profile = record(dsh?.profile);
  const bundles = Array.isArray(profile?.bundles)
    ? profile.bundles.filter((value): value is string => typeof value === 'string')
    : [];
  let changed = false;

  for (const packageName of dependencyNames) {
    if (packageExportsBundle(profileDir, packageName) && !bundles.includes(packageName)) {
      bundles.push(packageName);
      changed = true;
    }
  }
  for (const packageName of [...bundles]) {
    const wasManagedDependency = beforeDependencies.has(packageName) || dependencySet.has(packageName);
    const remainsBundle = dependencySet.has(packageName) && packageExportsBundle(profileDir, packageName);
    if (wasManagedDependency && !remainsBundle) {
      bundles.splice(bundles.indexOf(packageName), 1);
      changed = true;
    }
  }
  if (!changed) return;
  after.dsh = { ...dsh, profile: { ...profile, bundles } };
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(after, undefined, 2)}\n`);
}

/** Indicates that pnpm changed the profile but the follow-up bundle repair did not complete. */
export class ProfileBundleReconciliationError extends Error {
  constructor(cause: unknown) {
    super('dsh-pianist: package update completed but plugin-bundle reconciliation failed', { cause });
    this.name = 'ProfileBundleReconciliationError';
  }
}

/** Thrown before the package manager runs when a user-owned exact pin is encountered. */
export class ProfileUpdateNotAllowedError extends Error {
  constructor(packageName: string) {
    super(`dsh-pianist: ${packageName} is pinned and cannot be auto-updated`);
    this.name = 'ProfileUpdateNotAllowedError';
  }
}

/** Fixed command hook, injectable in tests without modifying a real profile. */
export type ProfilePackageUpdater = (profileDir: string, packageName: string) => Promise<void>;

/**
 * Let pnpm refresh the resolved package only. `--no-save` preserves the exact
 * profile declaration (range, tag, or alias) and `--prod` confines the action
 * to the profile dependency rather than unrelated development dependencies.
 */
export function pnpmProfileUpdateArguments(packageName: string): readonly string[] {
  return Object.freeze(['update', '--prod', '--no-save', packageName]);
}

function runPnpmUpdate(profileDir: string, packageName: string): Promise<void> {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return new Promise((resolve, reject) => {
    const child = spawn(command, pnpmProfileUpdateArguments(packageName), {
      cwd: profileDir,
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`dsh-pianist: pnpm update failed (${signal ?? String(code)})`));
    });
  });
}

/** Run the trusted package-manager operation, then mirror DSH's profile reconciliation. */
export async function updateRegistryProfilePackage(
  profileDir: string,
  packageName: string,
  update: ProfilePackageUpdater = runPnpmUpdate,
): Promise<void> {
  const before = readProfileManifest(profileDir);
  const specifier = record(before.dependencies)?.[packageName];
  if (typeof specifier !== 'string' || registryProfileUpdatePolicy(specifier) !== 'preserve-spec') {
    throw new ProfileUpdateNotAllowedError(packageName);
  }
  await update(profileDir, packageName);
  try {
    reconcileProfileBundles(profileDir, before);
  } catch (error) {
    throw new ProfileBundleReconciliationError(error);
  }
}

export class ProfileUpdateInProgressError extends Error {
  constructor() {
    super('dsh-pianist update is already running for this profile');
    this.name = 'ProfileUpdateInProgressError';
  }
}

/** Serialize package mutation per trusted profile directory. */
export class ProfileUpdateCoordinator {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly update: ProfilePackageUpdater = updateRegistryProfilePackage) {}

  async run(profileDir: string, packageName: string): Promise<void> {
    if (this.pending.has(profileDir)) throw new ProfileUpdateInProgressError();
    const task = Promise.resolve().then(() => this.update(profileDir, packageName));
    this.pending.set(profileDir, task);
    try {
      await task;
    } finally {
      if (this.pending.get(profileDir) === task) this.pending.delete(profileDir);
    }
  }
}
