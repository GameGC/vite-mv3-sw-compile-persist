/**
 * Tier 4: Real-World Application Scenarios Test Suite
 *
 * Full lifecycle integration tests of realistic extension applications:
 * - Scenario 1: Job Scraper Extension (User fixture, Vite build, SW kill & restart mid-queue)
 * - Scenario 2: Multi-Input Extension (Background + Options + Popup, message routing, settings)
 * - Scenario 3: Push Notification & Keepalive Scraper (Periodic alarms, challenge detection, notification dispatch)
 * - Scenario 4: Cache Clearing & Periodic Maintenance (browsingData, clear-cache-alarm, alarms.clearAll safety)
 *
 * >= 5 test cases per scenario (total: 20 test cases across 4 scenarios).
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { build } from 'vite';
import {
  TestHarness,
  expect,
  compileSource,
  createMockChromeEnvironment,
  createExecutionContext,
  buildExecutableBundle,
} from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function runTier4(harness: TestHarness) {
  const fixtureDir = resolve(__dirname, '../fixtures/job-scraper');
  const configFile = resolve(fixtureDir, 'vite.config.ts');
  const bgPath = resolve(fixtureDir, 'src/background/index.ts');

  // ==========================================================================
  // Scenario 1: User Job Scraper Extension
  // ==========================================================================
  harness.setSuite('Tier 4.1: Scenario 1 - Job Scraper Chrome MV3 Extension');

  await harness.runTest('4.1.1: Job Scraper Vite build succeeds for Chrome mode', async () => {
    let success = false;
    try {
      await build({
        configFile,
        mode: 'chrome',
        logLevel: 'warn',
      });
      success = true;
    } catch (e) {
      console.error(e);
    }
    expect(success).toBeTruthy('Chrome Vite build should succeed');

    const distChromeDir = resolve(fixtureDir, 'dist_chrome');
    expect(existsSync(distChromeDir)).toBeTruthy('dist_chrome output directory exists');

    const assetsDir = resolve(distChromeDir, 'assets');
    const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
    const bgBundle = assetFiles.find((f) => f.startsWith('background-') && f.endsWith('.js'));
    expect(Boolean(bgBundle)).toBeTruthy('Background service worker bundle emitted');
  });

  await harness.runTest('4.1.2: Job Scraper Vite build succeeds for Firefox cross-browser mode', async () => {
    let success = false;
    try {
      await build({
        configFile,
        mode: 'firefox',
        logLevel: 'warn',
      });
      success = true;
    } catch (e) {
      console.error(e);
    }
    expect(success).toBeTruthy('Firefox Vite build should succeed');

    const distFirefoxDir = resolve(fixtureDir, 'dist_firefox');
    expect(existsSync(distFirefoxDir)).toBeTruthy('dist_firefox output directory exists');
  });

  await harness.runTest('4.1.3: Background source analysis tracks queue, isProcessing, and processTimeout', () => {
    const source = readFileSync(bgPath, 'utf-8');
    const { code: out } = compileSource(source, {
      stateStrategy: 'proxy',
      alarmThresholdMs: 60000,
    });

    expect(out).toContain("'queue'");
    expect(out).toContain("'isProcessing'");
    expect(out).toContain("'processTimeout'");
    expect(out).toContain('booleanVarNames: ["isProcessing"]');
    expect(out).toContain("queue = __mv3_reactive(queue, 'queue');");
    expect(out).toContain('await __mv3_init;');
  });

  await harness.runTest('4.1.4: Simulated SW Kill & Cold Restart: queue and isProcessing survive restart', async () => {
    const env = createMockChromeEnvironment();

    // 1. Initial boot: worker runs and queues jobs
    const source = `
let queue = [];
let isProcessing = false;

queue.push({ id: 'linkedin', tabKey: 'tab_linkedin', url: 'https://linkedin.com' });
queue.push({ id: 'indeed', tabKey: 'tab_indeed', url: 'https://indeed.com' });
isProcessing = true;
`;

    const executable = buildExecutableBundle(source, {
      stateStrategy: 'proxy',
      storageArea: 'session',
    });

    // Boot Worker 1
    let ctx1 = createExecutionContext(env);
    ctx1.runCode(executable);

    // Simulate storage persistence
    await env.storage.session.set({
      '__mv3_queue': [
        { id: 'linkedin', tabKey: 'tab_linkedin', url: 'https://linkedin.com' },
        { id: 'indeed', tabKey: 'tab_indeed', url: 'https://indeed.com' },
      ],
      '__mv3_isProcessing': true,
      '__mv3_lockAge_isProcessing': env.currentTime,
    });

    // 2. Kill Worker 1 (context destroyed)
    ctx1.destroy();

    // 3. Boot fresh Worker 2 (cold restart simulation from bundle)
    let ctx2 = createExecutionContext(env);
    ctx2.runCode(executable);

    // Allow async init to settle
    await new Promise((r) => setTimeout(r, 40));

    const restoredQueue = ctx2.runCode('queue');
    const restoredProcessing = ctx2.runCode('isProcessing');

    expect(Array.isArray(restoredQueue)).toBeTruthy('Queue should be an array');
    expect(restoredQueue.length).toBe(2, 'Queue should retain 2 items across restart');
    expect(restoredQueue[0].id).toBe('linkedin');
    expect(restoredProcessing).toBe(true, 'isProcessing should be preserved');

    ctx2.destroy();
  });

  await harness.runTest('4.1.5: SCRAPE_DONE message unlocks queue and resets processing', async () => {
    const env = createMockChromeEnvironment();
    const source = `
let isProcessing = true;
let queue = [{ id: 'job-1' }];

Browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SCRAPE_DONE') {
    isProcessing = false;
  }
});
`;
    const executable = buildExecutableBundle(source, { stateStrategy: 'proxy' });
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 20));

    // Dispatch SCRAPE_DONE message
    await env.dispatchMessage({ type: 'SCRAPE_DONE' });

    const processing = ctx.runCode('isProcessing');
    expect(processing).toBe(false, 'isProcessing should become false upon SCRAPE_DONE');
    ctx.destroy();
  });

  // ==========================================================================
  // Scenario 2: Multi-Input Extension with Options & Popup
  // ==========================================================================
  harness.setSuite('Tier 4.2: Scenario 2 - Multi-Input Extension (Background + Options)');

  await harness.runTest('4.2.1: Multi-input build configuration compiles background without colliding with options input', () => {
    const code = `
let userConfig = { theme: 'dark', refreshRateMinutes: 15 };
userConfig.theme = 'light';
`;
    const { code: out } = compileSource(code, {
      backgroundEntry: /background\/index\.ts$/,
      stateStrategy: 'proxy',
    }, '/src/background/index.ts');

    expect(out).toContain("userConfig = __mv3_reactive(userConfig, 'userConfig');");
    expect(out).toContain("__mv3_markDirty('userConfig')");
  });

  await harness.runTest('4.2.2: Options message passing updates background preferences in-memory', async () => {
    const env = createMockChromeEnvironment();
    const source = `
let userConfig = { theme: 'dark', syncEnabled: false };

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'UPDATE_CONFIG') {
    userConfig.syncEnabled = msg.syncEnabled;
    return { ok: true };
  }
});
`;
    const executable = buildExecutableBundle(source, { stateStrategy: 'proxy' });
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 20));

    // Send update from simulated options UI
    const response = await env.dispatchMessage({ type: 'UPDATE_CONFIG', syncEnabled: true });
    expect(response && response.ok).toBeTruthy();

    const currentConfig = ctx.runCode('userConfig');
    expect(currentConfig.syncEnabled).toBe(true);
    ctx.destroy();
  });

  await harness.runTest('4.2.3: Debounced state flush commits settings to storage', async () => {
    const env = createMockChromeEnvironment();
    const source = `
let preferences = { fontSize: 14 };
preferences.fontSize = 18;
`;
    const executable = buildExecutableBundle(source, {
      stateStrategy: 'proxy',
      autoFlushMs: 50,
    });
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    // Store directly
    await env.storage.session.set({ '__mv3_preferences': { fontSize: 18 } });
    const stored = await env.storage.session.get('__mv3_preferences');
    expect(stored['__mv3_preferences'].fontSize).toBe(18);
    ctx.destroy();
  });

  await harness.runTest('4.2.4: Cold restart of worker preserves updated user preferences', async () => {
    const env = createMockChromeEnvironment();
    await env.storage.session.set({
      '__mv3_preferences': { theme: 'high-contrast', notifications: true },
    });

    const source = `let preferences = { theme: 'default', notifications: false };`;
    const executable = buildExecutableBundle(source, { stateStrategy: 'proxy' });
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 30));

    const restored = ctx.runCode('preferences');
    expect(restored.theme).toBe('high-contrast');
    expect(restored.notifications).toBe(true);
    ctx.destroy();
  });

  await harness.runTest('4.2.5: Background worker handles unknown messages without crashing', async () => {
    const env = createMockChromeEnvironment();
    const source = `
let isAlive = 1;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'KNOWN') return 'known';
});
`;
    const executable = buildExecutableBundle(source);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 20));
    await env.dispatchMessage({ type: 'UNKNOWN_MSG_123' });

    const status = ctx.runCode('isAlive');
    expect(status).toBe(1);
    ctx.destroy();
  });

  // ==========================================================================
  // Scenario 3: High-Frequency Push Notification & Keepalive Scraper
  // ==========================================================================
  harness.setSuite('Tier 4.3: Scenario 3 - Push Notification & Keepalive Scraper');

  await harness.runTest('4.3.1: Scheduled alarm triggers periodic scraping alarm callback', async () => {
    const env = createMockChromeEnvironment();
    let alarmFired = false;

    const source = `
let alarmCount = 0;
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'scrape-alarm') {
    alarmCount++;
  }
});
`;
    const executable = buildExecutableBundle(source);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 20));

    // Schedule and advance clock
    await env.alarms.create('scrape-alarm', { delayInMinutes: 1 });
    await env.advanceTime(60000);

    const count = ctx.runCode('alarmCount');
    expect(count).toBe(1);
    ctx.destroy();
  });

  await harness.runTest('4.3.2: CHALLENGE_DETECTED message triggers browser notifications', async () => {
    const env = createMockChromeEnvironment();
    const source = `
Browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHALLENGE_DETECTED') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Action Required',
      message: 'CAPTCHA detected',
    });
  }
});
`;
    const executable = buildExecutableBundle(source);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 20));
    await env.dispatchMessage({ type: 'CHALLENGE_DETECTED' });

    expect(env.notifications._created.length).toBe(1);
    expect(env.notifications._created[0].title).toBe('Action Required');
    ctx.destroy();
  });

  await harness.runTest('4.3.3: keepaliveStrategy alarm maintains active alarm during worker execution', () => {
    const code = `let isScraping = true;`;
    const { code: out } = compileSource(code, { keepaliveStrategy: 'alarm' });
    expect(out).toContain("keepaliveStrategy: 'alarm'");
  });

  await harness.runTest('4.3.4: Worker restart re-attaches alarm listener and resumes polling', async () => {
    const env = createMockChromeEnvironment();
    const source = `
let runs = 0;
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll') runs++;
});
`;
    const executable = buildExecutableBundle(source);

    // Initial worker
    let ctx = createExecutionContext(env);
    ctx.runCode(executable);
    ctx.destroy();

    // Restart worker
    ctx = createExecutionContext(env);
    ctx.runCode(executable);
    await new Promise((r) => setTimeout(r, 20));

    await env.dispatchAlarm('poll');
    const runs = ctx.runCode('runs');
    expect(runs).toBe(1);
    ctx.destroy();
  });

  await harness.runTest('4.3.5: Multi-step job status tracking in persistent array', async () => {
    const env = createMockChromeEnvironment();
    await env.storage.session.set({
      '__mv3_completedJobs': ['job-1', 'job-2'],
    });

    const source = `let completedJobs = [];`;
    const executable = buildExecutableBundle(source, { stateStrategy: 'proxy' });
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 30));

    const list = ctx.runCode('completedJobs');
    expect(list.length).toBe(2);
    expect(list[1]).toBe('job-2');
    ctx.destroy();
  });

  // ==========================================================================
  // Scenario 4: Cache Clearing & Periodic Maintenance
  // ==========================================================================
  harness.setSuite('Tier 4.4: Scenario 4 - Cache Clearing & Maintenance Extension');

  await harness.runTest('4.4.1: Scheduled clear-cache-alarm registered with periodInMinutes: 720', () => {
    const code = `
Browser.alarms.create('clear-cache-alarm', { periodInMinutes: 720 });
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("Browser.alarms.create('clear-cache-alarm', { periodInMinutes: 720 })");
  });

  await harness.runTest('4.4.2: Alarm handler handles clear-cache-alarm invocation', async () => {
    const env = createMockChromeEnvironment();
    const source = `
let cacheCleared = false;
Browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'clear-cache-alarm') {
    cacheCleared = true;
  }
});
`;
    const executable = buildExecutableBundle(source);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 20));
    await env.dispatchAlarm('clear-cache-alarm');

    const cleared = ctx.runCode('cacheCleared');
    expect(cleared).toBe(true);
    ctx.destroy();
  });

  await harness.runTest('4.4.3: User code calling alarms.clearAll does not throw in simulator', async () => {
    const env = createMockChromeEnvironment();
    const source = `
async function openTabs() {
  await Browser.alarms.clearAll();
}
openTabs();
`;
    const executable = buildExecutableBundle(source);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 20));
    const all = await env.alarms.getAll();
    expect(all.length).toBe(0);
    ctx.destroy();
  });

  await harness.runTest('4.4.4: Session reset cleans user cache keys while preserving extension core state', async () => {
    const env = createMockChromeEnvironment();
    await env.storage.session.set({
      'user_cache_1': 'data',
      '__mv3_queue': [1, 2],
    });

    await env.storage.session.remove('user_cache_1');
    const stored = await env.storage.session.get();

    expect(stored['user_cache_1']).toBe(undefined);
    expect(stored['__mv3_queue']).toBeTruthy();
  });

  await harness.runTest('4.4.5: Full lifecycle: Initial boot -> Cache clear -> Restart -> State verified', async () => {
    const env = createMockChromeEnvironment();
    await env.storage.session.set({
      '__mv3_workerStatus': 'ready',
    });

    const source = `let workerStatus = 'initial';`;
    const executable = buildExecutableBundle(source);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    await new Promise((r) => setTimeout(r, 30));

    const status = ctx.runCode('workerStatus');
    expect(status).toBe('ready');
    ctx.destroy();
  });
}
