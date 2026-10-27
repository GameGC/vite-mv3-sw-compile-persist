/**
 * Comprehensive Test Suite for Extension API Flavors:
 * 1. Native chrome.* APIs
 * 2. browser.* APIs (Firefox / W3C standard)
 * 3. Browser from webextension-polyfill
 * 4. Cross-flavor state persistence and alarm lifecycle
 */

import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

console.log('\n=== 1. AST Analysis for Native chrome.* Event Listeners ===');
{
  const source = `
let installCount = 0;
let startupCount = 0;
let alarmCount = 0;
let actionClickCount = 0;
let menuClickCount = 0;

chrome.runtime.onInstalled.addListener(async (details) => {
  installCount++;
});

chrome.runtime.onStartup.addListener(() => {
  startupCount++;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  alarmCount++;
});

chrome.action.onClicked.addListener((tab) => {
  actionClickCount++;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  menuClickCount++;
});
`;

  const { code: out } = transform(source);

  assert(
    out.includes('chrome.runtime.onInstalled.addListener(async (details) => {') &&
      out.includes('await __mv3_init;'),
    'await __mv3_init injected into chrome.runtime.onInstalled',
  );
  assert(
    out.includes('chrome.runtime.onStartup.addListener(async () => {') &&
      out.includes('await __mv3_init;'),
    'async and await __mv3_init injected into sync chrome.runtime.onStartup',
  );
  assert(
    out.includes('chrome.alarms.onAlarm.addListener(async (alarm) => {') &&
      out.includes('await __mv3_init;'),
    'await __mv3_init injected into chrome.alarms.onAlarm',
  );
  assert(
    out.includes('chrome.action.onClicked.addListener(async (tab) => {') &&
      out.includes('await __mv3_init;'),
    'async and await __mv3_init injected into chrome.action.onClicked',
  );
  assert(
    out.includes('chrome.contextMenus.onClicked.addListener(async (info, tab) => {') &&
      out.includes('await __mv3_init;'),
    'async and await __mv3_init injected into chrome.contextMenus.onClicked',
  );
}

console.log('\n=== 2. AST Analysis for browser.* Event Listeners ===');
{
  const source = `
let browserCount = 0;

browser.runtime.onInstalled.addListener(async () => {
  browserCount++;
});

browser.runtime.onStartup.addListener(() => {
  browserCount += 2;
});

browser.alarms.onAlarm.addListener((alarm) => {
  browserCount += 3;
});

browser.action.onClicked.addListener((tab) => {
  browserCount += 4;
});

browser.contextMenus.onClicked.addListener((info) => {
  browserCount += 5;
});
`;

  const { code: out } = transform(source);

  assert(
    out.includes('browser.runtime.onInstalled.addListener(async () => {') &&
      out.includes('await __mv3_init;'),
    'await __mv3_init injected into browser.runtime.onInstalled',
  );
  assert(
    out.includes('browser.runtime.onStartup.addListener(async () => {') &&
      out.includes('await __mv3_init;'),
    'browser.runtime.onStartup transformed to async with await __mv3_init',
  );
  assert(
    out.includes('browser.alarms.onAlarm.addListener(async (alarm) => {') &&
      out.includes('await __mv3_init;'),
    'browser.alarms.onAlarm transformed to async with await __mv3_init',
  );
  assert(
    out.includes('browser.action.onClicked.addListener(async (tab) => {') &&
      out.includes('await __mv3_init;'),
    'browser.action.onClicked transformed to async with await __mv3_init',
  );
  assert(
    out.includes('browser.contextMenus.onClicked.addListener(async (info) => {') &&
      out.includes('await __mv3_init;'),
    'browser.contextMenus.onClicked transformed to async with await __mv3_init',
  );
}

console.log('\n=== 3. AST Analysis for Browser (webextension-polyfill) Event Listeners ===');
{
  const source = `
import Browser from 'webextension-polyfill';

let polyfillCount = 0;

Browser.runtime.onInstalled.addListener(async () => {
  polyfillCount = 10;
});

Browser.runtime.onStartup.addListener(() => {
  polyfillCount = 20;
});

Browser.alarms.onAlarm.addListener(async (alarm) => {
  polyfillCount = 30;
});

Browser.action.onClicked.addListener((tab) => {
  polyfillCount = 40;
});
`;

  const { code: out } = transform(source);

  assert(
    out.includes('Browser.runtime.onInstalled.addListener(async () => {') &&
      out.includes('await __mv3_init;'),
    'await __mv3_init injected into Browser.runtime.onInstalled',
  );
  assert(
    out.includes('Browser.runtime.onStartup.addListener(async () => {') &&
      out.includes('await __mv3_init;'),
    'Browser.runtime.onStartup made async with await __mv3_init',
  );
  assert(
    out.includes('Browser.alarms.onAlarm.addListener(async (alarm) => {') &&
      out.includes('await __mv3_init;'),
    'await __mv3_init injected into Browser.alarms.onAlarm',
  );
  assert(
    out.includes('Browser.action.onClicked.addListener(async (tab) => {') &&
      out.includes('await __mv3_init;'),
    'Browser.action.onClicked made async with await __mv3_init',
  );
}

console.log('\n=== 4. alarms.clearAll Protection Across All Three Flavors ===');
{
  const source = `
chrome.alarms.clearAll();
browser.alarms.clearAll();
Browser.alarms.clearAll();
`;

  const { code: out } = transform(source);

  const clearAllOccurrences = out.match(/__mv3_clearAllAlarms\(\)/g) || [];
  assert(
    clearAllOccurrences.length === 3,
    'All three clearAll variants (chrome, browser, Browser) rewritten to __mv3_clearAllAlarms()',
  );
  assert(
    !out.includes('chrome.alarms.clearAll()') &&
      !out.includes('browser.alarms.clearAll()') &&
      !out.includes('Browser.alarms.clearAll()'),
    'Original clearAll calls completely replaced',
  );
}

console.log('\n=== 5. Runtime Simulator: Native chrome.* State & Alarms Lifecycle ===');
async function testChromeFlavor() {
  const source = `
let eventsList = [];
let chromeCounter = 0;

chrome.runtime.onInstalled.addListener(async (details) => {
  eventsList.push('installed');
  chromeCounter += 1;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'INCREMENT') {
    chromeCounter += 10;
    sendResponse({ counter: chromeCounter, events: eventsList });
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => {
  eventsList.push('action_clicked');
  chromeCounter += 5;
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Dispatch onInstalled
  await sim.runtime.onInstalled.dispatch({ reason: 'install' });
  assert(sim.evaluate('chromeCounter') === 1, 'chromeCounter incremented in onInstalled');
  assert(sim.evaluate('eventsList.length') === 1, 'eventsList captured install event');

  // Dispatch action.onClicked
  await sim.action.onClicked.dispatch({ id: 101, url: 'https://example.com' });
  assert(sim.evaluate('chromeCounter') === 6, 'chromeCounter updated in action.onClicked');
  assert(sim.evaluate('eventsList[1]') === 'action_clicked', 'action_clicked recorded');

  // Dispatch onMessage
  const resp = await sim.dispatchMessage({ type: 'INCREMENT' });
  assert(resp.counter === 16, 'onMessage returned updated counter (16)');
  assert(resp.events.length === 2, 'onMessage returned eventsList');

  // Flush and Cold Restart
  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('chromeCounter') === 16, 'chromeCounter restored to 16 after cold restart');
  assert(sim.evaluate('eventsList.length') === 2, 'eventsList restored after cold restart');
  assert(sim.evaluate('eventsList[0]') === 'installed', 'eventsList[0] is installed');
  assert(sim.evaluate('eventsList[1]') === 'action_clicked', 'eventsList[1] is action_clicked');
}

console.log('\n=== 6. Runtime Simulator: browser.* State & Alarms Lifecycle ===');
async function testBrowserFlavor() {
  const source = `
let browserState = { visitedUrls: [], activeTab: 0 };
let browserCount = 100;

browser.runtime.onStartup.addListener(() => {
  browserCount += 50;
});

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'VISIT') {
    browserState.visitedUrls.push(msg.url);
    browserState.activeTab = msg.tabId;
    browserCount++;
    return { ok: true, count: browserCount };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Dispatch onStartup
  await sim.runtime.onStartup.dispatch();
  assert(sim.evaluate('browserCount') === 150, 'browserCount incremented on startup');

  // Dispatch async onMessage
  const res = await sim.dispatchMessage({ type: 'VISIT', url: 'https://github.com', tabId: 42 });
  assert(res.ok === true && res.count === 151, 'browser.runtime.onMessage handled async message');
  assert(sim.evaluate('browserState.visitedUrls[0]') === 'https://github.com', 'visitedUrls populated');
  assert(sim.evaluate('browserState.activeTab') === 42, 'activeTab updated');

  // Kill and Cold Restart
  await sim.flush();
  await sim.kill();
  assert(!sim.isRunning, 'Simulator is stopped');

  await sim.boot(bundle);
  assert(sim.evaluate('browserCount') === 151, 'browserCount restored across restart');
  assert(sim.evaluate('browserState.visitedUrls.length') === 1, 'visitedUrls preserved across restart');
  assert(sim.evaluate('browserState.activeTab') === 42, 'activeTab preserved across restart');
}

console.log('\n=== 7. Runtime Simulator: Browser (webextension-polyfill) Lifecycle & clearAll Protection ===');
async function testPolyfillFlavor() {
  const source = `
let polyfillQueue = [];
let polyfillIsActive = false;

Browser.runtime.onInstalled.addListener(async () => {
  await Browser.alarms.clearAll();
  polyfillQueue.push({ id: 'task-1' });
  polyfillIsActive = true;
  await Browser.alarms.create('user-task-alarm', { delayInMinutes: 10 });
});

Browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'COMPLETE') {
    polyfillQueue.shift();
    polyfillIsActive = false;
    return Promise.resolve({ remaining: polyfillQueue.length, active: polyfillIsActive });
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  // Pre-seed an internal timer alarm in alarms mock
  await sim.alarms.create('__mv3_alarm_timeout_99', { delayInMinutes: 5 });
  await sim.alarms.create('old-user-alarm', { delayInMinutes: 1 });

  await sim.boot(bundle);

  // Trigger onInstalled (which calls Browser.alarms.clearAll() inside)
  await sim.runtime.onInstalled.dispatch({ reason: 'install' });

  // Internal persistence timer must NOT be wiped by clearAll()
  const internalAlarm = await sim.alarms.get('__mv3_alarm_timeout_99');
  assert(Boolean(internalAlarm), 'Internal __mv3_alarm_timeout_99 preserved after Browser.alarms.clearAll()');

  // Old user alarm should have been cleared
  const oldUserAlarm = await sim.alarms.get('old-user-alarm');
  assert(!oldUserAlarm, 'Old user alarm cleared by clearAll()');

  // Newly created user alarm exists
  const newUserAlarm = await sim.alarms.get('user-task-alarm');
  assert(Boolean(newUserAlarm), 'New user-task-alarm created successfully');

  // Verify in-memory state
  assert(sim.evaluate('polyfillQueue.length') === 1, 'polyfillQueue contains 1 task');
  assert(sim.evaluate('polyfillIsActive') === true, 'polyfillIsActive is true');

  // Send message to shift queue
  const res = await sim.dispatchMessage({ type: 'COMPLETE' });
  assert(res.remaining === 0, 'Task shifted from queue');
  assert(res.active === false, 'polyfillIsActive set to false');

  // Cold Restart
  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('polyfillQueue.length') === 0, 'Restored empty queue state');
  assert(sim.evaluate('polyfillIsActive') === false, 'Restored polyfillIsActive false');
}

console.log('\n=== 8. Mixed API Flavors Interoperability ===');
async function testMixedFlavors() {
  const source = `
let crossCounter = 0;

// Mix chrome.*, browser.*, and Browser in single script
chrome.runtime.onStartup.addListener(() => {
  crossCounter += 1;
});

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'MIXED') {
    crossCounter += 5;
    return { counter: crossCounter };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  await sim.runtime.onStartup.dispatch();
  assert(sim.evaluate('crossCounter') === 1, 'crossCounter updated by chrome onStartup');

  const res = await sim.dispatchMessage({ type: 'MIXED' });
  assert(res.counter === 6, 'crossCounter updated by browser onMessage');

  await sim.flush();
  await sim.restart(bundle);
  assert(sim.evaluate('crossCounter') === 6, 'crossCounter preserved after restart across mixed APIs');
}

async function runAll() {
  await testChromeFlavor();
  await testBrowserFlavor();
  await testPolyfillFlavor();
  await testMixedFlavors();

  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runAll().catch((err) => {
  console.error('Unhandled failure in api-flavors.test.ts:', err);
  process.exit(1);
});
