/**
 * Comprehensive Test Suite for Build & Bundler Integration:
 * 1. Virtual module resolution and injection hooks (resolveId, load)
 * 2. backgroundEntry path normalizations (string, RegExp, Windows backslashes, query params)
 * 3. Sourcemap generation & mapping integrity
 * 4. Multi-input Rollup build (background + popup + content script)
 * 5. Cross-browser build integration (Chrome vs Firefox)
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assert, transform, resetCounters, printResults } from './test-helpers.js';
import { mv3Persistent } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

resetCounters();

console.log('\n=== 1. Virtual Module Resolution & Loading Hooks ===');
{
  const plugin = mv3Persistent({
    backgroundEntry: 'src/background/index.ts',
  });

  // resolveId
  const resolved = plugin.resolveId!.call({} as any, 'virtual:mv3-persist-runtime', '/src/bg.ts', {});
  assert(
    resolved === '\0virtual:mv3-persist-runtime.ts',
    'resolveId correctly maps virtual ID to \\0virtual:mv3-persist-runtime.ts',
  );

  const nonVirtualResolved = plugin.resolveId!.call({} as any, 'some-external-package', '/src/bg.ts', {});
  assert(
    nonVirtualResolved === undefined,
    'resolveId ignores non-virtual modules',
  );

  // load before transform (uninitialized)
  const emptyLoad = plugin.load!.call({} as any, '\0virtual:mv3-persist-runtime.ts');
  assert(
    typeof emptyLoad === 'string' && emptyLoad.includes('not yet generated'),
    'load returns placeholder before transform is called',
  );

  // Trigger transform to populate virtual runtime
  const pluginContext = {
    error(msg: string) { throw new Error(msg); },
    warn() {},
  };
  plugin.transform!.call(
    pluginContext as any,
    'let counter = 0;\nchrome.runtime.onInstalled.addListener(() => { counter++; });',
    '/project/src/background/index.ts',
  );

  // load after transform
  const loadedRuntime = plugin.load!.call({} as any, '\0virtual:mv3-persist-runtime.ts');
  assert(
    typeof loadedRuntime === 'string' && loadedRuntime.includes('createMV3Runtime'),
    'load returns generated runtime module with createMV3Runtime export',
  );

  const ignoredLoad = plugin.load!.call({} as any, '/project/src/background/index.ts');
  assert(
    ignoredLoad === undefined,
    'load ignores non-virtual module IDs',
  );
}

console.log('\n=== 2. backgroundEntry Matching & Cross-Platform Path Normalization ===');
{
  const pluginContext = {
    error(msg: string) { throw new Error(msg); },
    warn() {},
  };

  const dummyCode = 'let testVar = 1;';

  // Case A: Standard POSIX string path
  const pluginPosix = mv3Persistent({ backgroundEntry: 'src/background/index.ts' });
  const resPosix = pluginPosix.transform!.call(
    pluginContext as any,
    dummyCode,
    '/home/user/app/src/background/index.ts',
  );
  assert(resPosix !== null && typeof resPosix === 'object', 'Matches standard POSIX path string');

  // Case B: Windows path with backslashes in backgroundEntry option
  const pluginWin = mv3Persistent({ backgroundEntry: 'src\\background\\index.ts' });
  const resWin = pluginWin.transform!.call(
    pluginContext as any,
    dummyCode,
    '/home/user/app/src/background/index.ts',
  );
  assert(resWin !== null && typeof resWin === 'object', 'Matches normalized Windows backslash entry');

  // Case C: Windows path in incoming module ID
  const resWinId = pluginPosix.transform!.call(
    pluginContext as any,
    dummyCode,
    'C:\\Users\\dev\\project\\src\\background\\index.ts',
  );
  assert(resWinId !== null && typeof resWinId === 'object', 'Matches incoming module ID with Windows backslashes');

  // Case D: Leading relative dot-slash in backgroundEntry
  const pluginDot = mv3Persistent({ backgroundEntry: './src/background/index.ts' });
  const resDot = pluginDot.transform!.call(
    pluginContext as any,
    dummyCode,
    '/Users/dev/project/src/background/index.ts',
  );
  assert(resDot !== null && typeof resDot === 'object', 'Matches leading relative dot-slash in backgroundEntry');

  // Case E: Vite query parameters (e.g. ?worker, ?inline)
  const resQuery = pluginPosix.transform!.call(
    pluginContext as any,
    dummyCode,
    '/home/user/app/src/background/index.ts?worker',
  );
  assert(resQuery !== null && typeof resQuery === 'object', 'Matches module ID containing query parameters (?worker)');

  // Case F: RegExp backgroundEntry
  const pluginRegex = mv3Persistent({ backgroundEntry: /background[\\/]index\.(ts|js)$/ });
  const resRegex = pluginRegex.transform!.call(
    pluginContext as any,
    dummyCode,
    '/project/src/background/index.ts',
  );
  assert(resRegex !== null && typeof resRegex === 'object', 'Matches RegExp backgroundEntry');

  // Case G: Non-matching files (popup, content script, options)
  const resPopup = pluginPosix.transform!.call(pluginContext as any, dummyCode, '/project/src/popup/index.ts');
  const resContent = pluginPosix.transform!.call(pluginContext as any, dummyCode, '/project/src/content/index.ts');
  const resUtils = pluginPosix.transform!.call(pluginContext as any, dummyCode, '/project/src/utils/helpers.ts');

  assert(resPopup === null, 'Non-matching popup script returns null without transformation');
  assert(resContent === null, 'Non-matching content script returns null without transformation');
  assert(resUtils === null, 'Non-matching utils script returns null without transformation');
}

console.log('\n=== 3. Sourcemap Generation & Mapping Integrity ===');
{
  const source = `
let counter = 0;
let user = { name: 'Bob' };

chrome.runtime.onInstalled.addListener(() => {
  counter++;
  user.name = 'Alice';
});
`;

  const plugin = mv3Persistent({ backgroundEntry: 'src/background/index.ts' });
  const pluginContext = {
    error(msg: string) { throw new Error(msg); },
    warn() {},
  };

  const result = plugin.transform!.call(pluginContext as any, source, '/src/background/index.ts') as any;

  assert(result !== null && typeof result === 'object', 'Transform produced result');
  assert(result.map !== null && typeof result.map === 'object', 'Result includes sourcemap object');
  assert(result.map.version === 3, 'Sourcemap is version 3');
  assert(
    typeof result.map.mappings === 'string' && result.map.mappings.length > 0,
    'Sourcemap has non-empty mappings string',
  );
  assert(
    Array.isArray(result.map.sources),
    'Sourcemap sources is an Array',
  );
}

console.log('\n=== 4. Multi-Input Rollup Extension Build ===');
async function testMultiInputBuild() {
  const tempDir = mkdtempSync(join(tmpdir(), 'mv3-build-'));
  const srcDir = join(tempDir, 'src');
  const outDir = join(tempDir, 'dist');

  mkdirSync(join(srcDir, 'background'), { recursive: true });
  mkdirSync(join(srcDir, 'popup'), { recursive: true });
  mkdirSync(join(srcDir, 'content'), { recursive: true });

  const bgCode = `
let backgroundQueue = ['job-1', 'job-2'];
let isWorking = false;

chrome.runtime.onInstalled.addListener(async () => {
  isWorking = true;
  backgroundQueue.push('job-init');
});
`;

  const popupCode = `
console.log('Popup script loaded');
export const popupState = { active: true };
`;

  const contentCode = `
console.log('Content script injected into DOM');
document.body.dataset.mv3Test = 'ready';
`;

  writeFileSync(join(srcDir, 'background/index.ts'), bgCode);
  writeFileSync(join(srcDir, 'popup/index.ts'), popupCode);
  writeFileSync(join(srcDir, 'content/content.ts'), contentCode);

  let buildSuccess = false;
  try {
    await build({
      root: tempDir,
      configFile: false,
      logLevel: 'warn',
      plugins: [
        mv3Persistent({
          backgroundEntry: 'src/background/index.ts',
          stateStrategy: 'proxy',
        }),
      ],
      build: {
        outDir,
        emptyOutDir: true,
        rollupOptions: {
          input: {
            background: join(srcDir, 'background/index.ts'),
            popup: join(srcDir, 'popup/index.ts'),
            content: join(srcDir, 'content/content.ts'),
          },
          output: {
            entryFileNames: '[name].js',
          },
        },
      },
    });
    buildSuccess = true;
  } catch (err) {
    console.error('Multi-input build error:', err);
    buildSuccess = false;
  }

  assert(buildSuccess, 'Multi-input Vite build completed with zero errors');

  const bgBundlePath = join(outDir, 'background.js');
  const popupBundlePath = join(outDir, 'popup.js');
  const contentBundlePath = join(outDir, 'content.js');

  assert(existsSync(bgBundlePath), 'background.js chunk emitted');
  assert(existsSync(popupBundlePath), 'popup.js chunk emitted');
  assert(existsSync(contentBundlePath), 'content.js chunk emitted');

  const bgContent = readFileSync(bgBundlePath, 'utf-8');
  const popupContent = readFileSync(popupBundlePath, 'utf-8');
  const contentContent = readFileSync(contentBundlePath, 'utf-8');

  // Background must be transformed with MV3 persistence runtime
  assert(
    bgContent.includes('createMV3Runtime') || bgContent.includes('__mv3_init'),
    'Background script bundle includes MV3 persistence runtime',
  );
  assert(
    bgContent.includes('backgroundQueue') && bgContent.includes('isWorking'),
    'Background script bundle tracks state variables',
  );

  // Popup and Content scripts must NOT contain MV3 persistence runtime
  assert(
    !popupContent.includes('createMV3Runtime') && !popupContent.includes('__mv3_init'),
    'Popup script chunk does NOT contain MV3 persistence runtime',
  );
  assert(
    !contentContent.includes('createMV3Runtime') && !contentContent.includes('__mv3_init'),
    'Content script chunk does NOT contain MV3 persistence runtime',
  );

  // Clean up temp directory
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('\n=== 5. Real-World Job Scraper Extension Build Verification ===');
async function testJobScraperFixtureBuilds() {
  const fixtureDir = resolve(__dirname, 'fixtures/job-scraper');
  const configFile = resolve(fixtureDir, 'vite.config.ts');

  // Chrome Mode Build
  let chromeOk = false;
  try {
    await build({
      configFile,
      mode: 'chrome',
      logLevel: 'warn',
    });
    chromeOk = true;
  } catch (err) {
    console.error('Chrome fixture build failed:', err);
  }
  assert(chromeOk, 'Job Scraper Chrome mode Vite build succeeds cleanly');

  // Firefox Mode Build
  let firefoxOk = false;
  try {
    await build({
      configFile,
      mode: 'firefox',
      logLevel: 'warn',
    });
    firefoxOk = true;
  } catch (err) {
    console.error('Firefox fixture build failed:', err);
  }
  assert(firefoxOk, 'Job Scraper Firefox mode Vite build succeeds cleanly');
}

async function runAll() {
  await testMultiInputBuild();
  await testJobScraperFixtureBuilds();

  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runAll().catch((err) => {
  console.error('Unhandled failure in build-integration.test.ts:', err);
  process.exit(1);
});
