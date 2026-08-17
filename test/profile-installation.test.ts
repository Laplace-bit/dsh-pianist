import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIANIST_PACKAGE_NAME, PIANIST_PACKAGE_VERSION } from '../src/host/package-meta.js';
import {
  inspectProfileInstallation,
  ProfileUpdateNotAllowedError,
  ProfileBundleReconciliationError,
  ProfileUpdateCoordinator,
  ProfileUpdateInProgressError,
  updateRegistryProfilePackage,
  registryProfileUpdatePolicy,
  pnpmProfileUpdateArguments,
} from '../src/host/profile-installation.js';

const profiles = new Set<string>();
const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

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
  writeProfileManifest(profile, { [PIANIST_PACKAGE_NAME]: specifier }, bundled ? [PIANIST_PACKAGE_NAME] : []);
  return `${pathToFileURL(profile).href}/`;
}

function writeProfileManifest(profile: string, dependencies: Record<string, string>, bundles: string[]): void {
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-pianist-test-profile',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }), 'utf8');
}

function writeInstalledManifest(profile: string, packageName: string, manifest: object): void {
  const packageDir = join(profile, 'node_modules', packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest), 'utf8');
}

describe('dsh-pianist profile installation policy', () => {
  it('uses package metadata for its trusted dependency identity', () => {
    expect(PIANIST_PACKAGE_NAME).toBe(packageManifest.name);
    expect(PIANIST_PACKAGE_VERSION).toBe(packageManifest.version);
  });

  it('classifies trusted active-profile specs conservatively', () => {
    expect(inspectProfileInstallation(profileBaseUrl('^0.1.0'), PIANIST_PACKAGE_NAME)).toMatchObject({ kind: 'registry', updatePolicy: 'preserve-spec' });
    expect(inspectProfileInstallation(profileBaseUrl('1.2.3'), PIANIST_PACKAGE_NAME)).toMatchObject({ kind: 'registry', updatePolicy: 'pinned' });
    expect(inspectProfileInstallation(profileBaseUrl('npm:@pianos/recorded@next'), PIANIST_PACKAGE_NAME)).toMatchObject({ kind: 'registry', updatePolicy: 'preserve-spec' });
    expect(inspectProfileInstallation(profileBaseUrl('npm:@pianos/recorded@1.2.3'), PIANIST_PACKAGE_NAME)).toMatchObject({ kind: 'registry', updatePolicy: 'pinned' });
    expect(inspectProfileInstallation(profileBaseUrl('link:../dsh-pianist'), PIANIST_PACKAGE_NAME)).toEqual({ kind: 'development' });
    expect(inspectProfileInstallation(profileBaseUrl('file:../dsh-pianist'), PIANIST_PACKAGE_NAME)).toEqual({ kind: 'development' });
    expect(inspectProfileInstallation(profileBaseUrl('workspace:*'), PIANIST_PACKAGE_NAME)).toEqual({ kind: 'unmanaged' });
    expect(inspectProfileInstallation(profileBaseUrl('catalog:pianist'), PIANIST_PACKAGE_NAME)).toEqual({ kind: 'unmanaged' });
    expect(inspectProfileInstallation(profileBaseUrl('^0.1.0', false), PIANIST_PACKAGE_NAME)).toEqual({ kind: 'unmanaged' });
  });

  it('keeps range, tag, and alias declarations stable while excluding exact pins', () => {
    expect(registryProfileUpdatePolicy('^0.1.0')).toBe('preserve-spec');
    expect(registryProfileUpdatePolicy('next')).toBe('preserve-spec');
    expect(registryProfileUpdatePolicy('npm:@pianos/recorded@next')).toBe('preserve-spec');
    expect(registryProfileUpdatePolicy('1.2.3')).toBe('pinned');
    expect(registryProfileUpdatePolicy('=1.2.3')).toBe('pinned');
    expect(registryProfileUpdatePolicy('npm:@pianos/recorded@1.2.3')).toBe('pinned');
    expect(registryProfileUpdatePolicy('link:../piano')).toBeUndefined();
    expect(pnpmProfileUpdateArguments(PIANIST_PACKAGE_NAME)).toEqual([
      'update', '--prod', '--no-save', PIANIST_PACKAGE_NAME,
    ]);
  });

  it('reconciles bundles using the installed package state after a successful update', async () => {
    const profile = profileDir();
    writeProfileManifest(profile, { [PIANIST_PACKAGE_NAME]: '^0.1.0' }, ['@deepseek-ai/dsh-base']);
    writeInstalledManifest(profile, PIANIST_PACKAGE_NAME, {
      name: PIANIST_PACKAGE_NAME,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    });

    const update = vi.fn(async () => {});
    await updateRegistryProfilePackage(profile, PIANIST_PACKAGE_NAME, update);
    expect(update).toHaveBeenCalledWith(profile, PIANIST_PACKAGE_NAME);

    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } };
    };
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', PIANIST_PACKAGE_NAME]);
  });

  it('keeps a repairable error when package update succeeds but bundle reconciliation fails', async () => {
    const profile = profileDir();
    writeProfileManifest(profile, { [PIANIST_PACKAGE_NAME]: '^0.1.0' }, [PIANIST_PACKAGE_NAME]);

    await expect(updateRegistryProfilePackage(profile, PIANIST_PACKAGE_NAME, async () => {
      rmSync(join(profile, 'package.json'));
    })).rejects.toBeInstanceOf(ProfileBundleReconciliationError);
  });

  it('does not invoke the package manager for a user-owned exact pin', async () => {
    const profile = profileDir();
    writeProfileManifest(profile, { [PIANIST_PACKAGE_NAME]: '1.2.3' }, [PIANIST_PACKAGE_NAME]);
    const update = vi.fn(async () => {});

    await expect(updateRegistryProfilePackage(profile, PIANIST_PACKAGE_NAME, update)).rejects.toBeInstanceOf(ProfileUpdateNotAllowedError);
    expect(update).not.toHaveBeenCalled();
  });

  it('serializes updates per profile without blocking another profile', async () => {
    const releases: Array<() => void> = [];
    const update = vi.fn(async (_profileDir: string) => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
    });
    const coordinator = new ProfileUpdateCoordinator(update);
    const firstProfile = profileDir();
    const secondProfile = profileDir();
    const first = coordinator.run(firstProfile, PIANIST_PACKAGE_NAME);
    await Promise.resolve();

    await expect(coordinator.run(firstProfile, PIANIST_PACKAGE_NAME)).rejects.toBeInstanceOf(ProfileUpdateInProgressError);
    const second = coordinator.run(secondProfile, PIANIST_PACKAGE_NAME);
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);

    for (const release of releases) release();
    await Promise.all([first, second]);
  });
});
