import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'vite';
import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

resetCounters();

const fixtureDir = resolve(__dirname, 'fixtures/job-scraper');
const bgPath = resolve(fixtureDir, 'src/background/index.ts');
const jobScraperSource = readFileSync(bgPath, 'utf-8');

// ============================================================================
// 1. AST Transformation & Analysis Verification
// ============================================================================
console.log('\n=== Job Scraper AST Transformation & Analysis ===');

{
  const { code: out, virtualModule: vm } = transform(jobScraperSource, {
    strategy: 'proxy',
    alarmThresholdMs: 60_000,
  });

  // Verify virtual module import
  assert(
    out.includes("from 'virtual:mv3-persist-runtime'"),
    'Transformed background worker imports from virtual:mv3-persist-runtime',
  );

  // Verify variable tracking in adapter block
  assert(
    out.includes("'queue'") && out.includes("'isProcessing'") && out.includes("'processTimeout'"),
    'Adapter registers persistent variables: queue, isProcessing, processTimeout',
  );

  // Verify boolean lock classification
  assert(
    out.includes('booleanVarNames: ["isProcessing"]'),
    'isProcessing classified as boolean lock variable',
  );

  // Verify initial reactive proxy wrapping for queue
  assert(
    out.includes("queue = __mv3_reactive(queue, 'queue');"),
    'queue is initially wrapped in reactive proxy',
  );

  // Verify reactive wrapping on full reassignment (queue = [])
  assert(
    out.includes("queue = __mv3_reactive(queue, 'queue');"),
    'queue reassignment in openTabs is wrapped in reactive proxy',
  );

  // Verify dirty marking for queue and isProcessing
  assert(
    out.includes("__mv3_markDirty('queue')"),
    '__mv3_markDirty injected for queue assignments',
  );
  assert(
    out.includes("__mv3_markDirty('isProcessing')"),
    '__mv3_markDirty injected for isProcessing assignments',
  );
  assert(
    out.includes("__mv3_markDirty('processTimeout')"),
    '__mv3_markDirty injected for processTimeout assignments',
  );

  // Verify timer call rewrites
  assert(
    out.includes('__mv3_setTimeout'),
    'setTimeout calls rewritten to __mv3_setTimeout',
  );
  assert(
    out.includes('__mv3_clearTimeout'),
    'clearTimeout calls rewritten to __mv3_clearTimeout',
  );
  assert(
    out.includes('__mv3_setTimeoutPromise'),
    'setTimeout inside Promise resolver rewritten to __mv3_setTimeoutPromise',
  );

  // Verify event listeners have __mv3_init injected
  assert(
    out.includes('await __mv3_init;'),
    'await __mv3_init injected into runtime event listeners',
  );

  // Verify function registrations in __mv3_fn_registry
  assert(
    out.includes("__mv3_registerFn('openTabs', openTabs);"),
    'openTabs registered in function registry',
  );
  assert(
    out.includes("__mv3_registerFn('processQueue', processQueue);"),
    'processQueue registered in function registry',
  );
  assert(
    out.includes("__mv3_registerFn('unlockQueue', unlockQueue);"),
    'unlockQueue registered in function registry',
  );
  assert(
    out.includes("__mv3_registerFn('refreshTab', refreshTab);"),
    'refreshTab registered in function registry',
  );

  // Verify virtual module contents
  assert(
    vm.includes('export function createMV3Runtime'),
    'Virtual module exports createMV3Runtime',
  );
  assert(
    vm.includes('__mv3_reactive') && vm.includes('ProxyHandler'),
    'Virtual module provides deep proxy reactivity',
  );
  assert(
    vm.includes('__mv3_alarm_timeout_') && vm.includes('__mv3_alarm_interval_'),
    'Virtual module implements alarm-backed timer scheduling',
  );
  assert(
    vm.includes('staleLockThresholdMs'),
    'Virtual module implements stale lock auto-recovery',
  );
  assert(
    vm.includes('function __mv3_toPlain('),
    'Virtual module provides __mv3_toPlain for proxy-safe serialization',
  );
}

// ============================================================================
// 2. Vite Programmatic Build Integration (Chrome Mode)
// ============================================================================
console.log('\n=== Job Scraper Vite Build Integration (Chrome) ===');

async function testViteBuild() {
  const configFile = resolve(fixtureDir, 'vite.config.ts');
  const distChromeDir = resolve(fixtureDir, 'dist_chrome');

  let buildSuccess = false;
  let bundleContent = '';

  try {
    await build({
      configFile,
      mode: 'chrome',
      logLevel: 'warn',
    });
    buildSuccess = true;
  } catch (err) {
    console.error('Vite build failed:', err);
    buildSuccess = false;
  }

  assert(buildSuccess, 'Vite build succeeds with zero errors');

  // Verify output directory and assets
  assert(existsSync(distChromeDir), 'dist_chrome directory created');

  const assetsDir = resolve(distChromeDir, 'assets');
  assert(existsSync(assetsDir), 'assets directory exists in dist_chrome');

  const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const bgBundle = assetFiles.find((f) => f.startsWith('background-') && f.endsWith('.js'));
  assert(Boolean(bgBundle), 'Background service worker bundle emitted');

  if (bgBundle) {
    bundleContent = readFileSync(resolve(assetsDir, bgBundle), 'utf-8');

    assert(
      bundleContent.includes('createMV3Runtime') || bundleContent.includes('__mv3_init'),
      'Emitted bundle contains MV3 persistence runtime',
    );
    assert(
      bundleContent.includes('queue') && bundleContent.includes('isProcessing'),
      'Emitted bundle tracks queue and isProcessing state',
    );
    assert(
      bundleContent.includes('alarms'),
      'Emitted bundle contains alarm hooks for scheduled tasks',
    );
    assert(
      bundleContent.includes('openTabs') && bundleContent.includes('processQueue'),
      'Emitted bundle contains Job Scraper core handlers',
    );
  }

  // ============================================================================
  // 3. Vite Build Integration (Firefox Cross-Browser Mode)
  // ============================================================================
  console.log('\n=== Job Scraper Vite Build Integration (Firefox) ===');

  const distFirefoxDir = resolve(fixtureDir, 'dist_firefox');
  let firefoxBuildSuccess = false;

  try {
    await build({
      configFile,
      mode: 'firefox',
      logLevel: 'warn',
    });
    firefoxBuildSuccess = true;
  } catch (err) {
    console.error('Firefox build failed:', err);
    firefoxBuildSuccess = false;
  }

  assert(firefoxBuildSuccess, 'Firefox cross-browser Vite build succeeds');
  assert(existsSync(distFirefoxDir), 'dist_firefox directory created');

  const ffAssetsDir = resolve(distFirefoxDir, 'assets');
  const ffAssetFiles = existsSync(ffAssetsDir) ? readdirSync(ffAssetsDir) : [];
  const ffBgBundle = ffAssetFiles.find((f) => f.startsWith('background-') && f.endsWith('.js'));
  assert(Boolean(ffBgBundle), 'Firefox background script bundle emitted');

  // ============================================================================
  // 4. Full MV3 Runtime Lifecycle Simulation (Kill & Cold Restart Mid-Queue)
  // ============================================================================
  console.log('\n=== Job Scraper Runtime Lifecycle Simulation (Kill & Cold Restart) ===');

  const runtimeSource = jobScraperSource
    .replace(/^import\s+.*$/gm, '')
    .replace(
      'async function setupContextMenu(): Promise<void> {}',
      `
async function loadPlatforms() {
  return [
    { id: 'linkedin', name: 'LinkedIn', url: 'https://linkedin.com/jobs', tabKey: 'linkedin_tab', refreshRate: 30, refreshType: 'soft', turnedOn: true },
    { id: 'indeed', name: 'Indeed', url: 'https://indeed.com/jobs', tabKey: 'indeed_tab', refreshRate: 60, refreshType: 'hard', turnedOn: true },
    { id: 'glassdoor', name: 'Glassdoor', url: 'https://glassdoor.com/jobs', tabKey: 'glassdoor_tab', refreshRate: 45, refreshType: 'soft', turnedOn: false },
  ];
}
let savedJobBatches = 0;
let cacheClearedCount = 0;
async function setupContextMenu(): Promise<void> {}
`,
    )
    .replace(
      'function autoClearCacheAndHistory(): void {}',
      'function autoClearCacheAndHistory(): void { cacheClearedCount++; }',
    )
    .replace(
      'async function saveJobsToR2(_jobs: any): Promise<void> {}',
      'async function saveJobsToR2(jobs: any): Promise<void> { savedJobBatches += (jobs ? jobs.length : 0); }',
    );

  const runtimeBundle = compileTestBundle(runtimeSource, {
    strategy: 'proxy',
    alarmThresholdMs: 60_000,
    staleLockThresholdMs: 30_000,
    autoFlushMs: 50,
  });

  const sim = createSimulator();
  await sim.boot(runtimeBundle);

  // 1. Trigger onInstalled -> openTabs()
  await sim.runtime.onInstalled.dispatch({ reason: 'install' });
  await sim.flush();

  assert(sim.evaluate('isProcessing') === true, 'After onInstalled, first platform is processing (isProcessing === true)');
  assert(sim.evaluate('queue.length') === 1, 'Second enabled platform (indeed) is waiting in queue');
  assert(sim.evaluate('queue[0].id') === 'indeed', 'Queued platform is indeed (disabled glassdoor skipped)');

  // 2. Simulate Service Worker kill mid-queue & cold restart
  sim.kill();
  await sim.restart();

  assert(sim.evaluate('isProcessing') === true, 'isProcessing === true survives Service Worker cold restart');
  assert(sim.evaluate('Array.isArray(queue) && queue.length === 1'), 'queue array and its items survive cold restart');
  assert(sim.evaluate('queue[0].id') === 'indeed', 'Restored queue item is indeed after cold restart');

  // 3. Content script sends SAVE_JOBS (async IIFE inside onMessage) & SCRAPE_DONE after restart
  await sim.dispatchMessage({ type: 'SAVE_JOBS', jobs: [{ jobId: '101' }, { jobId: '102' }] });
  assert(sim.evaluate('savedJobBatches') === 2, 'SAVE_JOBS async IIFE handler processes jobs after cold restart');

  await sim.dispatchMessage({ type: 'SCRAPE_DONE' });
  await sim.flush();
  assert(sim.evaluate('isProcessing') === false, 'SCRAPE_DONE unlocks isProcessing');

  // 4. Advance 5s cooldown timer so processQueue() shifts indeed from queue and starts 5-min processTimeout alarm
  await sim.advanceTime(5_500);
  await sim.flush();
  assert(sim.evaluate('isProcessing') === true, 'processQueue starts scraping next platform (indeed)');
  assert(sim.evaluate('queue.length') === 0, 'queue is now empty after shifting indeed');
  assert(
    typeof sim.evaluate('processTimeout') === 'string' &&
      String(sim.evaluate('processTimeout')).startsWith('__mv3_alarm_timeout_'),
    '5-minute MAX_PROCESS_TIME_MS processTimeout is backed by chrome.alarms',
  );

  // 5. Kill & cold-restart while 5-minute processTimeout alarm is pending, then advance 5 minutes
  sim.kill();
  await sim.restart();
  await sim.advanceTime(5 * 60 * 1000 + 1000);
  await sim.flush();
  assert(
    sim.evaluate('isProcessing') === false && sim.evaluate('processTimeout') === null,
    '5-minute processTimeout alarm fires unlockQueue() after cold restart and clears lock',
  );

  sim.kill();

  const allPassed = printResults();
  if (!allPassed) {
    process.exit(1);
  }
}

testViteBuild().catch((err) => {
  console.error('Unexpected test runner failure:', err);
  process.exit(1);
});
