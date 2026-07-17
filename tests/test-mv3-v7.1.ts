/**
 * Regression tests for v7.1 fixes:
 *
 *   1. Fragile regex parsing in buildAdapterBlock replaced with
 *      direct __mv3_registerFn() call generation from data structures
 *   2. __mv3_flush() removed (dead code)
 *   3. Silent .catch(() => {}) replaced with console.warn logging
 */

import { assert, transform, resetCounters, printResults } from './test-utils-mv3';

resetCounters();

// ═══════════════════════════════════════════════════════════════════════
// 1. No more regex parsing — registerFn() calls generated directly
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 1. Direct registerFn() generation (no regex) ===');

{
  const code = `
let counter = 0;

function myHandler() { counter++; }

setTimeout(myHandler, 5000);
`;
  const { code: out, virtualModule: vm } = transform(code);

  // 1a. __mv3_registerFn calls are present (not object-literal format)
  assert(
    out.includes("__mv3_registerFn('myHandler', myHandler);"),
    '__mv3_registerFn call generated directly for function declaration'
  );

  // 1b. No object-literal-style registry entries
  // The old format would be: 'myHandler': myHandler,
  assert(
    !out.match(/['"]\w+['"]:\s*\w+,?\s*$/m),
    'No object-literal-style registry entries in adapter'
  );
}

{
  // Test with bound method — the key case where multi-line boundCode
  // would break the old regex
  const code = `
let counter = 0;
let myObj = { method: function() {} };

const bound = myObj.method.bind(
  myObj,
  'arg1',
  'arg2'
);

setTimeout(bound, 5000);
`;
  const { code: out, virtualModule: vm } = transform(code);

  // 1c. __mv3_registerFn call for bound method — includes full boundCode expression
  assert(
    out.includes("__mv3_registerFn('bound',"),
    '__mv3_registerFn call generated for bound method'
  );

  // 1d. The bound expression is present in the registerFn call
  // (This would fail with the old regex if boundCode was multi-line)
  assert(
    out.includes('.bind('),
    'Bound expression is present in __mv3_registerFn call'
  );
}

{
  // Test with named alarm handlers
  const code = `let counter = 0;`;
  const { code: out } = transform(code, {
    namedAlarmHandlers: { 'myAlarm': '() => { console.log("tick"); }' }
  });

  // 1e. Named alarm handler uses __mv3_registerFn directly
  assert(
    out.includes("__mv3_registerFn('myAlarm',"),
    'Named alarm handler registered via __mv3_registerFn'
  );
}

{
  // Test with recovery functions (timer callback references)
  const code = `
let counter = 0;

function myRecoveryFn() { counter = 0; }

setTimeout(() => { myRecoveryFn(); }, 5000);
`;
  const { code: out } = transform(code);

  // 1f. Recovery function registered via __mv3_registerFn
  assert(
    out.includes("__mv3_registerFn('myRecoveryFn', myRecoveryFn);"),
    'Recovery function registered via __mv3_registerFn'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 2. __mv3_flush() removed (dead code)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 2. __mv3_flush() removed ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync(require('path').resolve(__dirname, '../src/index.ts'), 'utf-8');

  // No __mv3_flush function definition anywhere in the code
  // (It was dead code and should be completely absent)
  const functionDefPattern = /function\s+__mv3_flush\s*\(/;
  assert(
    !functionDefPattern.test(source),
    'No __mv3_flush function definition in source'
  );

  // Changelog section removed from plugin source
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Silent .catch(() => {}) replaced with console.warn logging
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 3. Storage error logging (no more silent suppression) ===');

{
  const code = `let counter = 0; let isProcessing = false;`;
  const { code: out, virtualModule: vm } = transform(code);

  // 3a. No .catch(() => {}) in virtual module
  assert(
    !vm.includes('.catch(() => {})'),
    'No silent .catch(() => {}) in virtual module'
  );

  // 3b. No .catch(() => {}) in adapter
  assert(
    !out.includes('.catch(() => {})'),
    'No silent .catch(() => {}) in adapter'
  );
}

{
  // Test with offscreen strategy (more .catch() paths)
  const code = `let flag = false;`;
  const { virtualModule: vm } = transform(code, { keepaliveStrategy: 'offscreen' });

  // 3c. No .catch(() => {}) in offscreen virtual module
  assert(
    !vm.includes('.catch(() => {})'),
    'No silent .catch(() => {}) in offscreen virtual module'
  );
}

{
  const code = `let counter = 0;`;
  const { virtualModule: vm } = transform(code);

  // 3d. Storage write errors are logged
  assert(
    vm.includes("console.warn('[MV3 Persistent] Storage write failed:'"),
    'Storage write errors logged with console.warn'
  );

  // 3e. Storage cleanup errors are logged
  assert(
    vm.includes("console.warn('[MV3 Persistent] Storage cleanup failed:'"),
    'Storage cleanup errors logged with console.warn'
  );

  // 3f. Write error context uses 'e' parameter
  assert(
    vm.includes('.catch(e => console.warn('),
    '.catch() passes error parameter to console.warn'
  );
}

{
  // Test that the log messages appear in the right contexts
  const code = `
let counter = 0;
let flag = false;

function tick() { counter++; }

setTimeout(tick, 65000);
`;
  const { virtualModule: vm } = transform(code);

  // 3g. Storage set operations (.set) log write failures
  const setCatches = (vm.match(/\.set\([^)]*\)\s*\.catch\(e\s*=>\s*console\.warn\('\[MV3 Persistent\] Storage write failed:'/g) || []);
  assert(
    setCatches.length >= 1,
    `Storage .set() operations log write failures (found ${setCatches.length})`
  );

  // 3h. Storage remove operations (.remove) log cleanup failures
  const removeCatches = (vm.match(/\.remove\([^)]*\)\s*\.catch\(e\s*=>\s*console\.warn\('\[MV3 Persistent\] Storage cleanup failed:'/g) || []);
  assert(
    removeCatches.length >= 1,
    `Storage .remove() operations log cleanup failures (found ${removeCatches.length})`
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Version consistency
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 4. Version v7.1 consistency ===');

{
  const { readFileSync } = require('fs');
  const indexPath = require('path').resolve(__dirname, '../src/index.ts');
  const source = readFileSync(indexPath, 'utf-8');

  // 4a. File header says v7.1
  assert(
    source.includes('vite-plugin-mv3-persistent  v7.1'),
    'File header says v7.1'
  );

  // 4a2. Plugin exports a version property
  assert(
    source.includes("version: '7.1'"),
    'Plugin object has version: 7.1 property'
  );

  // 4b. Runtime version tag in adapter.ts
  const adapterSource = readFileSync(require('path').resolve(__dirname, '../src/runtime/adapter.ts'), 'utf-8');
  assert(
    adapterSource.includes('vite-plugin-mv3-persistent v7.1'),
    'Runtime version tag in adapter.ts says v7.1'
  );
}

{
  const code = `let x = 0;`;
  const { code: out, virtualModule: vm } = transform(code);

  // 4c. Adapter references v7.1
  assert(
    out.includes('v7.1'),
    'Generated adapter references v7.1'
  );

  // 4d. Virtual module references v7.1
  assert(
    vm.includes('v7.1'),
    'Generated virtual module references v7.1'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 5. End-to-end regression: transform still works correctly
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 5. End-to-end regression ===');

{
  const code = `
let counter = 0;
let config = { name: "test" };
let isProcessing = false;

function tick() { counter++; }

chrome.runtime.onMessage.addListener(async (msg) => {
  console.log(counter);
});

setTimeout(tick, 65000);
clearTimeout(timer);
counter = 42;
config.name = "updated";
`;
  const { code: out, virtualModule: vm, combined } = transform(code, { strategy: 'proxy' });

  // 5a. Core functionality still works
  assert(
    out.includes('__mv3_setTimeout(tick, 65000)'),
    'setTimeout replacement still works'
  );
  assert(
    out.includes('__mv3_clearTimeout'),
    'clearTimeout replacement still works'
  );
  assert(
    out.includes("__mv3_markDirty('counter')"),
    'markDirty injection still works'
  );
  assert(
    out.includes('await __mv3_init'),
    '__mv3_init injection still works'
  );
  assert(
    out.includes("__mv3_registerFn('tick', tick);"),
    '__mv3_registerFn for tick still works'
  );

  // 5b. No regression in virtual module structure
  assert(
    vm.includes('export function createMV3Runtime'),
    'Virtual module still exports createMV3Runtime'
  );
  assert(
    vm.includes('globalThis.browser || globalThis.chrome'),
    'Cross-browser namespace still present'
  );
  assert(
    !vm.includes('.catch(() => {})'),
    'No silent error suppression in virtual module'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 6. Virtual module ID has .ts extension for esbuild transpilation
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 6. Virtual module .ts extension ===');

{
  const { mv3Persistent } = require('../src/index');

  const plugin = mv3Persistent({
    backgroundEntry: /.*/,
  });

  // 6a. RESOLVED_VIRTUAL_ID ends with .ts
  const resolved = plugin.resolveId('virtual:mv3-persistent-runtime', '/src/bg.ts', {});
  assert(
    resolved === '\0virtual:mv3-persistent-runtime.ts',
    'resolveId returns ID with .ts extension (so esbuild transpiles TS)'
  );

  // 6b. load() works with the .ts-suffixed resolved ID
  plugin.transform!.call({
    error(msg: string) { throw new Error(msg); },
  }, 'let x = 0;', '/bg.ts');

  const loaded = plugin.load!.call({}, '\0virtual:mv3-persistent-runtime.ts');
  assert(
    typeof loaded === 'string' && loaded.includes('createMV3Runtime'),
    'load() returns content when called with .ts-suffixed ID'
  );

  // 6c. load() returns nothing for the old non-.ts ID
  const oldIdLoaded = plugin.load!.call({}, '\0virtual:mv3-persistent-runtime');
  assert(
    oldIdLoaded === undefined || oldIdLoaded === null,
    'load() returns nothing for old non-.ts ID (ensures migration)'
  );
}

{
  const { readFileSync } = require('fs');
  const source = readFileSync(require('path').resolve(__dirname, '../src/types.ts'), 'utf-8');

  // 6d. RESOLVED_VIRTUAL_ID constant ends with .ts
  assert(
    source.includes("VIRTUAL_MODULE_ID + '.ts'"),
    'RESOLVED_VIRTUAL_ID is built with .ts suffix'
  );

  // Changelog .ts extension mention removed from plugin source
}

{
  // 6f. The import in the user's code still uses the bare virtual: ID
  // (without .ts — the resolveId hook adds .ts)
  const code = `let x = 0;`;
  const { code: out } = transform(code);
  assert(
    out.includes("from 'virtual:mv3-persistent-runtime'"),
    "User code imports from bare 'virtual:mv3-persistent-runtime' (resolveId adds .ts)"
  );
  // The import does NOT have .ts — Vite's resolveId adds it
  assert(
    !out.includes("from 'virtual:mv3-persistent-runtime.ts'"),
    "User import does NOT have .ts — resolveId adds it transparently"
  );
}

// ═══════════════════════════════════════════════════════════════════════
printResults();
