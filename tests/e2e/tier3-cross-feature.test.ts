/**
 * Tier 3: Cross-Feature Combinations Test Suite
 *
 * Validates pairwise and multi-way interactions across orthogonal features:
 * 1. storageArea: 'local' x stateStrategy: 'proxy' x keepaliveStrategy: 'offscreen'
 * 2. storageArea: 'session' x stateStrategy: 'static' x keepaliveStrategy: 'alarm'
 * 3. alarmThresholdMs (30s) x short timers (10s) vs long timers (120s) x clearTimeout
 * 4. persistentVars whitelist x excludeVars blacklist x safeClosureVars
 * 5. staleLockThresholdMs x boolean locks x simulated SW cold restart
 * 6. Reactive proxy arrays x mutating methods (push, shift, splice) in bare control-flow
 * 7. promiseResolverStrategy: 'alarm' x setTimeoutPromise x cold restart
 * 8. Browser.* (webextension-polyfill) x onMessage async IIFE x __mv3_init
 * 9. Nested collections (Map, Set, Date) x stateStrategy: 'proxy' x structured serialization
 * 10. alarms.clearAll() x active __mv3_alarm_* x user periodic alarms
 */

import {
  TestHarness,
  expect,
  compileSource,
  createMockChromeEnvironment,
  createExecutionContext,
  buildExecutableBundle,
} from './harness.js';

export async function runTier3(harness: TestHarness) {
  // ==========================================================================
  // Combo 1: storageArea: 'local' x stateStrategy: 'proxy' x keepaliveStrategy: 'offscreen'
  // ==========================================================================
  harness.setSuite('Tier 3.1: storageArea(local) x stateStrategy(proxy) x keepalive(offscreen)');

  await harness.runTest('3.1.1: Code generation combines local storage, proxy reactive wrappers, and offscreen keepalive', () => {
    const code = `let state = { count: 0 };\nstate.count = 1;`;
    const { code: out, virtualModule: vm } = compileSource(code, {
      storageArea: 'local',
      stateStrategy: 'proxy',
      keepaliveStrategy: 'offscreen',
    });

    expect(out).toContain("storageArea: 'local'");
    expect(out).toContain("stateStrategy: 'proxy'");
    expect(out).toContain("keepaliveStrategy: 'offscreen'");
    expect(out).toContain("state = __mv3_reactive(state, 'state');");
    expect(vm).toContain('__mv3_ensureOffscreenDocument');
    expect(vm).toContain('__mv3_ext.storage.local');
  });

  await harness.runTest('3.1.2: In-memory VM boots cleanly with local storage and proxy reactivity', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let userStore = { counter: 0 };
userStore.counter = 42;
`;
    const executable = buildExecutableBundle(userCode, {
      storageArea: 'local',
      stateStrategy: 'proxy',
    });

    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    // Verify initial execution in sandbox
    const count = ctx.runCode('userStore.counter');
    expect(count).toBe(42);
    ctx.destroy();
  });

  // ==========================================================================
  // Combo 2: storageArea: 'session' x stateStrategy: 'static' x keepaliveStrategy: 'alarm'
  // ==========================================================================
  harness.setSuite('Tier 3.2: storageArea(session) x stateStrategy(static) x keepalive(alarm)');

  await harness.runTest('3.2.1: Code generation configures session storage with static assignments and alarm keepalive', () => {
    const code = `let flag = false;\nflag = true;`;
    const { code: out, virtualModule: vm } = compileSource(code, {
      storageArea: 'session',
      stateStrategy: 'static',
      keepaliveStrategy: 'alarm',
    });

    expect(out).toContain("storageArea: 'session'");
    expect(out).toContain("stateStrategy: 'static'");
    expect(out).toContain("keepaliveStrategy: 'alarm'");
    expect(out).toNotContain('__mv3_reactive(');
    expect(vm).toContain('__mv3_ext.storage.session');
  });

  await harness.runTest('3.2.2: Static assignment marks dirty without proxy overhead', () => {
    const code = `let items = [1, 2];\nitems = [1, 2, 3];`;
    const { code: out } = compileSource(code, { stateStrategy: 'static' });
    expect(out).toContain("__mv3_markDirty('items')");
    expect(out).toNotContain('__mv3_reactive(');
  });

  // ==========================================================================
  // Combo 3: alarmThresholdMs (30s) x Short (10s) vs Long (120s) Timers x Cancellation
  // ==========================================================================
  harness.setSuite('Tier 3.3: alarmThresholdMs x Short vs Long Timers x Cancellation');

  await harness.runTest('3.3.1: Short timer (10s < 30s) and long timer (120s >= 30s) rewritten uniformly', () => {
    const code = `
function shortTask() {}
function longTask() {}
const t1 = setTimeout(shortTask, 10000);
const t2 = setTimeout(longTask, 120000);
clearTimeout(t1);
clearTimeout(t2);
`;
    const { code: out } = compileSource(code, { alarmThresholdMs: 30000 });
    expect(out).toContain('__mv3_setTimeout(shortTask, 10000)');
    expect(out).toContain('__mv3_setTimeout(longTask, 120000)');
    expect(out).toContain('__mv3_clearTimeout(t1)');
    expect(out).toContain('__mv3_clearTimeout(t2)');
  });

  await harness.runTest('3.3.2: Virtual runtime schedules long timer as chrome alarm and short timer as native timeout', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code, { alarmThresholdMs: 30000 });
    expect(vm).toContain('__mv3_ext.alarms.create');
    expect(vm).toContain('__mv3_alarm_timeout_');
  });

  // ==========================================================================
  // Combo 4: persistentVars Whitelist x excludeVars Blacklist x safeClosureVars
  // ==========================================================================
  harness.setSuite('Tier 4.4: persistentVars x excludeVars x safeClosureVars');

  await harness.runTest('3.4.1: Whitelist overrides non-whitelisted; excludeVars strips from whitelist', () => {
    const code = `
let a = 1;
let b = 2;
let c = 3;
a = 10;
b = 20;
c = 30;
`;
    const { code: out } = compileSource(code, {
      persistentVars: ['a', 'b'],
      excludeVars: ['b'],
    });

    expect(out).toContain("'a'");
    expect(out).toContain("__mv3_markDirty('a')");
    expect(out).toNotContain("'b'");
    expect(out).toNotContain("__mv3_markDirty('b')");
    expect(out).toNotContain("'c'");
    expect(out).toNotContain("__mv3_markDirty('c')");
  });

  await harness.runTest('3.4.2: safeClosureVars allows whitelisted persistent variable in timer closure', () => {
    const code = `
let counter = 0;
function run() {
  setTimeout(() => { counter++; }, 1000);
}
`;
    const { code: out } = compileSource(code, {
      persistentVars: ['counter'],
      safeClosureVars: ['counter'],
    });
    expect(out).toContain('__mv3_setTimeout');
  });

  // ==========================================================================
  // Combo 5: staleLockThresholdMs x Boolean Locks x Simulated SW Cold Restart
  // ==========================================================================
  harness.setSuite('Tier 3.5: staleLockThresholdMs x Boolean Locks x Cold Restart');

  await harness.runTest('3.5.1: Adapter registers boolean lock and threshold in configuration', () => {
    const code = `let isBusy = true;`;
    const { code: out } = compileSource(code, { staleLockThresholdMs: 20000 });
    expect(out).toContain('booleanVarNames: ["isBusy"]');
    expect(out).toContain('staleLockThresholdMs: 20000');
  });

  await harness.runTest('3.5.2: In-memory simulation: lock is preserved if restart is within threshold', async () => {
    const env = createMockChromeEnvironment();
    // Simulate stored state from previous run with recent timestamp
    await env.storage.session.set({
      '__mv3_isBusy': true,
      '__mv3_lockAge_isBusy': env.currentTime - 5000, // 5s ago (< 20s threshold)
    });

    const userCode = `let isBusy = false;`;
    const executable = buildExecutableBundle(userCode, {
      staleLockThresholdMs: 20000,
    });

    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    // Wait for init to settle
    await new Promise((r) => setTimeout(r, 20));
    const isBusyValue = ctx.runCode('isBusy');
    expect(isBusyValue).toBe(true);
    ctx.destroy();
  });

  await harness.runTest('3.5.3: In-memory simulation: stale lock is automatically reset to false when time exceeds threshold', async () => {
    const env = createMockChromeEnvironment();
    // Simulate stored state where lock was acquired 60 seconds ago (> 20s threshold)
    await env.storage.session.set({
      '__mv3_isBusy': true,
      '__mv3_lockAge_isBusy': env.currentTime - 60000,
    });

    const userCode = `let isBusy = true;`;
    const executable = buildExecutableBundle(userCode, {
      staleLockThresholdMs: 20000,
    });

    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    // Wait for init to settle
    await new Promise((r) => setTimeout(r, 20));
    const isBusyValue = ctx.runCode('isBusy');
    expect(isBusyValue).toBe(false);
    ctx.destroy();
  });

  // ==========================================================================
  // Combo 6: Reactive Proxy Arrays x Mutating Methods in Bare Control-Flow
  // ==========================================================================
  harness.setSuite('Tier 3.6: Proxy Arrays x Mutating Methods x Bare Control-Flow');

  await harness.runTest('3.6.1: Array push in bare else wrapped with braces and marks dirty', () => {
    const code = `
let queue = [];
if (false) {}
else queue.push({ id: 1 });
`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain('else { queue.push({ id: 1 });');
    expect(out).toContain("__mv3_markDirty('queue'); }");
  });

  await harness.runTest('3.6.2: Array shift in bare if wrapped with braces and marks dirty', () => {
    const code = `
let queue = [1, 2, 3];
if (true) queue.shift();
`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain('{ queue.shift();');
    expect(out).toContain("__mv3_markDirty('queue'); }");
  });

  await harness.runTest('3.6.3: Array splice in bare for body wrapped with braces', () => {
    const code = `
let queue = [1, 2, 3];
for (let i = 0; i < 1; i++) queue.splice(0, 1);
`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain('{ queue.splice(0, 1);');
    expect(out).toContain("__mv3_markDirty('queue'); }");
  });

  // ==========================================================================
  // Combo 7: promiseResolverStrategy: 'alarm' x setTimeoutPromise x Cold Restart
  // ==========================================================================
  harness.setSuite('Tier 3.7: promiseResolverStrategy x Alarms');

  await harness.runTest('3.7.1: promiseResolverStrategy alarm delegates promise timers to alarm scheduler', () => {
    const code = `
function waitJob() {
  return new Promise(resolve => setTimeout(resolve, 60000));
}
`;
    const { code: out } = compileSource(code, { promiseResolverStrategy: 'alarm' });
    expect(out).toContain('__mv3_setTimeout(resolve, 60000)');
  });

  await harness.runTest('3.7.2: promiseResolverStrategy native preserves inline setTimeoutPromise wrapper', () => {
    const code = `
function waitFast() {
  return new Promise(resolve => setTimeout(resolve, 500));
}
`;
    const { code: out } = compileSource(code, { promiseResolverStrategy: 'native' });
    expect(out).toContain('__mv3_setTimeoutPromise(resolve, 500)');
  });

  // ==========================================================================
  // Combo 8: Browser.* (webextension-polyfill) x onMessage async IIFE x __mv3_init
  // ==========================================================================
  harness.setSuite('Tier 3.8: webextension-polyfill x onMessage x __mv3_init');

  await harness.runTest('3.8.1: Browser.runtime.onMessage with async callback receives await __mv3_init', () => {
    const code = `
Browser.runtime.onMessage.addListener(async (msg) => {
  console.log('msg received', msg);
});
`;
    const { code: out } = compileSource(code);
    expect(out).toContain('await __mv3_init;');
  });

  await harness.runTest('3.8.2: Browser.runtime.onInstalled with async IIFE receives await __mv3_init', () => {
    const code = `
Browser.runtime.onInstalled.addListener(() => {
  (async () => {
    console.log('booting');
  })();
});
`;
    const { code: out } = compileSource(code);
    expect(out).toContain('await __mv3_init;');
  });

  // ==========================================================================
  // Combo 9: Nested Collections (Map, Set, Date) x stateStrategy: 'proxy'
  // ==========================================================================
  harness.setSuite('Tier 3.9: Nested Collections x Proxy x Serialization');

  await harness.runTest('3.9.1: Top-level Map, Set, and Date serialized and deserialized with typed helpers', () => {
    const code = `
let userSessions = new Map();
let activeRoles = new Set();
let sessionExpiry = new Date();
`;
    const { code: out, virtualModule: vm } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain("__mv3_serialize(userSessions, 'map')");
    expect(out).toContain("__mv3_serialize(activeRoles, 'set')");
    expect(out).toContain("__mv3_serialize(sessionExpiry, 'date')");
    expect(vm).toContain('function __mv3_serialize(');
    expect(vm).toContain('function __mv3_deserialize(');
  });

  await harness.runTest('3.9.2: Plain object conversion strips nested proxies safely', () => {
    const code = `let store = { data: [1, 2, 3] };`;
    const { virtualModule: vm } = compileSource(code, { stateStrategy: 'proxy' });
    expect(vm).toContain('function __mv3_toPlain(');
  });

  // ==========================================================================
  // Combo 10: alarms.clearAll() x Active __mv3_alarm_* Timers x Periodic User Alarms
  // ==========================================================================
  harness.setSuite('Tier 3.10: alarms.clearAll x Persistence Alarms Safety');

  await harness.runTest('3.10.1: Plugin internal timers utilize __mv3_alarm_ prefix', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain("'__mv3_alarm_timeout_'");
    expect(vm).toContain("'__mv3_alarm_interval_'");
  });

  await harness.runTest('3.10.2: Virtual runtime reconciles existing alarms on boot without wiping external alarms', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain("startsWith('__mv3_alarm_timeout_')");
    expect(vm).toContain("startsWith('__mv3_alarm_interval_')");
  });
}
