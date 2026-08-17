import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPianoSampleAssetHandler,
  resolvePianoSampleAssets,
} from '../src/host/sample-assets.js';
import { SALAMANDER_SAMPLE_ASSETS, SALAMANDER_SAMPLE_ROUTE } from '../src/shared/salamander-samples.js';

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

class CaptureResponse {
  status = 0;
  headers: Record<string, string | number> = {};
  body = Buffer.alloc(0);

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  end(body?: Uint8Array): this {
    this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    return this;
  }
}

async function request(method: string, url: string, assets: ReturnType<typeof resolvePianoSampleAssets>) {
  const response = new CaptureResponse();
  await createPianoSampleAssetHandler(assets)(
    { method, url } as IncomingMessage,
    response as unknown as ServerResponse,
  );
  return response;
}

describe('bundled piano sample Host route', () => {
  it('resolves every catalog entry to a non-empty MP3 in the installed dependencies', () => {
    const assets = resolvePianoSampleAssets();

    expect(assets.size).toBe(SALAMANDER_SAMPLE_ASSETS.length);
    for (const asset of assets.values()) {
      expect(statSync(asset.filePath).size).toBeGreaterThan(0);
    }
    const middleC = assets.get(`${SALAMANDER_SAMPLE_ROUTE}/10/C4v10.mp3`);
    if (middleC === undefined) throw new Error('expected bundled C4 sample');
    expect(readFileSync(middleC.filePath).subarray(0, 3).toString('ascii')).toBe('ID3');
  });

  it('resolves only the fixed dependency catalog and serves GET/HEAD with immutable audio headers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pianist-samples-'));
    temporaryDirectories.add(root);
    mkdirSync(join(root, 'audio'));
    const asset = SALAMANDER_SAMPLE_ASSETS.find(item => item.fileName === 'D#4v10.mp3');
    if (asset === undefined) throw new Error('expected catalog asset');
    writeFileSync(join(root, 'audio', asset.fileName), Buffer.from([1, 2, 3, 4]));
    const resolver = vi.fn(() => root);
    const assets = resolvePianoSampleAssets(resolver);

    const get = await request('GET', asset.url, assets);
    const head = await request('HEAD', asset.url, assets);

    expect(resolver).toHaveBeenCalledTimes(9);
    expect(get.status).toBe(200);
    expect(get.headers).toMatchObject({
      'Content-Type': 'audio/mpeg',
      'Content-Length': 4,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(get.body).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
  });

  it('serves a real installed MP3 through a Node HTTP request', async () => {
    const server = createServer(createPianoSampleAssetHandler());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${String(address.port)}${SALAMANDER_SAMPLE_ROUTE}/10/C4v10.mp3`);
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('audio/mpeg');
      expect(body.subarray(0, 3).toString('ascii')).toBe('ID3');
      expect(body.byteLength).toBeGreaterThan(1_000);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it('rejects unknown files, traversal attempts, and non-read methods', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pianist-samples-'));
    temporaryDirectories.add(root);
    mkdirSync(join(root, 'audio'));
    const assets = resolvePianoSampleAssets(() => root);

    expect((await request('GET', `${SALAMANDER_SAMPLE_ROUTE}/10/not-listed.mp3`, assets)).status).toBe(404);
    expect((await request('GET', `${SALAMANDER_SAMPLE_ROUTE}/10/%2e%2e/package.json`, assets)).status).toBe(404);
    const post = await request('POST', SALAMANDER_SAMPLE_ASSETS[0]!.url, assets);
    expect(post.status).toBe(405);
    expect(post.headers.Allow).toBe('GET, HEAD');
  });
});
