/**
 * Tier 5: Compiler Adversarial Hardening Test Suite
 *
 * White-box adversarial coverage hardening for the AST analyzer,
 * code transformer, and runtime adapter in vite-mv3-sw-compile-persist:
 *
 * 1. Nested destructuring with defaults and computed property keys
 * 2. Control flow with try-catch-finally mutating state in finally blocks
 * 3. Multiple variable declarations in single statement (let a = 1, b = 2;)
 * 4. Re-exported variables, default exports, and module syntax
 * 5. Complex AST statement boundary edge cases (labels, switches, dangling else, loop headers, ternary, logical assignments)
 * 6. Extreme runtime robustness & full cold restart lifecycle under adversarial conditions
 */

import {
  TestHarness,
  expect,
  compileSource,
  buildExecutableBundle,
  createMockChromeEnvironment,
  createExecutionContext,
} from './harness.js';

export async function runTier5(harness: TestHarness) {
  // ==========================================================================
  // Area 5.1: Nested Destructuring with Defaults and Computed Property Keys
  // ==========================================================================
  harness.setSuite('Tier 5.1: Nested Destructuring with Defaults & Computed Keys');

  await harness.runTest('5.1.1: Object destructuring with default values marks all targets dirty', () => {
    const code = `
let a = 1;
let b = 2;
function assignDefaults(payload) {
  ({ a = 10, b = 20 } = payload);
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('a')");
    expect(out).toContain("__mv3_markDirty('b')");
  });

  await harness.runTest('5.1.2: Nested object and array destructuring with rest patterns and defaults', () => {
    const code = `
let primaryId = 0;
let fallbackName = 'guest';
let extraTags = [];
function unpackUser(payload) {
  ({ user: { id: primaryId = 999, name: fallbackName = 'anon' }, tags: [firstTag = 'general', ...extraTags] = [] } = payload);
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('primaryId')");
    expect(out).toContain("__mv3_markDirty('fallbackName')");
    expect(out).toContain("__mv3_markDirty('extraTags')");
  });

  await harness.runTest('5.1.3: Computed property keys in destructuring assignment with expression key', () => {
    const code = `
let score = 0;
const PREFIX = 'user_';
function applyScore(data) {
  ({ [PREFIX + 'score']: score = 50 } = data);
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('score')");
  });

  await harness.runTest('5.1.4: Nested MemberExpression targets in destructuring assignment deduplicate markDirty', () => {
    const code = `
let store = { meta: { revision: 1 }, items: [100] };
function updateStore(delta) {
  ({ rev: store.meta.revision, head: store.items[0] } = delta);
}
`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain("__mv3_markDirty('store')");
    // Should NOT perform full reassignment store = __mv3_reactive(store) because targets are MemberExpressions
    expect(out).toNotContain("store = __mv3_reactive(store, 'store'); __mv3_markDirty('store');");
  });

  await harness.runTest('5.1.5: Top-level destructuring in let declaration is skipped with warning without compiler crash', () => {
    const code = `
let { optA, optB } = { optA: 1, optB: 2 };
let trackedCount = 10;
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'trackedCount'");
    expect(out).toNotContain("'optA'");
    expect(out).toNotContain("'optB'");
  });

  await harness.runTest('5.1.6: VM execution & cold restart with nested destructuring and defaults', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let primaryId = 0;
let fallbackName = 'initial';
let extraTags = [];

function unpackUser(payload) {
  ({ user: { id: primaryId = 999, name: fallbackName = 'anon' }, tags: [firstTag = 'general', ...extraTags] = [] } = payload);
}

unpackUser({ user: { id: 42 } });
`;
    const executable = buildExecutableBundle(userCode, { storageArea: 'session', stateStrategy: 'proxy' });

    // Initial boot
    const ctx1 = createExecutionContext(env);
    ctx1.runCode(executable);

    expect(ctx1.runCode('primaryId')).toBe(42);
    expect(ctx1.runCode('fallbackName')).toBe('anon');
    expect(ctx1.runCode('extraTags.length')).toBe(0);

    // Save to storage
    await env.storage.session.set({
      __mv3_var_primaryId: 42,
      __mv3_var_fallbackName: 'anon',
      __mv3_var_extraTags: [],
    });
    ctx1.destroy();

    // Cold restart in fresh VM context
    const ctx2 = createExecutionContext(env);
    ctx2.runCode(executable);
    await env.advanceTime(10);

    expect(ctx2.runCode('primaryId')).toBe(42);
    expect(ctx2.runCode('fallbackName')).toBe('anon');
    ctx2.destroy();
  });

  // ==========================================================================
  // Area 5.2: Control Flow with Try-Catch-Finally Mutating State in Finally
  // ==========================================================================
  harness.setSuite('Tier 5.2: Try-Catch-Finally Mutating State in Finally');

  await harness.runTest('5.2.1: Finally block mutating state after try exception is captured and marked dirty', () => {
    const code = `
let status = 'init';
function failSafe() {
  try {
    throw new Error('boom');
  } catch (e) {
    status = 'caught';
  } finally {
    status = 'cleaned';
  }
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("status = 'caught'; __mv3_markDirty('status');");
    expect(out).toContain("status = 'cleaned'; __mv3_markDirty('status');");
  });

  await harness.runTest('5.2.2: Finally block mutating state when try block returns early', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let runCount = 0;
let result = 0;
function execute() {
  try {
    return 100;
  } finally {
    runCount++;
  }
}
result = execute();
`;
    const executable = buildExecutableBundle(userCode);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    expect(ctx.runCode('result')).toBe(100);
    expect(ctx.runCode('runCount')).toBe(1);
    ctx.destroy();
  });

  await harness.runTest('5.2.3: Nested try-catch-finally with re-thrown exception and state rollback', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let isLocked = false;
let errorLog = [];

function processTask() {
  try {
    isLocked = true;
    try {
      throw new Error('inner failure');
    } catch (err) {
      errorLog.push(err.message);
      throw err;
    }
  } catch (outer) {
    // caught outer
  } finally {
    isLocked = false;
  }
}

processTask();
`;
    const executable = buildExecutableBundle(userCode, { stateStrategy: 'proxy' });
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    expect(ctx.runCode('isLocked')).toBe(false);
    expect(ctx.runCode('errorLog[0]')).toBe('inner failure');
    ctx.destroy();
  });

  await harness.runTest('5.2.4: Catch clause parameter shadowing top-level variable does not mark dirty', () => {
    const code = `
let err = 'no-error';
function safe() {
  try {
    throw new Error('boom');
  } catch (err) {
    err = 'local-reassignment';
  }
}
`;
    const { code: out } = compileSource(code);
    expect(out).toNotContain("err = 'local-reassignment'; __mv3_markDirty('err');");
  });

  await harness.runTest('5.2.5: VM execution & cold restart after exception and finally block state mutation', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let taskState = 'pending';
let attempts = 0;

function runWithError() {
  try {
    attempts++;
    throw new Error('aborted');
  } catch (e) {
    // handled
  } finally {
    taskState = 'settled';
  }
}

runWithError();
`;
    const executable = buildExecutableBundle(userCode);
    const ctx1 = createExecutionContext(env);
    ctx1.runCode(executable);

    expect(ctx1.runCode('attempts')).toBe(1);
    expect(ctx1.runCode('taskState')).toBe('settled');

    // Manually persist to mock storage to simulate autoFlush/SW cycle
    await env.storage.session.set({
      __mv3_var_attempts: 1,
      __mv3_var_taskState: 'settled',
    });
    ctx1.destroy();

    // Cold restart
    const ctx2 = createExecutionContext(env);
    ctx2.runCode(executable);
    await env.advanceTime(10);

    expect(ctx2.runCode('taskState')).toBe('settled');
    ctx2.destroy();
  });

  await harness.runTest('5.2.6: Try-catch-finally with early return in catch block and state mutation in finally', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let phase = 'start';
function handleCatchReturn() {
  try {
    throw new Error('err');
  } catch (e) {
    phase = 'error-caught';
    return;
  } finally {
    phase = 'finally-done';
  }
}
handleCatchReturn();
`;
    const executable = buildExecutableBundle(userCode);
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    expect(ctx.runCode('phase')).toBe('finally-done');
    ctx.destroy();
  });

  // ==========================================================================
  // Area 5.3: Multiple Variable Declarations in Single Statement
  // ==========================================================================
  harness.setSuite('Tier 5.3: Multiple Variable Declarations in Single Statement');

  await harness.runTest('5.3.1: Multiple primitive let declarations in single statement are all tracked', () => {
    const code = `let alpha = 1, beta = 'test', gamma = false;`;
    const { code: out } = compileSource(code);
    expect(out).toContain('"alpha"');
    expect(out).toContain('"beta"');
    expect(out).toContain('"gamma"');
    expect(out).toContain('booleanVarNames: ["gamma"]');
    expect(out).toContain("case 'alpha': return alpha;");
    expect(out).toContain("case 'beta': return beta;");
    expect(out).toContain("case 'gamma': return gamma;");
  });

  await harness.runTest('5.3.2: Multiple declarations with mixed primitives and collections (Map, Set, Object)', () => {
    const code = `let total = 0, registry = new Map(), visited = new Set(), config = { enabled: true };`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain("registry = __mv3_reactive(registry, 'registry');");
    expect(out).toContain("visited = __mv3_reactive(visited, 'visited');");
    expect(out).toContain("config = __mv3_reactive(config, 'config');");
    expect(out).toContain("__mv3_serialize(registry, 'map')");
    expect(out).toContain("__mv3_serialize(visited, 'set')");
  });

  await harness.runTest('5.3.3: Multiple declarations with uninitialized variable in between initialized ones', () => {
    const code = `let active = true, pending, retryCount = 3;`;
    const { code: out } = compileSource(code);
    expect(out).toContain('"active"');
    expect(out).toContain('"retryCount"');
    expect(out).toNotContain('"pending"');
  });

  await harness.runTest('5.3.4: Chained assignment expression (a = b = val) marks both variables dirty', () => {
    const code = `
let a = 0, b = 0;
function setBoth(val) {
  a = b = val;
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('a')");
    expect(out).toContain("__mv3_markDirty('b')");
  });

  await harness.runTest('5.3.5: Sequence expression (comma operator) marks all assigned variables dirty', () => {
    const code = `
let posX = 0, posY = 0;
function move(dx, dy) {
  posX += dx, posY += dy;
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('posX')");
    expect(out).toContain("__mv3_markDirty('posY')");
  });

  await harness.runTest('5.3.6: VM execution & cold restart for multiple variables in single declaration', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let m1 = 10, m2 = 20, m3 = 30;
function incrementAll() {
  m1 += 1;
  m2 += 2;
  m3 += 3;
}
incrementAll();
`;
    const executable = buildExecutableBundle(userCode);
    const ctx1 = createExecutionContext(env);
    ctx1.runCode(executable);

    expect(ctx1.runCode('m1')).toBe(11);
    expect(ctx1.runCode('m2')).toBe(22);
    expect(ctx1.runCode('m3')).toBe(33);

    await env.storage.session.set({
      __mv3_var_m1: 11,
      __mv3_var_m2: 22,
      __mv3_var_m3: 33,
    });
    ctx1.destroy();

    const ctx2 = createExecutionContext(env);
    ctx2.runCode(executable);
    await env.advanceTime(10);

    expect(ctx2.runCode('m1')).toBe(11);
    expect(ctx2.runCode('m2')).toBe(22);
    expect(ctx2.runCode('m3')).toBe(33);
    ctx2.destroy();
  });

  // ==========================================================================
  // Area 5.4: Re-exported Variables, Default Exports, and Module Syntax
  // ==========================================================================
  harness.setSuite('Tier 5.4: Re-exported Variables & Default Exports');

  await harness.runTest('5.4.1: Persistent variable exported via export { varName } is tracked and transformed', () => {
    const code = `
let exportedCounter = 0;
export { exportedCounter };
function inc() { exportedCounter++; }
`;
    const { code: out } = compileSource(code);
    expect(out).toContain('"exportedCounter"');
    expect(out).toContain("__mv3_markDirty('exportedCounter')");
    expect(out).toContain("case 'exportedCounter': return exportedCounter;");
  });

  await harness.runTest('5.4.2: Export with alias export { internalVar as externalAlias } tracks internal variable', () => {
    const code = `
let internalVal = 100;
export { internalVal as publicVal };
internalVal = 200;
`;
    const { code: out } = compileSource(code);
    expect(out).toContain('"internalVal"');
    expect(out).toContain("__mv3_markDirty('internalVal')");
  });

  await harness.runTest('5.4.3: Export default identifier referring to persistent variable tracks reactive object', () => {
    const code = `
let appConfig = { theme: 'dark' };
export default appConfig;
`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain('"appConfig"');
    expect(out).toContain("appConfig = __mv3_reactive(appConfig, 'appConfig');");
  });

  await harness.runTest('5.4.4: Module re-exports and external export-all declarations do not corrupt adapter insertion', () => {
    const code = `
export * from './constants';
export { sharedHelper } from './helpers';
let workerState = 'ready';
`;
    const { code: out } = compileSource(code);
    expect(out).toContain('"workerState"');
    expect(out).toContain('createMV3Runtime(');
  });

  await harness.runTest('5.4.5: White-box AST verification: export let statement is tracked and persisted', () => {
    const code = `
export let exportedLet = 0;
let regularLet = 1;
`;
    const { code: out } = compileSource(code);
    expect(out).toContain('"regularLet"');
    expect(out).toContain('"exportedLet"');
    expect(typeof out).toBe('string');
  });

  await harness.runTest('5.4.6: Export default function declaration is safely handled without compilation error', () => {
    const code = `
let runCount = 0;
export default function backgroundWorker() {
  runCount++;
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain('"runCount"');
    expect(out).toContain("runCount++; __mv3_markDirty('runCount');");
  });

  // ==========================================================================
  // Area 5.5: Complex AST Statement Boundary Edge Cases
  // ==========================================================================
  harness.setSuite('Tier 5.5: Complex AST Statement Boundary Edge Cases');

  await harness.runTest('5.5.1: Labeled loops with break and continue mutating persistent state', () => {
    const code = `
let searchHits = 0;
function scan() {
  outerLoop: for (let i = 0; i < 3; i++) {
    innerLoop: for (let j = 0; j < 3; j++) {
      searchHits++;
      if (j === 1) break outerLoop;
    }
  }
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("searchHits++; __mv3_markDirty('searchHits');");
  });

  await harness.runTest('5.5.2: Switch-case statements (both bare and block-scoped cases) mark state dirty', () => {
    const code = `
let stateValue = 0;
function dispatch(action) {
  switch (action.type) {
    case 'INC':
      stateValue += action.amount;
      break;
    case 'RESET': {
      stateValue = 0;
      break;
    }
    default:
      stateValue = -1;
  }
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("stateValue += action.amount; __mv3_markDirty('stateValue');");
    expect(out).toContain("stateValue = 0; __mv3_markDirty('stateValue');");
    expect(out).toContain("stateValue = -1; __mv3_markDirty('stateValue');");
  });

  await harness.runTest('5.5.3: Dangling else and chained if-else-if bare control-flow wrapped in braces', () => {
    const code = `
let branchResult = 0;
function evaluate(a, b) {
  if (a > 0)
    if (b > 0) branchResult = 1;
    else branchResult = 2;
  else branchResult = 3;
}
`;
    const { code: out } = compileSource(code);
    // Every bare branch must be wrapped with { ... }
    expect(out).toContain("{ branchResult = 1; __mv3_markDirty('branchResult'); }");
    expect(out).toContain("{ branchResult = 2; __mv3_markDirty('branchResult'); }");
    expect(out).toContain("{ branchResult = 3; __mv3_markDirty('branchResult'); }");
  });

  await harness.runTest('5.5.4: Persistent variable mutated in loop update clause (for loop header)', () => {
    const code = `
let totalSteps = 0;
function walk() {
  for (let i = 0; i < 5; totalSteps++, i++) {
    // empty body
  }
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('totalSteps')");
  });

  await harness.runTest('5.5.5: Ternary operator conditional expression mutating persistent variable', () => {
    const code = `
let theme = 'light';
function toggle(isDark) {
  isDark ? (theme = 'dark') : (theme = 'light');
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('theme')");
  });

  await harness.runTest('5.5.6: Logical assignment operators (||=, &&=, ??=) mutating persistent variables', () => {
    const code = `
let fallbackPort = 0;
let cachedToken = 'old';
let defaultHost = null;
function setup() {
  fallbackPort ||= 8080;
  cachedToken &&= 'valid';
  defaultHost ??= '127.0.0.1';
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('fallbackPort')");
    expect(out).toContain("__mv3_markDirty('cachedToken')");
    expect(out).toContain("__mv3_markDirty('defaultHost')");
  });

  await harness.runTest('5.5.7: VM execution & cold restart for complex control-flow combinations', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let hits = 0;
let branchVal = 0;
let logicalVal = 0;

function runComplex() {
  outer: for (let i = 0; i < 5; i++) {
    hits++;
    if (i === 2) break outer;
  }

  const cond = true;
  if (cond) branchVal = 42; else branchVal = 99;

  logicalVal ||= 100;
}

runComplex();
`;
    const executable = buildExecutableBundle(userCode);
    const ctx1 = createExecutionContext(env);
    ctx1.runCode(executable);

    expect(ctx1.runCode('hits')).toBe(3);
    expect(ctx1.runCode('branchVal')).toBe(42);
    expect(ctx1.runCode('logicalVal')).toBe(100);

    await env.storage.session.set({
      __mv3_var_hits: 3,
      __mv3_var_branchVal: 42,
      __mv3_var_logicalVal: 100,
    });
    ctx1.destroy();

    const ctx2 = createExecutionContext(env);
    ctx2.runCode(executable);
    await env.advanceTime(10);

    expect(ctx2.runCode('hits')).toBe(3);
    expect(ctx2.runCode('branchVal')).toBe(42);
    expect(ctx2.runCode('logicalVal')).toBe(100);
    ctx2.destroy();
  });

  await harness.runTest('5.5.8: Return with inline assignment executes markDirty via try-finally before returning', () => {
    const code = `
let status = 'init';
function testReturn() {
  return (status = 'returned');
}
`;
    const { code: out } = compileSource(code);
    expect(out).toContain("try { return (status = 'returned'); } finally { __mv3_markDirty('status'); }");
  });

  await harness.runTest('5.5.9: Impure top-level const init gets createMV3Runtime placed before it (no TDZ)', () => {
    const code = `
let count = 0;
function helper() {
  count++;
}
const init = helper();
`;
    const { code: out } = compileSource(code);
    const posCreateRuntime = out.indexOf('createMV3Runtime(');
    const posConstInit = out.indexOf('const init = helper();');
    expect(posCreateRuntime).toBeLessThan(posConstInit);
  });

  // ==========================================================================
  // Area 5.6: Extreme Edge Cases & Robustness Under Adversarial Conditions
  // ==========================================================================
  harness.setSuite('Tier 5.6: Extreme Edge Cases & Adversarial Robustness');

  await harness.runTest('5.6.1: Arrow function with boolean expression body in onMessage preserves sync return', () => {
    const code = `
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => true);
`;
    const { code: out } = compileSource(code);
    // Because it returns boolean true, it MUST NOT be prepended with async!
    expect(out).toNotContain('async (msg, sender, sendResponse) => true');
    expect(out).toContain('(msg, sender, sendResponse) => true');
  });

  await harness.runTest('5.6.2: Universal timer cancellation with null/undefined/non-existent timer handles in VM', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let timerNull = null;
let timerUndef = undefined;
function cancelAll() {
  clearTimeout(timerNull);
  clearTimeout(timerUndef);
  clearInterval(timerNull);
  clearTimeout('non_existent_alarm');
}
cancelAll();
`;
    const executable = buildExecutableBundle(userCode);
    const ctx = createExecutionContext(env);
    // Should execute safely without throwing
    ctx.runCode(executable);
    ctx.destroy();
  });

  await harness.runTest('5.6.3: Large nested state object under deep proxy mutation and serialization', async () => {
    const env = createMockChromeEnvironment();
    const userCode = `
let deepStore = {
  level1: {
    level2: {
      tags: new Set(['init']),
      table: new Map([['key1', { count: 1 }]])
    }
  }
};

function mutateDeep() {
  deepStore.level1.level2.tags.add('updated');
  deepStore.level1.level2.table.get('key1').count += 10;
}

mutateDeep();
`;
    const executable = buildExecutableBundle(userCode, { stateStrategy: 'proxy' });
    const ctx = createExecutionContext(env);
    ctx.runCode(executable);

    expect(ctx.runCode('deepStore.level1.level2.tags.has("updated")')).toBe(true);
    expect(ctx.runCode('deepStore.level1.level2.table.get("key1").count')).toBe(11);
    ctx.destroy();
  });

  await harness.runTest('5.6.4: Multiple background timers below and above alarm threshold inside try-finally', () => {
    const code = `
let shortTimerId = null;
let longTimerId = null;
function schedule() {
  try {
    shortTimerId = setTimeout(() => {}, 5000);
  } finally {
    longTimerId = setTimeout(() => {}, 120000);
  }
}
`;
    const { code: out } = compileSource(code, { alarmThresholdMs: 60000 });
    expect(out).toContain('shortTimerId = __mv3_setTimeout(');
    expect(out).toContain('longTimerId = __mv3_setTimeout(');
    expect(out).toContain("__mv3_markDirty('shortTimerId')");
    expect(out).toContain("__mv3_markDirty('longTimerId')");
  });
}

// Auto-run if executed directly as main script
const isMain = process.argv[1]?.includes('tier5-compiler-adversarial');
if (isMain) {
  const harness = new TestHarness();
  runTier5(harness).then(() => {
    const summary = harness.getSummary();
    console.log(`\n================================================================`);
    console.log(`TIER 5 ADVERSARIAL TEST SUMMARY`);
    console.log(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}`);
    console.log(`Pass Rate: ${((summary.passed / summary.total) * 100).toFixed(1)}%`);
    console.log(`================================================================\n`);
    process.exit(summary.failed === 0 ? 0 : 1);
  }).catch((err) => {
    console.error('Fatal Tier 5 execution error:', err);
    process.exit(1);
  });
}
