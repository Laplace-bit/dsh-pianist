import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly exports: Record<string, unknown>;
  readonly files: readonly string[];
  readonly dsh: { readonly bundle: { readonly patch: string } };
}

const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest;
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const demo = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

describe('release surface', () => {
  it('declares the DSH bundle, browser entries, and public documentation files', () => {
    expect(packageManifest.exports).toMatchObject({
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      './client': { default: './dist/client.js', types: './dist/client/index.d.ts' },
      './demo': { import: './dist/demo.js', types: './dist/demo.d.ts' },
      './package.json': './package.json',
    });
    expect(packageManifest.files).toEqual(expect.arrayContaining([
      'dist', 'src', 'docs', 'cordis.patch.yml', 'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE',
    ]));
    expect(packageManifest.dsh.bundle.patch).toBe('./cordis.patch.yml');
  });

  it('lets the DSH client-module scanner resolve package metadata', () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve('dsh-pianist/package.json')).toBe(
      new URL('../package.json', import.meta.url).pathname,
    );
  });

  it('keeps the README aligned with the browser-only demo entry and DSH card', () => {
    expect(readme).toContain("from 'dsh-pianist/demo'");
    expect(readme).toContain('settings.plugin.item');
    expect(readme).not.toContain('createInMemoryPianistHost');
    expect(readme).not.toContain('mountPianoSettingsCard');
    expect(readme).toContain('[`docs/index.html`](./docs/index.html)');
    expect(readme).toContain('Salamander Grand Piano V3');
    expect(readme).not.toContain('does not ship a recorded piano sample pack');
  });

  it('keeps the static demo metadata and module entry present', () => {
    expect(demo).toMatch(/<title>dsh-pianist[^<]*<\/title>/);
    expect(demo).toContain('<meta name="description"');
    expect(demo).toContain('<link rel="canonical"');
    expect(demo).toContain('<meta property="og:title"');
    expect(demo).toContain('<meta name="twitter:title"');
    expect(demo).toContain('application/ld+json');
    // The loader tries both site layouts (Pages project dir and /docs/).
    expect(demo).toContain("'../dist/demo.js'");
    expect(demo).toContain("'./dist/demo.js'");
    expect(demo).toContain('registerDshPianoView');
  });

  it('exposes the sample-pack factory from the browser-only entry used by the README', async () => {
    const entry = await import('../src/demo.js');
    expect(entry.createPianoSamplePackFromManifest).toBeTypeOf('function');
    expect(entry.createSalamanderSamplePack).toBeTypeOf('function');
  });
});
