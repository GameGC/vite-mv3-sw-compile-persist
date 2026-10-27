/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-param-reassign */
// @ts-nocheck
import { resolve } from 'path';
import { defineConfig, loadEnv, Plugin } from 'vite';
import { mv3Persistent } from '../../../src/index.js';
import manifest from './src/manifest';

export type ManifestV3Export = any;

/**
 * Mock CRXJS plugin for Vite 8 compatibility.
 * Provides manifest export handling and adds background service worker to inputs.
 */
export function crx(options: { manifest: any; browser?: string }): Plugin {
  return {
    name: 'crx-plugin',
    config(config) {
      const bgEntry = resolve(__dirname, 'src/background/index.ts');
      if (!config.build) config.build = {};
      if (!config.build.rollupOptions) config.build.rollupOptions = {};
      const currentInput = config.build.rollupOptions.input;
      if (typeof currentInput === 'object' && currentInput !== null && !Array.isArray(currentInput)) {
        config.build.rollupOptions.input = {
          ...currentInput,
          background: bgEntry,
        };
      }
    },
  };
}

export function tsNameof(): Plugin {
  return {
    name: 'vite-plugin-ts-nameof',
  };
}

const chromeSpecificManifest = {
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
};

const firefoxSpecificManifest = {
  background: {
    scripts: ['src/background/index.ts'],
  },
};

type Mode = 'chrome' | 'firefox';

const generateCrossBrowserManifest = (mode: Mode) => ({
  ...manifest,
  ...(mode === 'firefox' ? firefoxSpecificManifest : chromeSpecificManifest),
});

export default defineConfig(({ mode = 'chrome' }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const envDefines = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ]),
  );

  return {
    root: __dirname,
    define: envDefines,
    plugins: [
      tsNameof(),
      mv3Persistent({
        backgroundEntry: 'src/background/index.ts',
        stateStrategy: 'proxy',
        alarmThresholdMs: 60000,
      }),
      crx({
        manifest: generateCrossBrowserManifest(mode as Mode) as ManifestV3Export,
        browser: 'chrome',
      }),
    ],
    server: {
      cors: {
        origin: [/chrome-extension:\/\//, /moz-extension:\/\//],
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
        '@content': resolve(__dirname, './src/content'),
        '@utils': resolve(__dirname, './src/utils'),
        '@shared': resolve(__dirname, './src/shared'),
      },
    },
    build: {
      outDir: mode === 'firefox' ? 'dist_firefox' : 'dist_chrome',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          background: resolve(__dirname, 'src/background/index.ts'),
          options: resolve(__dirname, 'src/options/index.html'),
        },
        output: {
          entryFileNames: () => 'assets/[name]-[hash].js',
          assetFileNames: (assetInfo) => {
            if (assetInfo.name && /\.(ttf|woff|woff2|eot)$/.test(assetInfo.name)) {
              return 'assets/fonts/[name][extname]';
            }
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
  };
});
