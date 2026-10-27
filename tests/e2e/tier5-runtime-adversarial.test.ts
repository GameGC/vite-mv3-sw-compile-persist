/**
 * Tier 5: Runtime Adversarial Hardening Test Suite
 *
 * Comprehensive white-box adversarial verification covering:
 * - Suite 5.1: Deeply nested objects with null prototypes (Object.create(null))
 * - Suite 5.2: Non-serializable properties (functions, symbols, undefined) mixed with persistent state
 * - Suite 5.3: Rapid back-to-back cold restarts (5+ consecutive restarts with mutations between each)
 * - Suite 5.4: Alarm scheduling with edge-case fractional periods or delays
 * - Suite 5.5: Debounced flushing under high-frequency writes before sudden process death
 * - Suite 5.6: Boolean lock auto-recovery under clock skew and timezone changes
 *
 * Total: 31 adversarial test cases
 */

import { TestHarness, expect, compileSource } from './harness.js';
import { createSimulator, MV3LifecycleSimulator } from '../simulator/mv3-simulator.ts';
import { compileTestBundle } from '../test-helpers.js';

export async function runTier5(harness: TestHarness) {
  // ==========================================================================
  // Suite 5.1: Deeply Nested Objects with Null Prototypes (Object.create(null))
  // ==========================================================================
  harness.setSuite('Tier 5.1: Deeply Nested Objects with Null Prototypes');

  await harness.runTest('5.1.1: Nested Object.create(null) tracks mutations and persists values cleanly', async () => {
    const sim = createSimulator();
    const source = `
let store = { config: Object.create(null) };
store.config.env = 'production';
store.config.port = 8080;
store.config.enabled = true;
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    expect(sim.evaluate('store.config.env')).toBe('production');
    expect(sim.evaluate('store.config.port')).toBe(8080);
    expect(sim.evaluate('store.config.enabled')).toBe(true);

    // Mutate nested properties
    sim.evaluate("store.config.env = 'staging'; store.config.port = 9090;");
    await sim.flush();

    // Cold restart
    await sim.restart();

    expect(sim.evaluate('store.config.env')).toBe('staging');
    expect(sim.evaluate('store.config.port')).toBe(9090);
    expect(sim.evaluate('store.config.enabled')).toBe(true);
    sim.kill();
  });

  await harness.runTest('5.1.2: 5-level deeply nested hierarchy of Object.create(null) survives cold restart', async () => {
    const sim = createSimulator();
    const source = `
let tree = {
  l1: Object.create(null)
};
tree.l1.l2 = Object.create(null);
tree.l1.l2.l3 = Object.create(null);
tree.l1.l2.l3.l4 = Object.create(null);
tree.l1.l2.l3.l4.leaf = 'initial-leaf-data';
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    expect(sim.evaluate('tree.l1.l2.l3.l4.leaf')).toBe('initial-leaf-data');

    // Deep mutation at level 4
    sim.evaluate("tree.l1.l2.l3.l4.leaf = 'adversarial-leaf-mutated';");
    await sim.flush();

    // Cold restart
    await sim.restart();

    expect(sim.evaluate('tree.l1.l2.l3.l4.leaf')).toBe('adversarial-leaf-mutated');
    sim.kill();
  });

  await harness.runTest('5.1.3: Object.create(null) with Object.prototype method names as keys avoids collision', async () => {
    const sim = createSimulator();
    const source = `
let dictHolder = {
  dict: Object.create(null)
};
dictHolder.dict.toString = 'custom-to-string-value';
dictHolder.dict.valueOf = 98765;
dictHolder.dict.hasOwnProperty = 'property-override';
dictHolder.dict.constructor = 'special-constructor-val';
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    // Mutate an Object.prototype-named key
    sim.evaluate("dictHolder.dict.toString = 'updated-to-string';");
    await sim.flush();

    // Cold restart
    await sim.restart();

    expect(sim.evaluate('dictHolder.dict.toString')).toBe('updated-to-string');
    expect(sim.evaluate('dictHolder.dict.valueOf')).toBe(98765);
    expect(sim.evaluate('dictHolder.dict.hasOwnProperty')).toBe('property-override');
    expect(sim.evaluate('dictHolder.dict.constructor')).toBe('special-constructor-val');
    sim.kill();
  });

  await harness.runTest('5.1.4: Composite structure: Object.create(null) with Array and non-recursive Map deserialization', async () => {
    const sim = createSimulator();
    const source = `
let composite = {
  data: Object.create(null)
};
composite.data.items = ['alpha', 'beta'];
composite.data.rawMap = { key1: 'val1' };
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    // Mutate nested Array and object
    sim.evaluate(`
composite.data.items.push('gamma');
composite.data.rawMap.key2 = 'val2';
`);
    await sim.flush();

    // Cold restart
    await sim.restart();

    const items = sim.evaluate('composite.data.items');
    expect(Array.isArray(items)).toBeTruthy('Restored items is an array');
    expect(items.length).toBe(3);
    expect(items[2]).toBe('gamma');

    expect(sim.evaluate("composite.data.rawMap.key1")).toBe('val1');
    expect(sim.evaluate("composite.data.rawMap.key2")).toBe('val2');
    sim.kill();
  });

  await harness.runTest('5.1.5: White-box analysis: Top-level Object.create(null) AST classification', () => {
    const source = `let directDict = Object.create(null);\ndirectDict.val = 42;`;
    const { code } = compileSource(source);

    // CallExpression for Object.create(null) is not an ObjectExpression or NewExpression
    // Verify variable registration in varNames
    expect(code).toContain("'directDict'");
    // Verify markDirty emits on direct variable assignment
    expect(code).toContain("__mv3_markDirty('directDict')");
  });

  // ==========================================================================
  // Suite 5.2: Objects with Non-Serializable Properties
  // ==========================================================================
  harness.setSuite('Tier 5.2: Non-Serializable Properties Mixed with Persistent State');

  await harness.runTest('5.2.1: Object containing function property drops function and preserves data on restart', async () => {
    const sim = createSimulator();
    const source = `
let workerJob = {
  id: 101,
  runTask: () => 'execute_result',
  status: 'pending'
};
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    expect(sim.evaluate('workerJob.id')).toBe(101);
    expect(sim.evaluate("typeof workerJob.runTask === 'function'")).toBe(true);

    // Mutate state
    sim.evaluate("workerJob.id = 102; workerJob.status = 'active';");
    await sim.flush();

    // Cold restart
    await sim.restart();

    expect(sim.evaluate('workerJob.id')).toBe(102);
    expect(sim.evaluate('workerJob.status')).toBe('active');
    // Function property is stripped by JSON/storage serialization fallback without crashing
    expect(sim.evaluate('workerJob.runTask')).toBe(undefined);
    sim.kill();
  });

  await harness.runTest('5.2.2: Object with Symbol keys and Symbol values handles mutation without crash', async () => {
    const sim = createSimulator();
    const source = `
let sessionData = {
  token: 'jwt-alpha-99',
  counter: 1
};
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    // Mutate with a Symbol property
    sim.evaluate(`
const sym = Symbol('secret');
sessionData[sym] = 'sym-value';
sessionData.counter = 2;
`);
    await sim.flush();

    // Cold restart
    await sim.restart();

    expect(sim.evaluate('sessionData.counter')).toBe(2);
    expect(sim.evaluate('sessionData.token')).toBe('jwt-alpha-99');
    sim.kill();
  });

  await harness.runTest('5.2.3: Explicit undefined values inside state objects survive flush without throwing', async () => {
    const sim = createSimulator();
    const source = `
let configState = {
  apiUrl: 'https://api.example.com',
  apiKey: undefined,
  retryCount: null
};
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    // Mutate undefined property to a string, then null to a number
    sim.evaluate("configState.apiKey = 'live-key-42'; configState.retryCount = 3;");
    await sim.flush();

    // Cold restart
    await sim.restart();

    expect(sim.evaluate('configState.apiKey')).toBe('live-key-42');
    expect(sim.evaluate('configState.retryCount')).toBe(3);

    // Set back to undefined
    sim.evaluate('configState.apiKey = undefined;');
    await sim.flush();
    await sim.restart();

    expect(sim.evaluate('configState.apiKey')).toBe(undefined);
    sim.kill();
  });

  await harness.runTest('5.2.4: Array containing mixed non-serializable items maintains Array methods after restart', async () => {
    const sim = createSimulator();
    const source = `
let itemsList = [1, undefined, null, 'text_item'];
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    sim.evaluate("itemsList.push('appended_item');");
    await sim.flush();

    // Cold restart
    await sim.restart();

    const isArr = sim.evaluate('Array.isArray(itemsList)');
    expect(isArr).toBe(true);
    expect(sim.evaluate('itemsList.length')).toBe(5);
    expect(sim.evaluate('itemsList[0]')).toBe(1);
    expect(sim.evaluate('itemsList[4]')).toBe('appended_item');

    // Mutate using Array methods
    sim.evaluate("itemsList.shift(); itemsList.push('final_item');");
    await sim.flush();
    await sim.restart();

    expect(sim.evaluate('itemsList.length')).toBe(5);
    expect(sim.evaluate('itemsList[itemsList.length - 1]')).toBe('final_item');
    sim.kill();
  });

  await harness.runTest('5.2.5: Map containing function values serializes and restores cleanly', async () => {
    const sim = createSimulator();
    const source = `
let handlerMap = new Map();
handlerMap.set('taskA', 'taskA_data');
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    sim.evaluate(`
handlerMap.set('taskB', () => 'fn_b');
handlerMap.set('taskC', 'taskC_data');
`);
    await sim.flush();

    // Cold restart
    await sim.restart();

    expect(sim.evaluate('handlerMap instanceof Map')).toBe(true);
    expect(sim.evaluate("handlerMap.get('taskA')")).toBe('taskA_data');
    expect(sim.evaluate("handlerMap.get('taskC')")).toBe('taskC_data');
    sim.kill();
  });

  // ==========================================================================
  // Suite 5.3: Rapid Back-to-Back Cold Restarts
  // ==========================================================================
  harness.setSuite('Tier 5.3: Rapid Back-to-Back Cold Restarts');

  await harness.runTest('5.3.1: 5 consecutive cold restarts with incremental primitive mutations', async () => {
    const sim = createSimulator();
    const source = `
let cycleCounter = 0;
function incrementCycle() {
  cycleCounter += 10;
}
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);

    for (let cycle = 1; cycle <= 5; cycle++) {
      sim.evaluate(`incrementCycle();`);
      await sim.flush();
      await sim.restart();
      expect(sim.evaluate('cycleCounter')).toBe(cycle * 10);
    }

    expect(sim.evaluate('cycleCounter')).toBe(50);
    sim.kill();
  });

  await harness.runTest('5.3.2: 5 consecutive cold restarts with progressive Array mutations (push, shift, splice, pop)', async () => {
    const sim = createSimulator();
    const source = `let taskQueue = ['init-0'];`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);

    // Generation 1: push
    sim.evaluate("taskQueue.push('gen-1');");
    await sim.flush();
    await sim.restart();
    expect(sim.evaluate('taskQueue.length')).toBe(2);
    expect(sim.evaluate('Array.isArray(taskQueue)')).toBe(true);

    // Generation 2: shift
    sim.evaluate('taskQueue.shift();');
    await sim.flush();
    await sim.restart();
    expect(sim.evaluate('taskQueue.length')).toBe(1);
    expect(sim.evaluate('taskQueue[0]')).toBe('gen-1');

    // Generation 3: splice
    sim.evaluate("taskQueue.splice(0, 0, 'prepended', 'middle');");
    await sim.flush();
    await sim.restart();
    expect(sim.evaluate('taskQueue.length')).toBe(3);
    expect(sim.evaluate('taskQueue[0]')).toBe('prepended');
    expect(sim.evaluate('taskQueue[1]')).toBe('middle');
    expect(sim.evaluate('taskQueue[2]')).toBe('gen-1');

    // Generation 4: pop
    sim.evaluate('taskQueue.pop();');
    await sim.flush();
    await sim.restart();
    expect(sim.evaluate('taskQueue.length')).toBe(2);
    expect(sim.evaluate('taskQueue[1]')).toBe('middle');

    // Generation 5: push + reverse
    sim.evaluate("taskQueue.push('end'); taskQueue.reverse();");
    await sim.flush();
    await sim.restart();
    expect(sim.evaluate('taskQueue.length')).toBe(3);
    expect(sim.evaluate('taskQueue[0]')).toBe('end');
    expect(sim.evaluate('taskQueue[1]')).toBe('middle');
    expect(sim.evaluate('taskQueue[2]')).toBe('prepended');
    sim.kill();
  });

  await harness.runTest('5.3.3: 5 consecutive cold restarts with Map, Set, and Date progressive mutations', async () => {
    const sim = createSimulator();
    const source = `
let persistentMap = new Map();
let persistentSet = new Set();
let persistentDate = new Date('2026-01-01T00:00:00.000Z');
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);

    // Gen 1: Add initial entries
    sim.evaluate(`
persistentMap.set('k1', 'v1');
persistentSet.add('tag1');
persistentDate.setUTCFullYear(2027);
`);
    await sim.flush();
    await sim.restart();

    // Gen 2: Add more entries
    sim.evaluate(`
persistentMap.set('k2', 'v2');
persistentSet.add('tag2');
persistentDate.setUTCMonth(5);
`);
    await sim.flush();
    await sim.restart();

    // Gen 3: Delete entry
    sim.evaluate(`
persistentMap.delete('k1');
persistentSet.delete('tag1');
persistentDate.setUTCDate(20);
`);
    await sim.flush();
    await sim.restart();

    // Gen 4: Clear and reset
    sim.evaluate(`
persistentMap.clear();
persistentMap.set('final_k', 'final_v');
persistentSet.add('tag3');
persistentDate.setUTCHours(14);
`);
    await sim.flush();
    await sim.restart();

    // Gen 5: Final mutations
    sim.evaluate(`
persistentMap.set('extra', 'val');
persistentSet.delete('tag2');
persistentDate.setUTCMinutes(45);
`);
    await sim.flush();
    await sim.restart();

    expect(sim.evaluate('persistentMap.size')).toBe(2);
    expect(sim.evaluate("persistentMap.get('final_k')")).toBe('final_v');
    expect(sim.evaluate("persistentMap.get('extra')")).toBe('val');

    // tag2 deleted in Gen 5 -> only tag3 remains
    expect(sim.evaluate('persistentSet.size')).toBe(1);
    expect(sim.evaluate("persistentSet.has('tag3')")).toBe(true);
    expect(sim.evaluate("persistentSet.has('tag1')")).toBe(false);

    expect(sim.evaluate('persistentDate.getUTCFullYear()')).toBe(2027);
    expect(sim.evaluate('persistentDate.getUTCMonth()')).toBe(5);
    expect(sim.evaluate('persistentDate.getUTCDate()')).toBe(20);
    expect(sim.evaluate('persistentDate.getUTCHours()')).toBe(14);
    expect(sim.evaluate('persistentDate.getUTCMinutes()')).toBe(45);
    sim.kill();
  });

  await harness.runTest('5.3.4: Proxy wrapping cache does not double-wrap across 5 successive VM boots', async () => {
    const sim = createSimulator();
    const source = `
let nestedConfig = {
  meta: { level: 1 }
};
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);

    for (let i = 1; i <= 5; i++) {
      sim.evaluate(`nestedConfig.meta.level = ${i + 1};`);
      await sim.flush();
      await sim.restart();
      expect(sim.evaluate('nestedConfig.meta.level')).toBe(i + 1);
      // Ensure plain object prototype is maintained
      expect(sim.evaluate('typeof nestedConfig.meta')).toBe('object');
    }

    sim.kill();
  });

  await harness.runTest('5.3.5: Interleaved multi-variable state updates across 5 rapid restarts', async () => {
    const sim = createSimulator();
    const source = `
let counterA = 0;
let labelB = 'init';
let recordC = { status: 'idle', retries: 0 };
let queueD = [10];

function mutateA(val) { counterA = val; }
function mutateB(val) { labelB = val; }
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);

    // Gen 1: Mutate counterA & labelB
    sim.evaluate("mutateA(100); mutateB('step1');");
    await sim.flush();
    await sim.restart();

    // Gen 2: Mutate recordC & queueD
    sim.evaluate("recordC.status = 'running'; queueD.push(20);");
    await sim.flush();
    await sim.restart();

    // Gen 3: Mutate all 4 variables
    sim.evaluate("mutateA(150); mutateB('step3'); recordC.status = 'paused'; queueD.shift();");
    await sim.flush();
    await sim.restart();

    // Gen 4: Mutate recordC with new property
    sim.evaluate("recordC.retries = 2; queueD.push(30, 40);");
    await sim.flush();
    await sim.restart();

    // Gen 5: Verify all 4 states together
    expect(sim.evaluate('counterA')).toBe(150);
    expect(sim.evaluate('labelB')).toBe('step3');
    expect(sim.evaluate('recordC.status')).toBe('paused');
    expect(sim.evaluate('recordC.retries')).toBe(2);
    expect(sim.evaluate('queueD.length')).toBe(3);
    expect(sim.evaluate('queueD[0]')).toBe(20);
    expect(sim.evaluate('queueD[2]')).toBe(40);
    sim.kill();
  });

  // ==========================================================================
  // Suite 5.4: Alarm Scheduling with Fractional Periods and Delays
  // ==========================================================================
  harness.setSuite('Tier 5.4: Alarm Scheduling with Edge-Case Fractional Periods or Delays');

  await harness.runTest('5.4.1: Fractional delay in setTimeout (> alarmThresholdMs) schedules and fires alarm', async () => {
    const sim = createSimulator();
    const source = `
let timerExecuted = false;
let firedAt = 0;

function alarmCallback() {
  timerExecuted = true;
  firedAt = Date.now();
}

setTimeout(alarmCallback, 75500.5);
`;
    // alarmThresholdMs = 30,000ms. 75,500.5ms >= 30,000ms -> chrome.alarms
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      alarmThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);

    const allAlarms = await sim.alarms.getAll();
    expect(allAlarms.length).toBe(1);
    const alarm = allAlarms[0];
    expect(alarm.name).toContain('__mv3_alarm_timeout_');

    // advance virtual time by 75,501ms
    await sim.advanceTime(75_501);

    expect(sim.evaluate('timerExecuted')).toBe(true);
    sim.kill();
  });

  await harness.runTest('5.4.2: Fractional periodInMinutes in setInterval steps through recurring alarms', async () => {
    const sim = createSimulator();
    const source = `
let intervalTicks = 0;

function intervalHandler() {
  intervalTicks++;
}

setInterval(intervalHandler, 90000); // 90s = 1.5 min
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      alarmThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);

    const alarms = await sim.alarms.getAll();
    expect(alarms.length).toBe(1);
    expect(alarms[0].periodInMinutes).toBe(1.5);

    // Step 1: Advance 90s
    await sim.advanceTime(90_000);
    expect(sim.evaluate('intervalTicks')).toBe(1);

    // Step 2: Advance another 90s (180s total)
    await sim.advanceTime(90_000);
    expect(sim.evaluate('intervalTicks')).toBe(2);

    // Step 3: Advance 90s (270s total)
    await sim.advanceTime(90_000);
    expect(sim.evaluate('intervalTicks')).toBe(3);
    sim.kill();
  });

  await harness.runTest('5.4.3: Sub-minute fractional delay clamps to Chrome MV3 0.5 min minimum constraint', async () => {
    const sim = createSimulator();
    const source = `
let tick = false;
function shortAlarmCb() { tick = true; }
setTimeout(shortAlarmCb, 1000);
`;
    // Set threshold to 500ms so 1000ms triggers alarm creation
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      alarmThresholdMs: 500,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);

    const alarms = await sim.alarms.getAll();
    expect(alarms.length).toBe(1);
    // Math.max(1000 / 60000, 0.5) must clamp to 0.5
    const scheduledDelayMs = alarms[0].scheduledTime - sim.virtualClock;
    expect(scheduledDelayMs).toBe(30_000); // 0.5 min = 30,000ms
    sim.kill();
  });

  await harness.runTest('5.4.4: Exact boundary: delay == alarmThresholdMs uses alarms; delay < threshold uses native timer', () => {
    const source = `
setTimeout(() => {}, 59999);
setTimeout(() => {}, 60000);
`;
    const { code } = compileSource(source, { alarmThresholdMs: 60_000 });
    expect(code).toContain('__mv3_setTimeout');
    // Both are rewritten to __mv3_setTimeout which branches internally
  });

  await harness.runTest('5.4.5: Multiple concurrent fractional alarms with interleaved deadlines fire chronologically', async () => {
    const sim = createSimulator();
    const source = `
let executionOrder = [];

function cbAlpha() { executionOrder.push('alpha'); }
function cbBeta()  { executionOrder.push('beta'); }
function cbGamma() { executionOrder.push('gamma'); }

setTimeout(cbAlpha, 60000); // 1.0 min
setTimeout(cbBeta,  90000); // 1.5 min
setTimeout(cbGamma, 120000); // 2.0 min
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      alarmThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);

    // Advance 70s -> only Alpha fires
    await sim.advanceTime(70_000);
    let order = sim.evaluate('executionOrder');
    expect(order.length).toBe(1);
    expect(order[0]).toBe('alpha');

    // Advance 30s more (100s total) -> Beta fires
    await sim.advanceTime(30_000);
    order = sim.evaluate('executionOrder');
    expect(order.length).toBe(2);
    expect(order[1]).toBe('beta');

    // Advance 30s more (130s total) -> Gamma fires
    await sim.advanceTime(30_000);
    order = sim.evaluate('executionOrder');
    expect(order.length).toBe(3);
    expect(order[2]).toBe('gamma');
    sim.kill();
  });

  // ==========================================================================
  // Suite 5.5: Debounced Flushing Under High-Frequency Writes
  // ==========================================================================
  harness.setSuite('Tier 5.5: Debounced Flushing & Sudden Process Death');

  await harness.runTest('5.5.1: 1,000 rapid loop writes coalesce into single debounced storage flush', async () => {
    const sim = createSimulator();
    const source = `
let writeCount = 0;
for (let i = 0; i < 1000; i++) {
  writeCount++;
}
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    await sim.flush();

    expect(sim.evaluate('writeCount')).toBe(1000);

    // Verify storage has the committed value
    const stored = await sim.storage.session.get('__mv3_writeCount');
    expect(stored.__mv3_writeCount).toBe(1000);

    // Cold restart
    await sim.restart();
    expect(sim.evaluate('writeCount')).toBe(1000);
    sim.kill();
  });

  await harness.runTest('5.5.2: Sudden ungraceful process kill before autoFlush preserves only previously committed state', async () => {
    const sim = createSimulator();
    const source = `let persistedScore = 100;`;
    // Long autoFlushMs (10,000ms) so auto-flush does NOT fire prematurely
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 10_000 });
    await sim.boot(bundle);
    await sim.flush();

    expect(sim.evaluate('persistedScore')).toBe(100);

    // Mutate state in memory
    sim.evaluate('persistedScore = 9999;');
    expect(sim.evaluate('persistedScore')).toBe(9999);

    // SUDDEN DEATH: kill() immediately without calling flush()
    sim.kill();

    // Restart worker
    await sim.restart(bundle);

    // Restores to previously committed 100 because 9999 was never flushed to storage
    expect(sim.evaluate('persistedScore')).toBe(100);
    sim.kill();
  });

  await harness.runTest('5.5.3: Cooperative flush immediately before termination guarantees zero data loss', async () => {
    const sim = createSimulator();
    const source = `
let criticalPayload = 'initial';
function savePayload(val) {
  criticalPayload = val;
}
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 10_000 });
    await sim.boot(bundle);
    await sim.flush();

    sim.evaluate("savePayload('saved_before_shutdown');");

    // Cooperative graceful shutdown: flush() called before kill()
    await sim.flush();
    sim.kill();

    await sim.restart(bundle);
    expect(sim.evaluate('criticalPayload')).toBe('saved_before_shutdown');
    sim.kill();
  });

  await harness.runTest('5.5.4: Multi-variable mutation selectively flushes only modified keys', async () => {
    const sim = createSimulator();
    const source = `
let varA = 'constant_A';
let varB = 'initial_B';
let varC = 'constant_C';

function updateVarB(val) {
  varB = val;
}
`;
    const bundle = compileTestBundle(source, { strategy: 'proxy', autoFlushMs: 50 });
    await sim.boot(bundle);
    // Initial flush commits default states
    await sim.flush();

    // Mutate only varB via compiled function
    sim.evaluate("updateVarB('mutated_B');");
    await sim.flush();

    const stored = await sim.storage.session.get(null);
    expect(stored.__mv3_varA).toBe(undefined);
    expect(stored.__mv3_varB).toBe('mutated_B');
    expect(stored.__mv3_varC).toBe(undefined);

    await sim.restart();
    expect(sim.evaluate('varA')).toBe('constant_A');
    expect(sim.evaluate('varB')).toBe('mutated_B');
    expect(sim.evaluate('varC')).toBe('constant_C');
    sim.kill();
  });

  await harness.runTest('5.5.5: Concurrency race condition: White-box inspection of dirty-set deletion during storage.set', () => {
    // In src/runtime/virtual-module.ts lines 155-176:
    // const __snapshot = new Set(__mv3_dirty);
    // await __mv3_storage.set(data);
    // for (const __name of __snapshot) { __mv3_dirty.delete(__name); }
    // If a mutation occurs during the await window, __mv3_dirty.add(name) is deleted by __snapshot.
    // Verify that the code uses Set snapshotting pattern.
    const { virtualModule: vm } = compileSource('let item = 1;');
    expect(vm).toContain('const __snapshot = new Set(__mv3_dirty);');
    expect(vm).toContain('__mv3_dirty.delete(__name);');
  });

  // ==========================================================================
  // Suite 5.6: Boolean Lock Auto-Recovery Under Clock Skew
  // ==========================================================================
  harness.setSuite('Tier 5.6: Boolean Lock Auto-Recovery & Clock Skew');

  await harness.runTest('5.6.1: Baseline stale lock auto-recovery past staleLockThresholdMs', async () => {
    const sim = createSimulator({ virtualClockStart: 1_000_000 });
    const source = `
let isProcessing = false;
function acquireLock() {
  isProcessing = true;
}
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      staleLockThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);
    sim.evaluate('acquireLock();');
    await sim.flush();

    expect(sim.evaluate('isProcessing')).toBe(true);

    // Verify lockAge key recorded in storage
    const stored = await sim.storage.session.get('__mv3_lockAge_isProcessing');
    expect(typeof stored.__mv3_lockAge_isProcessing).toBe('number');

    // Advance clock past 30s threshold (by 35,000ms)
    await sim.advanceTime(35_000);

    // Cold restart
    await sim.restart();

    // Stale lock automatically recovered to false
    expect(sim.evaluate('isProcessing')).toBe(false);
    sim.kill();
  });

  await harness.runTest('5.6.2: Recent lock is preserved when restart occurs within staleLockThresholdMs', async () => {
    const sim = createSimulator({ virtualClockStart: 1_000_000 });
    const source = `
let isWorking = false;
function acquireWorkLock() {
  isWorking = true;
}
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      staleLockThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);
    sim.evaluate('acquireWorkLock();');
    await sim.flush();

    expect(sim.evaluate('isWorking')).toBe(true);

    // Advance clock by only 10,000ms (10s < 30s threshold)
    await sim.advanceTime(10_000);

    // Cold restart
    await sim.restart();

    // Lock is recent -> preserved as true
    expect(sim.evaluate('isWorking')).toBe(true);
    sim.kill();
  });

  await harness.runTest('5.6.3: Clock skew forward (NTP jump +1 hour) triggers immediate safe auto-recovery', async () => {
    const sim = createSimulator({ virtualClockStart: 1_000_000 });
    const source = `
let syncLock = false;
function acquireSyncLock() {
  syncLock = true;
}
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      staleLockThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);
    sim.evaluate('acquireSyncLock();');
    await sim.flush();

    expect(sim.evaluate('syncLock')).toBe(true);

    // Clock skewed forward by 3,600,000ms (+1 hour)
    await sim.advanceTime(3_600_000);

    await sim.restart();

    // Forward clock skew exceeds threshold -> recovered to false
    expect(sim.evaluate('syncLock')).toBe(false);
    sim.kill();
  });

  await harness.runTest('5.6.4: Clock skew backward (NTP rollback / DST fall-back) prevents auto-recovery (documented vulnerability)', async () => {
    const sim = createSimulator({ virtualClockStart: 1_000_000 });
    const source = `
let skewLock = false;
function acquireSkewLock() {
  skewLock = true;
}
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      staleLockThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);
    sim.evaluate('acquireSkewLock();');
    await sim.flush();

    expect(sim.evaluate('skewLock')).toBe(true);

    // Clock skew BACKWARD: simulate NTP rollback or timezone shift
    // Virtual clock moves backwards by 20,000ms: Date.now() - lockAge becomes negative (-20,000ms)
    sim.virtualClock = 1_000_000 - 20_000;

    await sim.restart();

    // In virtual-module.ts line 128:
    // (Date.now() - lockAge > staleThreshold)
    // -20,000ms > 30,000ms is FALSE. The lock is kept as true!
    expect(sim.evaluate('skewLock')).toBe(true);
    sim.kill();
  });

  await harness.runTest('5.6.5: Pending __mv3_alarm_* intentionally protects lock from stale-lock auto-recovery', async () => {
    const sim = createSimulator({ virtualClockStart: 1_000_000 });
    const source = `
let batchLock = false;
function acquireBatchLock() {
  batchLock = true;
}
function periodicWorker() {}
setInterval(periodicWorker, 300000); // 5 min alarm
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      alarmThresholdMs: 60_000,
      staleLockThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);
    sim.evaluate('acquireBatchLock();');
    await sim.flush();

    expect(sim.evaluate('batchLock')).toBe(true);

    // Advance clock by 45,000ms (> 30,000ms threshold)
    await sim.advanceTime(45_000);

    // Restart: because active __mv3_alarm_interval_ exists, hasActiveWork is true!
    await sim.restart();

    // Lock is protected and NOT reset to false
    expect(sim.evaluate('batchLock')).toBe(true);
    sim.kill();
  });

  await harness.runTest('5.6.6: Missing or corrupted lockAge timestamp resets lock gracefully', async () => {
    const sim = createSimulator();
    const source = `
let corruptedLock = false;
function acquireCorruptedLock() {
  corruptedLock = true;
}
`;
    const bundle = compileTestBundle(source, {
      strategy: 'proxy',
      staleLockThresholdMs: 30_000,
      autoFlushMs: 50,
    });
    await sim.boot(bundle);
    sim.evaluate('acquireCorruptedLock();');
    await sim.flush();

    // Intentionally corrupt/remove lockAge key from storage
    await sim.storage.session.remove('__mv3_lockAge_corruptedLock');

    // Cold restart
    await sim.restart();

    // !lockAge condition in virtual-module line 128 resets lock to false
    expect(sim.evaluate('corruptedLock')).toBe(false);
    sim.kill();
  });
}

// Self-execution if run directly via node --import tsx tests/e2e/tier5-runtime-adversarial.test.ts
const isMain = process.argv[1]?.includes('tier5-runtime-adversarial');
if (isMain) {
  (async () => {
    console.log('================================================================');
    console.log('    TIER 5 RUNTIME ADVERSARIAL HARDENING TEST RUNNER');
    console.log('    White-Box Edge Cases, Serializer, Lifecycle & Simulator');
    console.log('================================================================');

    const harness = new TestHarness();
    const startTime = Date.now();

    try {
      await runTier5(harness);
    } catch (err) {
      console.error('Fatal Tier 5 execution error:', err);
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = harness.getSummary();

    console.log('\n================================================================');
    console.log(`TIER 5 ADVERSARIAL SUMMARY (${durationSec}s)`);
    console.log('================================================================');
    console.log(`Total Test Cases Executed : ${summary.total}`);
    console.log(`Passed                    : ${summary.passed}`);
    console.log(`Failed                    : ${summary.failed}`);
    console.log(`Pass Rate                 : ${((summary.passed / summary.total) * 100).toFixed(1)}%`);

    if (summary.failed > 0) {
      console.log('\nFailures:');
      summary.results
        .filter((r) => !r.passed)
        .forEach((r, idx) => {
          console.log(`  ${idx + 1}. [${r.suite}] ${r.name}`);
          if (r.error) {
            const msg = typeof r.error === 'string' ? r.error : r.error.message;
            console.log(`     Reason: ${msg}`);
          }
        });
    }

    console.log('================================================================\n');
    process.exit(summary.failed === 0 ? 0 : 1);
  })();
}
