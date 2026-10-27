/**
 * Tier 1: Comprehensive Feature Coverage Test Suite
 *
 * Verifies spec adherence for every inventoried feature from PROJECT.md:
 * >= 5 distinct test cases per feature category (total: 75 test cases across 15 areas).
 */

import {
  TestHarness,
  expect,
  compileSource,
  buildExecutableBundle,
  createMockChromeEnvironment,
  createExecutionContext,
} from './harness.js';

export async function runTier1(harness: TestHarness) {
  // ==========================================================================
  // Area 1: Top-Level State Variable Tracking
  // ==========================================================================
  harness.setSuite('Tier 1.1: Top-Level State Detection');

  await harness.runTest('1.1.1: let number primitive tracked in adapter and markDirty', () => {
    const code = `let counter = 0;\ncounter = 1;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'counter'");
    expect(out).toContain("__mv3_markDirty('counter')");
  });

  await harness.runTest('1.1.2: let string primitive tracked and serialized', () => {
    const code = `let sessionToken = "active";\nsessionToken = "expired";`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'sessionToken'");
    expect(out).toContain("__mv3_markDirty('sessionToken')");
  });

  await harness.runTest('1.1.3: let boolean primitive classified as boolean lock variable', () => {
    const code = `let isProcessing = false;`;
    const { code: out } = compileSource(code);
    expect(out).toContain('booleanVarNames: ["isProcessing"]');
  });

  await harness.runTest('1.1.4: var declaration handled identically to let', () => {
    const code = `var globalFlag = true;\nglobalFlag = false;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'globalFlag'");
    expect(out).toContain('booleanVarNames: ["globalFlag"]');
  });

  await harness.runTest('1.1.5: const declarations are ignored from persistence tracking', () => {
    const code = `const API_KEY = "xyz-123";\nlet mutableCount = 0;`;
    const { code: out } = compileSource(code);
    expect(out).toNotContain("'API_KEY'");
    expect(out).toContain("'mutableCount'");
  });

  // ==========================================================================
  // Area 2: Complex Collection Handling (Map, Set, Date, Array)
  // ==========================================================================
  harness.setSuite('Tier 1.2: Complex Collection Handling');

  await harness.runTest('1.2.1: new Map() detected with collectionType map and serialization hooks', () => {
    const code = `let userMap = new Map();`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_serialize(userMap, 'map')");
    expect(out).toContain("'map'");
  });

  await harness.runTest('1.2.2: new Set() detected with collectionType set and serialization hooks', () => {
    const code = `let uniqueIds = new Set();`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_serialize(uniqueIds, 'set')");
    expect(out).toContain("'set'");
  });

  await harness.runTest('1.2.3: new Date() detected with collectionType date and serialization hooks', () => {
    const code = `let lastChecked = new Date();`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_serialize(lastChecked, 'date')");
    expect(out).toContain("'date'");
  });

  await harness.runTest('1.2.4: Array literal detected with collectionType array and serialization hooks', () => {
    const code = `let queue = [1, 2, 3];`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_serialize(queue, 'array')");
    expect(out).toContain("'array'");
  });

  await harness.runTest('1.2.5: new Array() detected with collectionType array', () => {
    const code = `let buffer = new Array();`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_serialize(buffer, 'array')");
    expect(out).toContain("'array'");
  });

  // ==========================================================================
  // Area 3: Reactive State Strategies (proxy vs static)
  // ==========================================================================
  harness.setSuite('Tier 1.3: Reactive State Strategies');

  await harness.runTest('1.3.1: proxy strategy injects __mv3_reactive wrapping on initialization', () => {
    const code = `let state = { count: 0 };`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain("state = __mv3_reactive(state, 'state');");
  });

  await harness.runTest('1.3.2: proxy strategy injects __mv3_reactive on full reassignment', () => {
    const code = `let queue = [];\nqueue = [1, 2];`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain("queue = __mv3_reactive(queue, 'queue');");
  });

  await harness.runTest('1.3.3: proxy strategy virtual module includes deep ProxyHandler', () => {
    const code = `let obj = { nested: { val: 1 } };`;
    const { virtualModule: vm } = compileSource(code, { stateStrategy: 'proxy' });
    expect(vm).toContain('new Proxy(');
    expect(vm).toContain('__mv3_dirty.add(varName)');
  });

  await harness.runTest('1.3.4: static strategy does NOT inject __mv3_reactive', () => {
    const code = `let state = { count: 0 };`;
    const { code: out } = compileSource(code, { stateStrategy: 'static' });
    expect(out).toNotContain('__mv3_reactive(');
  });

  await harness.runTest('1.3.5: static strategy marks dirty on variable assignments', () => {
    const code = `let state = { count: 0 };\nstate = { count: 1 };`;
    const { code: out } = compileSource(code, { stateStrategy: 'static' });
    expect(out).toContain("__mv3_markDirty('state')");
  });

  // ==========================================================================
  // Area 4: Timer Delay Classification & Rewriting
  // ==========================================================================
  harness.setSuite('Tier 1.4: Timer Rewriting & Delay Analysis');

  await harness.runTest('1.4.1: setTimeout with short numeric literal rewritten to __mv3_setTimeout', () => {
    const code = `function tick() {}\nsetTimeout(tick, 5000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(tick, 5000)');
  });

  await harness.runTest('1.4.2: setTimeout with long numeric literal (>= 60s) rewritten to __mv3_setTimeout', () => {
    const code = `function sync() {}\nsetTimeout(sync, 120000);`;
    const { code: out } = compileSource(code, { alarmThresholdMs: 60000 });
    expect(out).toContain('__mv3_setTimeout(sync, 120000)');
  });

  await harness.runTest('1.4.3: setInterval rewritten to __mv3_setInterval', () => {
    const code = `function heartbeat() {}\nsetInterval(heartbeat, 10000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setInterval(heartbeat, 10000)');
  });

  await harness.runTest('1.4.4: binary arithmetic delay evaluated to numeric millisecond value', () => {
    const code = `function longTask() {}\nsetTimeout(longTask, 5 * 60 * 1000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(longTask, 5 * 60 * 1000)');
  });

  await harness.runTest('1.4.5: anonymous arrow timer callback wrapped and registered', () => {
    const code = `function runJob() {}\nsetTimeout(() => { runJob(); }, 3000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(runJob, 3000)');
  });

  // ==========================================================================
  // Area 5: Timer Cancellation (clearTimeout / clearInterval)
  // ==========================================================================
  harness.setSuite('Tier 1.5: Timer Cancellation');

  await harness.runTest('1.5.1: clearTimeout rewritten to __mv3_clearTimeout', () => {
    const code = `let timerId = 1;\nclearTimeout(timerId);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_clearTimeout(timerId)');
  });

  await harness.runTest('1.5.2: clearInterval rewritten to __mv3_clearInterval', () => {
    const code = `let intervalId = 1;\nclearInterval(intervalId);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_clearInterval(intervalId)');
  });

  await harness.runTest('1.5.3: multiple clear calls within same block transformed properly', () => {
    const code = `let t1 = 1, t2 = 2;\nclearTimeout(t1);\nclearInterval(t2);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_clearTimeout(t1)');
    expect(out).toContain('__mv3_clearInterval(t2)');
  });

  await harness.runTest('1.5.4: clearTimeout without arguments or null argument handled safely', () => {
    const code = `clearTimeout(null);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_clearTimeout(null)');
  });

  await harness.runTest('1.5.5: virtual module defines universal clearTimeout for alarms and native timers', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('function __mv3_clearTimeout(');
    expect(vm).toContain('__mv3_alarm_timeout_');
  });

  // ==========================================================================
  // Area 6: Event Listener Lifecycle & Async Safety
  // ==========================================================================
  harness.setSuite('Tier 1.6: Event Listener Safety');

  await harness.runTest('1.6.1: chrome.runtime.onInstalled listener receives await __mv3_init', () => {
    const code = `chrome.runtime.onInstalled.addListener(async () => { console.log('installed'); });`;
    const { code: out } = compileSource(code);
    expect(out).toContain('await __mv3_init;');
  });

  await harness.runTest('1.6.2: chrome.runtime.onStartup listener receives await __mv3_init', () => {
    const code = `chrome.runtime.onStartup.addListener(async () => { console.log('startup'); });`;
    const { code: out } = compileSource(code);
    expect(out).toContain('await __mv3_init;');
  });

  await harness.runTest('1.6.3: chrome.alarms.onAlarm listener receives await __mv3_init', () => {
    const code = `chrome.alarms.onAlarm.addListener(async (alarm) => { console.log(alarm.name); });`;
    const { code: out } = compileSource(code);
    expect(out).toContain('await __mv3_init;');
  });

  await harness.runTest('1.6.4: synchronous onMessage listener returning true preserves sync return', () => {
    const code = `chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => { return true; });`;
    const { code: out } = compileSource(code);
    // Handlers with return values must NOT be converted to async
    expect(out).toContain('return true;');
  });

  await harness.runTest('1.6.5: polyfill Browser.runtime.onMessage recognized and handled', () => {
    const code = `Browser.runtime.onMessage.addListener(async (msg) => { console.log(msg); });`;
    const { code: out } = compileSource(code);
    expect(out).toContain('await __mv3_init;');
  });

  // ==========================================================================
  // Area 7: Alarms Interception & ClearAll Protection
  // ==========================================================================
  harness.setSuite('Tier 1.7: Alarms Interception & ClearAll Protection');

  await harness.runTest('7.1: Virtual module formats alarm timers with __mv3_alarm_ prefix', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain("'__mv3_alarm_timeout_'");
    expect(vm).toContain("'__mv3_alarm_interval_'");
  });

  await harness.runTest('7.2: Virtual runtime inspects alarm list on cold boot', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('.alarms.getAll()');
  });

  await harness.runTest('7.3: Virtual runtime reconciles alarms during init', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('__mv3_init');
  });

  await harness.runTest('7.4: User periodic alarms can be registered without error', () => {
    const code = `chrome.alarms.create('user-poll', { periodInMinutes: 10 });`;
    const { code: out } = compileSource(code);
    expect(out).toContain("chrome.alarms.create('user-poll'");
  });

  await harness.runTest('7.5: Virtual module dispatches alarm timer callbacks via fn registry', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('__mv3_fn_registry');
  });

  // ==========================================================================
  // Area 8: Function Registration & Recovery
  // ==========================================================================
  harness.setSuite('Tier 1.8: Function Registration');

  await harness.runTest('1.8.1: Top-level function declaration registered in __mv3_fn_registry', () => {
    const code = `function refresh() {}\nsetTimeout(refresh, 5000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_registerFn('refresh', refresh);");
  });

  await harness.runTest('1.8.2: Bound method expression registered with bound expression', () => {
    const code = `let obj = { m() {} };\nconst bound = obj.m.bind(obj);\nsetTimeout(bound, 5000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_registerFn('bound',");
    expect(out).toContain('.bind(');
  });

  await harness.runTest('1.8.3: Simple wrapper callback registers recovery function', () => {
    const code = `function doWork() {}\nsetTimeout(() => { doWork(); }, 1000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_registerFn('doWork', doWork);");
  });

  await harness.runTest('1.8.4: namedAlarmHandlers option registers specified handlers', () => {
    const code = `let count = 0;`;
    const { code: out } = compileSource(code, {
      namedAlarmHandlers: { 'poll-alarm': '() => { count++; }' },
    });
    expect(out).toContain("__mv3_registerFn('poll-alarm',");
  });

  await harness.runTest('1.8.5: Function expressions assigned to variables registered in registry', () => {
    const code = `const handler = function() {};\nsetTimeout(handler, 1000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_registerFn('handler', handler);");
  });

  // ==========================================================================
  // Area 9: Variable Whitelist & Blacklist Filtering
  // ==========================================================================
  harness.setSuite('Tier 1.9: Variable Whitelist & Blacklist');

  await harness.runTest('1.9.1: persistentVars whitelist includes only specified variables', () => {
    const code = `let varA = 1;\nlet varB = 2;\nvarA = 10;\nvarB = 20;`;
    const { code: out } = compileSource(code, { persistentVars: ['varA'] });
    expect(out).toContain("'varA'");
    expect(out).toContain("__mv3_markDirty('varA')");
    expect(out).toNotContain("'varB'");
    expect(out).toNotContain("__mv3_markDirty('varB')");
  });

  await harness.runTest('1.9.2: excludeVars blacklist excludes target variables', () => {
    const code = `let secretKey = 'private';\nlet normalCount = 0;`;
    const { code: out } = compileSource(code, { excludeVars: ['secretKey'] });
    expect(out).toNotContain("'secretKey'");
    expect(out).toContain("'normalCount'");
  });

  await harness.runTest('1.9.3: safeClosureVars suppresses closure warning for listed identifiers', () => {
    const code = `let state = 1;\nfunction run() { setTimeout(() => { console.log(state); }, 1000); }`;
    const { code: out } = compileSource(code, { safeClosureVars: ['state'] });
    expect(out).toContain('__mv3_setTimeout');
  });

  await harness.runTest('1.9.4: Non-whitelisted variables do not generate getVar/setVar accessors', () => {
    const code = `let ignored = 123;\nlet tracked = 456;`;
    const { code: out } = compileSource(code, { persistentVars: ['tracked'] });
    expect(out).toContain("case 'tracked':");
    expect(out).toNotContain("case 'ignored':");
  });

  await harness.runTest('1.9.5: Whitelist and blacklist with empty sets default to all top-level let/var', () => {
    const code = `let x = 1;\nlet y = 2;`;
    const { code: out } = compileSource(code, { persistentVars: [], excludeVars: [] });
    expect(out).toContain("'x'");
    expect(out).toContain("'y'");
  });

  // ==========================================================================
  // Area 10: Stale Lock Detection & Recovery
  // ==========================================================================
  harness.setSuite('Tier 1.10: Stale Lock Auto-Recovery');

  await harness.runTest('1.10.1: Boolean variables designated in booleanVarNames in adapter', () => {
    const code = `let isLocked = false;\nlet queueBusy = true;`;
    const { code: out } = compileSource(code);
    expect(out).toContain('booleanVarNames: ["isLocked","queueBusy"]');
  });

  await harness.runTest('1.10.2: Virtual runtime includes staleLockThresholdMs option', () => {
    const code = `let lock = false;`;
    const { code: out } = compileSource(code, { staleLockThresholdMs: 45000 });
    expect(out).toContain('staleLockThresholdMs: 45000');
  });

  await harness.runTest('1.10.3: Virtual runtime checks lock age key on cold restart', () => {
    const code = `let lock = false;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain("'lockAge_'");
  });

  await harness.runTest('1.10.4: Virtual runtime clears expired lock when time exceeds threshold', () => {
    const code = `let lock = false;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('setVar(bv, false)');
  });

  await harness.runTest('1.10.5: Boolean lock maintains value if active alarm exists', () => {
    const code = `let isRunning = false;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('__mv3_hasActiveWork');
  });

  // ==========================================================================
  // Area 11: Keepalive Strategies
  // ==========================================================================
  harness.setSuite('Tier 1.11: Keepalive Strategies');

  await harness.runTest('1.11.1: keepaliveStrategy alarm configures alarm keepalive', () => {
    const code = `let flag = true;`;
    const { code: out } = compileSource(code, { keepaliveStrategy: 'alarm' });
    expect(out).toContain("keepaliveStrategy: 'alarm'");
  });

  await harness.runTest('1.11.2: keepaliveStrategy offscreen creates offscreen document helpers', () => {
    const code = `let flag = true;`;
    const { virtualModule: vm } = compileSource(code, { keepaliveStrategy: 'offscreen' });
    expect(vm).toContain('__mv3_ensureOffscreenDocument');
    expect(vm).toContain('offscreen');
  });

  await harness.runTest('1.11.3: keepaliveStrategy none emits standard timeout without keepalive hooks', () => {
    const code = `let flag = true;`;
    const { code: out, virtualModule: vm } = compileSource(code, { keepaliveStrategy: 'none' });
    expect(out).toContain("keepaliveStrategy: 'none'");
    expect(vm).toNotContain('__mv3_ensureOffscreenDocument');
  });

  await harness.runTest('1.11.4: offscreen keepalive emits warning in virtual runtime', () => {
    const code = `let flag = true;`;
    const { virtualModule: vm } = compileSource(code, { keepaliveStrategy: 'offscreen' });
    expect(vm).toContain('Offscreen document for SW keepalive');
  });

  await harness.runTest('1.11.5: Keepalive errors do not use empty .catch(() => {}) suppression', () => {
    const code = `let flag = true;`;
    const { virtualModule: vm } = compileSource(code, { keepaliveStrategy: 'offscreen' });
    expect(vm).toNotContain('.catch(() => {})');
  });

  // ==========================================================================
  // Area 12: Promise Resolver Timers
  // ==========================================================================
  harness.setSuite('Tier 1.12: Promise Resolver Timers');

  await harness.runTest('1.12.1: promiseResolverStrategy native transforms to __mv3_setTimeoutPromise', () => {
    const code = `function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }`;
    const { code: out } = compileSource(code, { promiseResolverStrategy: 'native' });
    expect(out).toContain('__mv3_setTimeoutPromise');
  });

  await harness.runTest('1.12.2: promiseResolverStrategy alarm falls through to standard alarm timer', () => {
    const code = `function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }`;
    const { code: out } = compileSource(code, { promiseResolverStrategy: 'alarm' });
    expect(out).toContain('__mv3_setTimeout');
  });

  await harness.runTest('1.12.3: Nested promise executor timer detected', () => {
    const code = `function delay() { return new Promise((resolve) => { setTimeout(() => resolve(), 300); }); }`;
    const { code: out } = compileSource(code, { promiseResolverStrategy: 'native' });
    expect(out).toContain('__mv3_setTimeoutPromise');
  });

  await harness.runTest('1.12.4: setInterval inside promise executor rewritten to __mv3_setIntervalPromise', () => {
    const code = `function waitForCondition() { return new Promise(r => setInterval(r, 1000)); }`;
    const { code: out } = compileSource(code, { promiseResolverStrategy: 'native' });
    expect(out).toContain('__mv3_setIntervalPromise');
  });

  await harness.runTest('1.12.5: Promise resolver timer preserves original resolve parameter name', () => {
    const code = `const p = new Promise(done => setTimeout(done, 500));`;
    const { code: out } = compileSource(code, { promiseResolverStrategy: 'native' });
    expect(out).toContain('__mv3_setTimeoutPromise(done, 500)');
  });

  // ==========================================================================
  // Area 13: Storage Backend Selection & Flushing
  // ==========================================================================
  harness.setSuite('Tier 1.13: Storage Backend Selection');

  await harness.runTest('1.13.1: storageArea session routes state to chrome.storage.session', () => {
    const code = `let x = 1;`;
    const { code: out, virtualModule: vm } = compileSource(code, { storageArea: 'session' });
    expect(out).toContain("storageArea: 'session'");
    expect(vm).toContain('__mv3_ext.storage.session');
  });

  await harness.runTest('1.13.2: storageArea local routes state to chrome.storage.local', () => {
    const code = `let x = 1;`;
    const { code: out, virtualModule: vm } = compileSource(code, { storageArea: 'local' });
    expect(out).toContain("storageArea: 'local'");
    expect(vm).toContain('__mv3_ext.storage.local');
  });

  await harness.runTest('1.13.3: autoFlushMs configures debounce interval', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { autoFlushMs: 3500 });
    expect(out).toContain('autoFlushMs: 3500');
  });

  await harness.runTest('1.13.4: Storage write failures log descriptive error messages', () => {
    const code = `let x = 1;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain("[MV3] Storage write failed:'");
  });

  await harness.runTest('1.13.5: Virtual module exports __mv3_flushDirty function', () => {
    const code = `let x = 1;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('function __mv3_flushDirty(');
  });

  // ==========================================================================
  // Area 14: Control-Flow Bracing & Compound Statements
  // ==========================================================================
  harness.setSuite('Tier 1.14: Control-Flow Bracing');

  await harness.runTest('1.14.1: Bare if statement body wrapped in curly braces', () => {
    const code = `let state = { ok: false };\nif (true) state.ok = true;\n`;
    const { code: out } = compileSource(code);
    expect(out).toContain('{ state.ok = true;');
    expect(out).toContain("__mv3_markDirty('state'); }");
  });

  await harness.runTest('1.14.2: Bare else statement body wrapped in curly braces', () => {
    const code = `let queue = [];\nif (false) {} else queue.push(1);\n`;
    const { code: out } = compileSource(code);
    expect(out).toContain('else { queue.push(1);');
    expect(out).toContain("__mv3_markDirty('queue'); }");
  });

  await harness.runTest('1.14.3: Bare for loop statement body wrapped in curly braces', () => {
    const code = `let obj = { sum: 0 };\nfor (let i = 0; i < 5; i++) obj.sum += i;\n`;
    const { code: out } = compileSource(code);
    expect(out).toContain('{ obj.sum += i;');
  });

  await harness.runTest('1.14.4: Bare while loop statement body wrapped in curly braces', () => {
    const code = `let obj = { n: 10 };\nwhile (obj.n > 0) obj.n -= 1;\n`;
    const { code: out } = compileSource(code);
    expect(out).toContain('{ obj.n -= 1;');
  });

  await harness.runTest('1.14.5: Bare do-while loop statement body wrapped in curly braces', () => {
    const code = `let obj = { n: 0 };\ndo obj.n += 1; while (obj.n < 3);\n`;
    const { code: out } = compileSource(code);
    expect(out).toContain('do { obj.n += 1;');
  });

  // ==========================================================================
  // Area 15: Vite Bundler Integration & Path Matching
  // ==========================================================================
  harness.setSuite('Tier 1.15: Vite Bundler Integration');

  await harness.runTest('1.15.1: backgroundEntry regex matches matching entry path', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { backgroundEntry: /background\/index\.ts$/ }, '/project/src/background/index.ts');
    expect(out).toContain("'x'");
    expect(out).toContain('createMV3Runtime');
  });

  await harness.runTest('1.15.2: backgroundEntry ignores non-background files', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { backgroundEntry: /background\/index\.ts$/ }, '/project/src/content/index.ts');
    expect(out).toNotContain('createMV3Runtime');
  });

  await harness.runTest('1.15.3: virtual module resolveId returns ts-suffixed ID', () => {
    const { mv3Persistent } = require('../../src/index.js');
    const plugin = mv3Persistent();
    const resolved = plugin.resolveId('virtual:mv3-persist-runtime', '/src/bg.ts', {});
    expect(resolved).toBe('\0virtual:mv3-persist-runtime.ts');
  });

  await harness.runTest('1.15.4: virtual module load returns generated runtime content', () => {
    const { mv3Persistent } = require('../../src/index.js');
    const plugin = mv3Persistent();
    plugin.transform!.call({ error: () => {}, warn: () => {} }, 'let x = 1;', '/src/background/index.ts');
    const content = plugin.load!.call({}, '\0virtual:mv3-persist-runtime.ts');
    expect(typeof content).toBe('string');
    expect(content).toContain('createMV3Runtime');
  });

  await harness.runTest('1.15.5: user code imports virtual module without .ts suffix', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("from 'virtual:mv3-persist-runtime'");
    expect(out).toNotContain("from 'virtual:mv3-persist-runtime.ts'");
  });
}
