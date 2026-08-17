/** Package metadata read by the running Host process, never supplied by the browser. */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

function packageManifestPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // tsdown emits the Host entry directly into dist/, so its nearest parent
    // is the package root. Source execution still falls through to ../... .
    join(moduleDir, '..', 'package.json'),
    join(moduleDir, '..', '..', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];
  const path = candidates.find(existsSync);
  if (path === undefined) throw new Error('dsh-pianist: package.json could not be located');
  return path;
}

const manifest = JSON.parse(readFileSync(packageManifestPath(), 'utf8')) as PackageManifest;

function required(field: keyof PackageManifest): string {
  const value = manifest[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-pianist: package.json must contain a non-empty ${field}`);
  }
  return value;
}

/** Dependency key the Host inspects in the trusted active profile manifest. */
export const PIANIST_PACKAGE_NAME = required('name');

/** Version of the Host code currently running. */
export const PIANIST_PACKAGE_VERSION = required('version');
