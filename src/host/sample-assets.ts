import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  SALAMANDER_SAMPLE_ASSETS,
  SALAMANDER_SAMPLE_ROUTE,
  type SalamanderSampleAsset,
} from '../shared/salamander-samples.js';

export interface ResolvedSampleAsset extends SalamanderSampleAsset {
  readonly filePath: string;
}

export type PianoSamplePackageRootResolver = (packageName: string) => string;

function defaultPackageRoot(packageName: string): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(`${packageName}/package.json`));
}

/** Resolve the fixed package/file catalog once when the Host route activates. */
export function resolvePianoSampleAssets(
  resolvePackageRoot: PianoSamplePackageRootResolver = defaultPackageRoot,
): ReadonlyMap<string, ResolvedSampleAsset> {
  const roots = new Map<string, string>();
  const resolved = new Map<string, ResolvedSampleAsset>();
  for (const item of SALAMANDER_SAMPLE_ASSETS) {
    let root = roots.get(item.packageName);
    if (root === undefined) {
      root = resolvePackageRoot(item.packageName);
      roots.set(item.packageName, root);
    }
    resolved.set(item.url, Object.freeze({ ...item, filePath: join(root, 'audio', item.fileName) }));
  }
  return resolved;
}

function end(res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

/**
 * Create the read-only HTTP handler used by the plugin's longest-prefix route.
 * Only catalog entries can reach the filesystem; decoded paths are never joined.
 */
export function createPianoSampleAssetHandler(
  assets: ReadonlyMap<string, ResolvedSampleAsset> = resolvePianoSampleAssets(),
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      end(res, 405, { Allow: 'GET, HEAD' });
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const asset = assets.get(pathname);
    if (asset === undefined || !pathname.startsWith(`${SALAMANDER_SAMPLE_ROUTE}/`)) {
      end(res, 404);
      return;
    }
    try {
      const fileStat = await stat(asset.filePath);
      if (!fileStat.isFile()) {
        end(res, 404);
        return;
      }
      const headers = {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': fileStat.size,
        'Content-Type': 'audio/mpeg',
        'X-Content-Type-Options': 'nosniff',
      };
      if (req.method === 'HEAD') {
        end(res, 200, headers);
        return;
      }
      const body = await readFile(asset.filePath);
      res.writeHead(200, headers);
      res.end(body);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        end(res, 404);
        return;
      }
      throw error;
    }
  };
}
