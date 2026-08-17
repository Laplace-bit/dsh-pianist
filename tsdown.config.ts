import { defineConfig, type UserConfig } from 'tsdown';

const PACKAGE_ID = 'dsh-pianist';

/** Modules owned by the DSH web shell rather than this package's client bundle. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-tool/client',
] as const;

/** Host/library output remains ordinary ESM for Cordis and normal package consumers. */
const hostBundle: UserConfig = {
  name: PACKAGE_ID,
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ],
  },
};

/** Browser code is registered into Harness' ModuleLoader rather than emitted as a second ESM runtime. */
const clientBundle: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id as typeof CLIENT_EXTERNALS[number]) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null;
      if (CLIENT_EXTERNALS.includes(source as typeof CLIENT_EXTERNALS[number])) return null;
      throw new Error(
        `client bundle purity: "${source}" is not a DSH web-shell module; cross-plugin value imports are forbidden`,
      );
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
};

/** Standalone ESM entry used by the static demo; it never imports the Host half. */
const demoBundle: UserConfig = {
  name: `${PACKAGE_ID}/demo`,
  entry: { demo: 'src/demo.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
};

export default defineConfig([hostBundle, clientBundle, demoBundle]);
