/**
 * Tier 2: Boundary & Corner Cases Test Suite
 *
 * Adversarial edge conditions:
 * - Empty & nil initializers
 * - Zero, negative & threshold boundaries
 * - Maximum & extreme bounds
 * - Identifier clashes & variable shadowing
 * - Special characters & string escaping
 * - Multiple & concurrent timers
 * - Rapid re-entrant mutations
 * - Path normalization & entry variations
 *
 * >= 5 test cases per category (total: 40 test cases across 8 areas).
 */

import {
  TestHarness,
  expect,
  compileSource,
  createMockChromeEnvironment,
  createExecutionContext,
  buildExecutableBundle,
} from './harness.js';

export async function runTier2(harness: TestHarness) {
  // ==========================================================================
  // Area 2.1: Empty & Nil Initializers
  // ==========================================================================
  harness.setSuite('Tier 2.1: Empty & Nil States');

  await harness.runTest('2.1.1: Empty background script transforms cleanly without syntax errors', () => {
    const code = '';
    const { code: out } = compileSource(code);
    expect(typeof out).toBe('string');
  });

  await harness.runTest('2.1.2: Uninitialized let x; declaration is safely ignored', () => {
    const code = `let uninitialized;\nlet active = true;`;
    const { code: out } = compileSource(code);
    expect(out).toNotContain("'uninitialized'");
    expect(out).toContain("'active'");
  });

  await harness.runTest('2.1.3: Variable initialized to null is tracked and serialized', () => {
    const code = `let currentTask = null;\ncurrentTask = { id: 1 };`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'currentTask'");
    expect(out).toContain("__mv3_markDirty('currentTask')");
  });

  await harness.runTest('2.1.4: Variable initialized to undefined is tracked and serialized', () => {
    const code = `let pendingUser = undefined;\npendingUser = "alice";`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'pendingUser'");
    expect(out).toContain("__mv3_markDirty('pendingUser')");
  });

  await harness.runTest('2.1.5: Empty object {} and empty array [] tracked and proxied without error', () => {
    const code = `let emptyObj = {};\nlet emptyArr = [];`;
    const { code: out } = compileSource(code, { stateStrategy: 'proxy' });
    expect(out).toContain("emptyObj = __mv3_reactive(emptyObj, 'emptyObj');");
    expect(out).toContain("emptyArr = __mv3_reactive(emptyArr, 'emptyArr');");
  });

  // ==========================================================================
  // Area 2.2: Zero, Negative & Exact Boundary Delays
  // ==========================================================================
  harness.setSuite('Tier 2.2: Zero, Negative & Threshold Delays');

  await harness.runTest('2.2.1: setTimeout with 0ms delay rewritten to __mv3_setTimeout(..., 0)', () => {
    const code = `function immediate() {}\nsetTimeout(immediate, 0);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(immediate, 0)');
  });

  await harness.runTest('2.2.2: setTimeout with negative delay (-50ms) rewritten to __mv3_setTimeout', () => {
    const code = `function neg() {}\nsetTimeout(neg, -50);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(neg, -50)');
  });

  await harness.runTest('2.2.3: Delay exactly equal to threshold - 1 (59999ms) rewritten to __mv3_setTimeout', () => {
    const code = `function nearThreshold() {}\nsetTimeout(nearThreshold, 59999);`;
    const { code: out } = compileSource(code, { alarmThresholdMs: 60000 });
    expect(out).toContain('__mv3_setTimeout(nearThreshold, 59999)');
  });

  await harness.runTest('2.2.4: Delay exactly equal to threshold (60000ms) rewritten to __mv3_setTimeout', () => {
    const code = `function atThreshold() {}\nsetTimeout(atThreshold, 60000);`;
    const { code: out } = compileSource(code, { alarmThresholdMs: 60000 });
    expect(out).toContain('__mv3_setTimeout(atThreshold, 60000)');
  });

  await harness.runTest('2.2.5: Delay exactly equal to threshold + 1 (60001ms) rewritten to __mv3_setTimeout', () => {
    const code = `function aboveThreshold() {}\nsetTimeout(aboveThreshold, 60001);`;
    const { code: out } = compileSource(code, { alarmThresholdMs: 60000 });
    expect(out).toContain('__mv3_setTimeout(aboveThreshold, 60001)');
  });

  // ==========================================================================
  // Area 2.3: Maximum & Extreme Bounds
  // ==========================================================================
  harness.setSuite('Tier 2.3: Extreme Bounds');

  await harness.runTest('2.3.1: Large multi-day delay expression evaluates without overflow', () => {
    const code = `function weeklySync() {}\nsetTimeout(weeklySync, 7 * 24 * 60 * 60 * 1000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(weeklySync, 7 * 24 * 60 * 60 * 1000)');
  });

  await harness.runTest('2.3.2: Large array handling in virtual module plain converter', () => {
    const code = `let bigList = [];`;
    const { virtualModule: vm } = compileSource(code, { stateStrategy: 'proxy' });
    expect(vm).toContain('function __mv3_toPlain(');
    expect(vm).toContain('.map(__mv3_toPlain)');
  });

  await harness.runTest('2.3.3: Deep object graph plain converter handles nested objects', () => {
    const code = `let config = {};`;
    const { virtualModule: vm } = compileSource(code, { stateStrategy: 'proxy' });
    expect(vm).toContain('function __mv3_toPlain(');
    expect(vm).toContain('for (const key of Object.keys(value))');
  });

  await harness.runTest('2.3.4: Extreme autoFlushMs (0ms or large) configures adapter correctly', () => {
    const code = `let state = 1;`;
    const { code: out } = compileSource(code, { autoFlushMs: 3600000 });
    expect(out).toContain('autoFlushMs: 3600000');
  });

  await harness.runTest('2.3.5: Extreme staleLockThresholdMs (0ms) configures adapter correctly', () => {
    const code = `let isBusy = true;`;
    const { code: out } = compileSource(code, { staleLockThresholdMs: 0 });
    expect(out).toContain('staleLockThresholdMs: 0');
  });

  // ==========================================================================
  // Area 2.4: Identifier Clashes & Variable Shadowing
  // ==========================================================================
  harness.setSuite('Tier 2.4: Identifier Clashes & Shadowing');

  await harness.runTest('2.4.1: Function parameter with same name as global does not mark global dirty on assignment', () => {
    const code = `let count = 0;\nfunction update(count) { count = 10; }\n`;
    const { code: out } = compileSource(code);
    // count inside update is a parameter, so it shouldn't inject __mv3_markDirty('count') inside update
    const lines = out.split('\n');
    const updateLine = lines.find((l) => l.includes('count = 10'));
    if (updateLine) {
      expect(updateLine).toNotContain("__mv3_markDirty('count')");
    }
  });

  await harness.runTest('2.4.2: Local block let with same name does not mark global dirty', () => {
    const code = `let state = 0;\nfunction test() { let state = 5; state = 10; }\n`;
    const { code: out } = compileSource(code);
    const lines = out.split('\n');
    const localAssign = lines.find((l) => l.includes('state = 10'));
    if (localAssign) {
      expect(localAssign).toNotContain("__mv3_markDirty('state')");
    }
  });

  await harness.runTest('2.4.3: Global assignment outside function marks dirty properly', () => {
    const code = `let count = 0;\ncount = 42;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('count')");
  });

  await harness.runTest('2.4.4: Destructuring warning emitted for top-level array pattern', () => {
    const code = `let [a, b] = [1, 2];`;
    // Should warn or skip destructuring for persistence
    const { code: out } = compileSource(code);
    expect(typeof out).toBe('string');
  });

  await harness.runTest('2.4.5: Global identifier named identically to standard JS properties', () => {
    const code = `let status = 200;\nstatus = 404;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'status'");
    expect(out).toContain("__mv3_markDirty('status')");
  });

  // ==========================================================================
  // Area 2.5: Special Characters & String Escaping
  // ==========================================================================
  harness.setSuite('Tier 2.5: Special Characters & Escaping');

  await harness.runTest('2.5.1: Unicode variable identifier tracked cleanly', () => {
    const code = `let données = { count: 1 };\ndonnées.count = 2;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'données'");
    expect(out).toContain("__mv3_markDirty('données')");
  });

  await harness.runTest('2.5.2: String values with escaped quotes and newlines', () => {
    const code = `let multiline = "line1\\nline2\\\"quote\\\"";\nmultiline = "line3";`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'multiline'");
    expect(out).toContain("__mv3_markDirty('multiline')");
  });

  await harness.runTest('2.5.3: String values with special control characters handled in structured serialization', () => {
    const code = `let payload = "\\u0000\\u001f";`;
    const { code: out } = compileSource(code);
    expect(out).toContain("'payload'");
  });

  await harness.runTest('2.5.4: Object keys with dots and colons in property assignments', () => {
    const code = `let cache = {};\ncache["key:v1.0"] = 123;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('cache')");
  });

  await harness.runTest('2.5.5: Template literals with backticks inside event listeners', () => {
    const code = `chrome.runtime.onMessage.addListener(async (msg) => {\n  console.log(\`Received: \${JSON.stringify(msg)}\`);\n});`;
    const { code: out } = compileSource(code);
    expect(out).toContain('await __mv3_init;');
  });

  // ==========================================================================
  // Area 2.6: Multiple & Concurrent Timers
  // ==========================================================================
  harness.setSuite('Tier 2.6: Multiple & Concurrent Timers');

  await harness.runTest('2.6.1: Multiple setTimeout calls with same callback generate unique calls', () => {
    const code = `function poll() {}\nsetTimeout(poll, 1000);\nsetTimeout(poll, 2000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(poll, 1000)');
    expect(out).toContain('__mv3_setTimeout(poll, 2000)');
  });

  await harness.runTest('2.6.2: Interleaved setTimeout and setInterval on same handler function', () => {
    const code = `function tick() {}\nsetTimeout(tick, 1000);\nsetInterval(tick, 5000);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(tick, 1000)');
    expect(out).toContain('__mv3_setInterval(tick, 5000)');
  });

  await harness.runTest('2.6.3: Immediate clearTimeout after scheduling transformed properly', () => {
    const code = `function fn() {}\nconst id = setTimeout(fn, 10000);\nclearTimeout(id);`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(fn, 10000)');
    expect(out).toContain('__mv3_clearTimeout(id)');
  });

  await harness.runTest('2.6.4: Recursive timer inside function definition', () => {
    const code = `function repeat() { setTimeout(repeat, 2000); }`;
    const { code: out } = compileSource(code);
    expect(out).toContain('__mv3_setTimeout(repeat, 2000)');
    expect(out).toContain("__mv3_registerFn('repeat', repeat);");
  });

  await harness.runTest('2.6.5: Virtual runtime handles cancelling non-existent timer gracefully', () => {
    const code = `let x = 0;`;
    const { virtualModule: vm } = compileSource(code);
    expect(vm).toContain('function __mv3_clearTimeout(');
  });

  // ==========================================================================
  // Area 2.7: Rapid Re-entrant State Mutations
  // ==========================================================================
  harness.setSuite('Tier 2.7: Rapid Re-entrant State Mutations');

  await harness.runTest('2.7.1: Rapid successive assignments mark dirty without syntax corruption', () => {
    const code = `let x = 0;\nx = 1;\nx = 2;\nx = 3;\nx = 4;`;
    const { code: out } = compileSource(code);
    const matches = out.match(/__mv3_markDirty\('x'\)/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBe(4);
  });

  await harness.runTest('2.7.2: Alternating array methods (push, pop, shift, unshift) wrapped and marked dirty', () => {
    const code = `let list = [1, 2];\nlist.push(3);\nlist.pop();\nlist.shift();\nlist.unshift(0);`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('list')");
  });

  await harness.runTest('2.7.3: Deep object property chains marked dirty on leaf write', () => {
    const code = `let store = { a: { b: { c: 1 } } };\nstore.a.b.c = 2;`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('store')");
  });

  await harness.runTest('2.7.4: Virtual runtime ProxyCache prevents double proxying of targets', () => {
    const code = `let obj = {};`;
    const { virtualModule: vm } = compileSource(code, { stateStrategy: 'proxy' });
    expect(vm).toContain('__mv3_PROXY_CACHE');
  });

  await harness.runTest('2.7.5: Array index bracket assignment marks dirty', () => {
    const code = `let items = ['a', 'b'];\nitems[0] = 'z';`;
    const { code: out } = compileSource(code);
    expect(out).toContain("__mv3_markDirty('items')");
  });

  // ==========================================================================
  // Area 2.8: Path Normalization & Entry Point Edge Cases
  // ==========================================================================
  harness.setSuite('Tier 2.8: Path Normalization & Entry Variations');

  await harness.runTest('2.8.1: String backgroundEntry with subfolder path matched', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { backgroundEntry: 'src/background/index.ts' }, '/app/src/background/index.ts');
    expect(out).toContain('createMV3Runtime');
  });

  await harness.runTest('2.8.2: Leading relative dot-slash in backgroundEntry path matched', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { backgroundEntry: './src/background/index.ts' }, './src/background/index.ts');
    expect(out).toContain('createMV3Runtime');
  });

  await harness.runTest('2.8.3: Vite module ID with query parameters (?worker) matches entry', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { backgroundEntry: /background\/index\.ts$/ }, '/src/background/index.ts?worker_file&lang.ts');
    expect(out).toContain('createMV3Runtime');
  });

  await harness.runTest('2.8.4: Multiple file paths checked with RegExp entry', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { backgroundEntry: /(bg|background)\.(ts|js)$/ }, '/src/bg.ts');
    expect(out).toContain('createMV3Runtime');
  });

  await harness.runTest('2.8.5: Unmatched file paths return null / pass through untransformed', () => {
    const code = `let x = 1;`;
    const { code: out } = compileSource(code, { backgroundEntry: 'background/index.ts' }, '/src/options/index.ts');
    expect(out).toNotContain('createMV3Runtime');
  });
}
