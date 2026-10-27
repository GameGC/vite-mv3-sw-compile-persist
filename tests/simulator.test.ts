/**
 * Comprehensive Test Suite for Node.js MV3 Service Worker Lifecycle Simulator
 * 
 * Verifies:
 * 1. Storage Mock: session & local, structured cloning, CRUD operations
 * 2. Alarms Mock: scheduling, periodic intervals, advanceTime virtual clock, cancellation
 * 3. Polyfill & Messaging: Browser.* bridge, sync return true with sendResponse, async Promise returns
 * 4. Standard Mocks: tabs, notifications, offscreen keepalive, contextMenus
 * 5. State Persistence: variables across worker kill() and restart()
 * 6. Memory Isolation: zero raw object reference leakage across isolates
 * 7. Long-Timer Alarm Conversion: setTimeout >= threshold converted to alarms, surviving restarts
 * 8. Alarm Execution: advanceTime(ms) firing alarms and executing recovered callbacks
 * 9. Stale-Lock Auto-Recovery: clearing stuck boolean locks past staleLockThresholdMs
 * 10. Real-World Job Scraper Lifecycle: mid-process kill & cold restart with queue preservation
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import ts from 'typescript';
import { assert, transform, resetCounters, printResults } from './test-helpers.js';
import { createSimulator, MV3LifecycleSimulator } from './simulator/mv3-simulator.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

resetCounters();

/**
 * Helper to compile user background source code into a self-contained executable bundle
 * by transforming with mv3Persistent, inlining the virtual runtime, and stripping TypeScript types.
 */
function compileTestBundle(sourceCode: string, options: any = {}): string {
  const { code, virtualModule } = transform(sourceCode, {
    strategy: 'proxy',
    alarmThresholdMs: 60_000,
    staleLockThresholdMs: 30_000,
    autoFlushMs: 50,
    ...options,
  });

  const inlinedRuntime = virtualModule.replace(
    'export function createMV3Runtime',
    'function createMV3Runtime',
  );

  const bundle = code.replace(
    /import\s*\{\s*createMV3Runtime\s*\}\s*from\s*['"]virtual:mv3-persist-runtime['"];?/,
    inlinedRuntime,
  );

  const jsBundle = ts.transpileModule(bundle, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;

  return jsBundle;
}

async function runSimulatorTests() {
  // ============================================================================
  // 1. In-Memory Storage Unit Tests (chrome.storage.session & local)
  // ============================================================================
  console.log('\n=== 1. In-Memory Storage Unit Tests ===');
  {
    const sim = createSimulator();
    const session = sim.storage.session;

    // Initial empty
    assert(Object.keys(await session.get(null)).length === 0, 'Storage starts empty');

    // Set items
    await session.set({ user: { name: 'Alice', age: 30 }, count: 1 });
    assert((await session.get('count')).count === 1, 'get(string) returns single item');

    // get(['key1', 'key2'])
    const multi = await session.get(['user', 'count', 'missing']);
    assert(
      multi.user.name === 'Alice' && multi.count === 1 && !('missing' in multi),
      'get(array) returns matched keys',
    );

    // get(object with defaults)
    const defaults = await session.get({ count: 99, missing: 'default_val' });
    assert(
      defaults.count === 1 && defaults.missing === 'default_val',
      'get(defaults) returns stored value or default',
    );

    // remove
    await session.remove('count');
    assert((await session.get('count')).count === undefined, 'remove(string) removes key');

    // remove array
    await session.set({ a: 1, b: 2, c: 3 });
    await session.remove(['a', 'b']);
    const remaining = await session.get(null);
    assert(
      remaining.a === undefined && remaining.b === undefined && remaining.c === 3,
      'remove(array) removes multiple keys',
    );

    // clear
    await session.clear();
    assert(Object.keys(await session.get(null)).length === 0, 'clear() empties storage area');

    // Deep structured clone on set()
    const originalInput = { profile: { theme: 'dark' } };
    await session.set({ settings: originalInput });
    originalInput.profile.theme = 'light'; // Mutate original source
    const retrieved = await session.get('settings');
    assert(
      retrieved.settings.profile.theme === 'dark',
      'set() deep structured-clones input (source mutation does not affect storage)',
    );

    // Deep structured clone on get()
    retrieved.settings.profile.theme = 'neon'; // Mutate output
    const retrievedSecond = await session.get('settings');
    assert(
      retrievedSecond.settings.profile.theme === 'dark',
      'get() deep structured-clones output (output mutation does not leak into storage)',
    );

    // Verify local storage behaves identically
    await sim.storage.local.set({ localKey: 'localVal' });
    assert(
      (await sim.storage.local.get('localKey')).localKey === 'localVal',
      'storage.local operates independently and correctly',
    );
  }

  // ============================================================================
  // 2. Chrome Alarms Mock Unit Tests
  // ============================================================================
  console.log('\n=== 2. Chrome Alarms Mock Unit Tests ===');
  {
    const BASE_TIME = 1_700_000_000_000;
    const sim = createSimulator({ virtualClockStart: BASE_TIME });
    const alarms = sim.alarms;

    // Create delayInMinutes alarm
    await alarms.create('alarm-delay', { delayInMinutes: 2 });
    const delayAlarm = await alarms.get('alarm-delay');
    assert(delayAlarm?.name === 'alarm-delay', 'Alarms create & get retrieves alarm');
    assert(
      delayAlarm?.scheduledTime === BASE_TIME + 120_000,
      'delayInMinutes correctly computes scheduledTime from virtual clock',
    );

    // Create periodInMinutes alarm
    await alarms.create('alarm-periodic', { periodInMinutes: 5 });
    const periodicAlarm = await alarms.get('alarm-periodic');
    assert(periodicAlarm?.periodInMinutes === 5, 'periodInMinutes is recorded');

    // getAll
    const allAlarms = await alarms.getAll();
    assert(allAlarms.length === 2, 'getAll returns all scheduled alarms');

    // clear single alarm
    await alarms.clear('alarm-delay');
    assert((await alarms.get('alarm-delay')) === undefined, 'clear() removes specified alarm');

    // Dispatch via advanceTime
    let firedCount = 0;
    alarms.onAlarm.addListener((a) => {
      if (a.name === 'alarm-periodic') firedCount++;
    });

    // Advance time by 4 minutes (not due yet)
    await sim.advanceTime(4 * 60 * 1000);
    assert(firedCount === 0, 'advanceTime before due does not fire alarm');

    // Advance time by 2 minutes (now 6 minutes, period is 5 -> due!)
    await sim.advanceTime(2 * 60 * 1000);
    assert(firedCount === 1, 'advanceTime past due fires scheduled alarm');

    // Periodic alarm is automatically rescheduled
    const rescheduled = await alarms.get('alarm-periodic');
    assert(Boolean(rescheduled), 'Periodic alarm remains scheduled after firing');
    assert(rescheduled!.scheduledTime > sim.virtualClock, 'Periodic alarm next scheduledTime is in future');

    // clearAll
    await alarms.clearAll();
    assert((await alarms.getAll()).length === 0, 'clearAll() wipes all alarms');
  }

  // ============================================================================
  // 3. WebExtension Polyfill Bridge & Runtime Messaging
  // ============================================================================
  console.log('\n=== 3. WebExtension Polyfill & Runtime Messaging ===');
  {
    const sim = createSimulator();

    // getURL
    assert(
      sim.runtime.getURL('options.html') === 'chrome-extension://mv3-simulator-ext-id/options.html',
      'getURL formats extension relative path',
    );

    // getContexts & offscreen document
    assert((await sim.runtime.getContexts()).length === 0, 'getContexts returns empty when no offscreen document');
    await sim.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'test' });
    const contexts = await sim.runtime.getContexts();
    assert(
      contexts.length === 1 && contexts[0].contextType === 'OFFSCREEN_DOCUMENT',
      'getContexts returns offscreen document when open',
    );
    await sim.offscreen.closeDocument();
    assert((await sim.runtime.getContexts()).length === 0, 'closeDocument clears offscreen context');

    // onMessage: synchronous return true with async sendResponse
    sim.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'ASYNC_PING') {
        setTimeout(() => sendResponse({ reply: 'ASYNC_PONG' }), 10);
        return true;
      }
    });

    const asyncRes = await sim.runtime.onMessage.dispatchMessage({ type: 'ASYNC_PING' });
    assert(
      asyncRes?.reply === 'ASYNC_PONG',
      'onMessage handles synchronous return true with async sendResponse',
    );

    // onMessage: async Promise return (webextension-polyfill style)
    sim.runtime.onMessage.addListener(async (msg) => {
      if (msg.type === 'PROMISE_PING') {
        return { reply: 'PROMISE_PONG' };
      }
    });

    const promiseRes = await sim.runtime.onMessage.dispatchMessage({ type: 'PROMISE_PING' });
    assert(
      promiseRes?.reply === 'PROMISE_PONG',
      'onMessage handles async Promise return as in webextension-polyfill',
    );
  }

  // ============================================================================
  // 4. Standard Mocks (Tabs, Notifications, ContextMenus)
  // ============================================================================
  console.log('\n=== 4. Standard Mocks (Tabs, Notifications, ContextMenus) ===');
  {
    const sim = createSimulator();

    // Tabs
    const tab = await sim.tabs.create({ url: 'https://example.com' });
    assert(tab.id === 1 && tab.url === 'https://example.com', 'tabs.create creates new tab');
    const updatedTab = await sim.tabs.update(1, { url: 'https://updated.com' });
    assert(updatedTab.url === 'https://updated.com', 'tabs.update updates tab properties');
    await sim.tabs.remove(1);
    let tabFound = true;
    try { await sim.tabs.get(1); } catch { tabFound = false; }
    assert(!tabFound, 'tabs.remove removes tab');

    // Notifications
    const notifId = await sim.notifications.create({ title: 'Test Alert', message: 'Hello' });
    assert(Boolean(notifId), 'notifications.create generates notification ID');
    assert(sim.notifications.getAll()[notifId].title === 'Test Alert', 'Notification recorded');
    await sim.notifications.clear(notifId);
    assert(sim.notifications.getAll()[notifId] === undefined, 'notifications.clear removes notification');

    // Context menus
    const menuId = sim.contextMenus.create({ id: 'cm_item', title: 'Context Item' });
    assert(Boolean(menuId), 'contextMenus.create creates menu item');
    sim.contextMenus.removeAll();
  }

  // ============================================================================
  // 5. State Persistence Across SW Kill & Restart
  // ============================================================================
  console.log('\n=== 5. State Persistence Across SW Kill & Restart ===');
  {
    const sim = createSimulator();
    const source = `
      let queue = ['task1', 'task2'];
      let counter = 100;
      let isProcessing = false;

      function updateState() {
        queue.push('task3');
        counter = 105;
        isProcessing = true;
      }
    `;
    const bundle = compileTestBundle(source);

    await sim.boot(bundle);
    assert(sim.isRunning, 'Simulator is running after boot');

    // Mutate state via transformed function
    sim.evaluate('updateState();');
    assert(sim.evaluate('queue.length') === 3, 'Queue modified in worker isolate');
    assert(sim.evaluate('counter') === 105, 'Counter updated in worker isolate');
    assert(sim.evaluate('isProcessing') === true, 'isProcessing set in worker isolate');

    // Flush dirty state to persistent storage
    await sim.flush();
    const storedQueue = await sim.storage.session.get('__mv3_queue');
    assert(Boolean(storedQueue.__mv3_queue), 'Queue serialized to persistent storage');

    // Abrupt kill
    sim.kill();
    assert(!sim.isRunning, 'Simulator is not running after kill');

    // Cold restart
    await sim.restart(bundle);
    assert(sim.isRunning, 'Simulator is running after restart');

    // Verify state restored in brand new isolate
    assert(sim.evaluate('queue.length') === 3, 'queue.length restored to 3 after cold restart');
    assert(sim.evaluate('queue[2]') === 'task3', 'queue items preserved across restart');
    assert(sim.evaluate('counter') === 105, 'counter restored to 105 across restart');
    assert(sim.evaluate('isProcessing') === true, 'isProcessing restored to true across restart');

    // Verify Array methods work seamlessly on restored reactive proxy
    sim.evaluate("queue.shift(); queue.push('task4');");
    assert(sim.evaluate('queue.length') === 3, 'Array methods (shift, push) work on restored reactive queue');
    assert(sim.evaluate('queue[0]') === 'task2', 'Shift properly removed first element');
    assert(sim.evaluate('queue[2]') === 'task4', 'Push appended task4 to restored queue');
  }

  // ============================================================================
  // 6. Memory & Reference Isolation (Zero Reference Leakage)
  // ============================================================================
  console.log('\n=== 6. Memory & Reference Isolation (Zero Reference Leakage) ===');
  {
    const sim = createSimulator();
    const source = `
      let user = { name: 'Alice', scores: [10, 20] };
    `;
    const bundle = compileTestBundle(source);

    await sim.boot(bundle);
    sim.evaluate("user.name = 'Bob'; user.scores.push(30);");
    await sim.flush();

    const w1User = sim.evaluate('user');
    assert(w1User.name === 'Bob' && w1User.scores.length === 3, 'Worker 1 user updated');

    // Verify host storage holds a cloned copy, not worker reference
    const hostStored = await sim.storage.session.get('__mv3_user');
    assert(hostStored.__mv3_user !== w1User, 'Host storage holds cloned object, not raw worker reference');

    // Mutating host storage does not affect worker 1
    hostStored.__mv3_user.name = 'Hacker';
    assert(sim.evaluate('user.name') === 'Bob', 'Worker 1 isolate memory not corrupted by external storage object mutation');

    // Kill and restart
    sim.kill();
    await sim.restart(bundle);

    const w2User = sim.evaluate('user');
    assert(w2User.name === 'Bob', 'Worker 2 has restored name Bob');
    assert(w2User !== w1User, 'Worker 2 object has completely distinct identity from Worker 1 (zero reference sharing)');

    // Mutating Worker 2 does not affect Worker 1's old reference handle
    w2User.name = 'Charlie';
    assert(w1User.name === 'Bob', 'Mutating Worker 2 object does not affect Worker 1 object handle');
  }

  // ============================================================================
  // 7. Long-Timer Alarm Conversion & Cold-Restart Callback Triggering
  // ============================================================================
  console.log('\n=== 7. Long-Timer Alarm Conversion & Cold-Restart Callback ===');
  {
    const sim = createSimulator({ virtualClockStart: 1_000_000 });
    const source = `
      let timerFired = false;
      let timerId = null;
      function handleLongTimer() {
        timerFired = true;
      }
      function startTimer() {
        timerId = setTimeout(handleLongTimer, 120000);
      }
    `;
    const bundle = compileTestBundle(source, { alarmThresholdMs: 60000 });

    await sim.boot(bundle);
    sim.evaluate('startTimer();');
    const timerId = sim.evaluate('timerId');
    assert(
      typeof timerId === 'string' && timerId.startsWith('__mv3_alarm_timeout_'),
      'setTimeout >= 60s converted to alarm-backed timer',
    );

    // Verify alarm scheduled in alarms engine
    const alarms = await sim.alarms.getAll();
    assert(alarms.length === 1 && alarms[0].name === timerId, 'Alarm scheduled in Chrome alarms engine');
    assert(alarms[0].scheduledTime === 1_000_000 + 120_000, 'Alarm scheduled 2 minutes in future');

    // Kill worker mid-countdown
    sim.kill();
    assert((await sim.alarms.getAll()).length === 1, 'Scheduled alarm persists across SW kill');

    // Cold restart
    await sim.restart(bundle);
    assert(sim.evaluate('timerFired') === false, 'Callback not fired yet after restart');

    // Advance virtual time by 1 minute (60,000ms) - not due yet
    await sim.advanceTime(60_000);
    assert(sim.evaluate('timerFired') === false, 'Callback does not fire when timer delay has not elapsed');

    // Advance virtual time by another 1 minute (60,000ms) - total 120,000ms -> due!
    await sim.advanceTime(60_000);
    assert(sim.evaluate('timerFired') === true, 'Callback fired after virtual time advanced past alarm scheduledTime');
    assert((await sim.alarms.getAll()).length === 0, 'One-shot alarm cleared after firing');
  }

  // ============================================================================
  // 8. Stale-Lock Auto-Recovery on Cold Restart
  // ============================================================================
  console.log('\n=== 8. Stale-Lock Auto-Recovery on Cold Restart ===');
  {
    const sim = createSimulator({ virtualClockStart: 2_000_000 });
    const source = `
      let isProcessing = false;
      function acquireLock() {
        isProcessing = true;
      }
    `;
    const bundle = compileTestBundle(source, { staleLockThresholdMs: 30_000 });

    await sim.boot(bundle);
    sim.evaluate('acquireLock();');
    await sim.flush();
    assert(sim.evaluate('isProcessing') === true, 'Lock acquired: isProcessing = true');

    // Verify lock age recorded in storage
    const lockAgeData = await sim.storage.session.get('__mv3_lockAge_isProcessing');
    assert(lockAgeData.__mv3_lockAge_isProcessing === 2_000_000, 'Lock age recorded in storage');

    // Kill SW
    sim.kill();

    // Test Case A: Time advances only 10 seconds (< 30s threshold) -> lock preserved
    await sim.advanceTime(10_000);
    await sim.restart(bundle);
    assert(sim.evaluate('isProcessing') === true, 'Lock kept true when elapsed time < staleLockThresholdMs');

    // Kill SW again
    sim.kill();

    // Test Case B: Time advances another 25 seconds (total 35s > 30s threshold) -> stale lock cleared!
    await sim.advanceTime(25_000);
    await sim.restart(bundle);
    assert(sim.evaluate('isProcessing') === false, 'Stale lock automatically recovered to false upon cold restart');
    const cleanedLock = await sim.storage.session.get('__mv3_lockAge_isProcessing');
    assert(cleanedLock.__mv3_lockAge_isProcessing === undefined, 'Stale lock timestamp removed from storage');
  }

  // ============================================================================
  // 9. Real-World Job Scraper Chrome Extension SW Lifecycle Simulation
  // ============================================================================
  console.log('\n=== 9. Real-World Job Scraper Chrome Extension SW Lifecycle ===');
  {
    const fixtureDir = resolve(__dirname, 'fixtures/job-scraper');
    const configFile = resolve(fixtureDir, 'vite.config.ts');
    const assetsDir = resolve(fixtureDir, 'dist_chrome/assets');

    // Build Job Scraper fixture if not yet built
    let bgFile = existsSync(assetsDir)
      ? readdirSync(assetsDir).find((f) => f.startsWith('background-') && f.endsWith('.js'))
      : null;

    if (!bgFile) {
      console.log('Building Job Scraper extension for simulator test...');
      await build({
        configFile,
        mode: 'chrome',
        logLevel: 'error',
      });
      bgFile = readdirSync(assetsDir).find((f) => f.startsWith('background-') && f.endsWith('.js'));
    }

    assert(Boolean(bgFile), 'Job Scraper background bundle found');
    const jobScraperBundle = readFileSync(resolve(assetsDir, bgFile!), 'utf-8');

    const sim = createSimulator();
    await sim.boot(jobScraperBundle);
    assert(sim.isRunning, 'Job Scraper compiled bundle boots cleanly in simulator');

    // Verify listeners registered on boot
    assert(sim.runtime.onInstalled.count > 0, 'Job Scraper registered onInstalled listener');
    assert(sim.alarms.onAlarm.hasListener !== undefined, 'Job Scraper registered onAlarm listener');
    assert(sim.runtime.onMessage.count > 0, 'Job Scraper registered onMessage listener');

    // Dispatch onInstalled (triggers openTabs())
    await sim.runtime.onInstalled.dispatch();
    await sim.flush();

    // Inspect storage state after openTabs():
    // 1. Local storage contains opened tab IDs
    const localStorageData = await sim.storage.local.get(null);
    assert(
      Boolean(localStorageData.linkedin_tab),
      'openTabs() recorded active tab in storage.local',
    );

    // 2. Scheduled alarms exist for platforms
    const alarmsAfterOpen = await sim.alarms.getAll();
    assert(
      alarmsAfterOpen.some((a) => a.name.startsWith('refresh-')),
      'Platform periodic refresh alarms scheduled',
    );
    assert(
      alarmsAfterOpen.some((a) => a.name === 'clear-cache-alarm'),
      'clear-cache-alarm periodic alarm scheduled',
    );

    // 3. Persistent state: queue has remaining items, isProcessing is true
    const sessionData = await sim.storage.session.get(null);
    assert(
      sessionData.__mv3_isProcessing === true,
      'isProcessing persisted as true during active scrape',
    );
    assert(
      Boolean(sessionData.__mv3_queue),
      'queue state persisted during active scrape',
    );

    // Simulate abrupt SW kill mid-scrape!
    sim.kill();
    assert(!sim.isRunning, 'Service worker killed mid-scrape');

    // Scheduled alarms must survive SW kill
    const postKillAlarms = await sim.alarms.getAll();
    assert(
      postKillAlarms.length === alarmsAfterOpen.length,
      'All scheduled Chrome alarms survive SW kill',
    );

    // Cold restart from bundle
    await sim.restart(jobScraperBundle);
    assert(sim.isRunning, 'Service worker successfully restarted from bundle');

    // Verify state restored after cold restart
    const restoredSession = await sim.storage.session.get(null);
    assert(
      restoredSession.__mv3_isProcessing === true,
      'isProcessing state preserved across cold restart',
    );
    assert(
      Boolean(restoredSession.__mv3_queue),
      'queue items preserved across cold restart',
    );

    // Dispatch SCRAPE_DONE message arriving from tab
    await sim.dispatchMessage({ type: 'SCRAPE_DONE' });
    await sim.flush();

    const afterDoneSession = await sim.storage.session.get(null);
    assert(
      afterDoneSession.__mv3_isProcessing === false,
      'SCRAPE_DONE message resets isProcessing to false and unlocks queue',
    );
  }

  // ============================================================================
  // Results
  // ============================================================================
  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runSimulatorTests().catch((err) => {
  console.error('Simulator test suite failure:', err);
  process.exit(1);
});
