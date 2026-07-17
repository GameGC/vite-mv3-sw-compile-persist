/**
 * Regression tests for v7 architectural changes:
 *
 *   1. Runtime extracted into virtual Vite module (virtual:mv3-persistent-runtime)
 *   2. Cross-browser namespace: globalThis.browser || globalThis.chrome
 *   3. createMV3Runtime() factory with config + accessor pattern
 *   4. Thin adapter injected into user's background.ts
 *   5. Function registry via registerFn() API
 */

import { assert, transform, resetCounters, printResults } from './test-utils-mv3';

resetCounters();

// ═══════════════════════════════════════════════════════════════════════
// 1. Virtual Module Architecture
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 1. Virtual module architecture ===');

{
  const code = `let counter = 0; let config = { name: "test" };`;
  const { code: out, virtualModule: vm, combined } = transform(code);

  // 1a. The user's code should have the import statement
  assert(
    out.includes("import { createMV3Runtime } from 'virtual:mv3-persistent-runtime'"),
    'User code has import from virtual module'
  );

  // 1b. The user's code should call createMV3Runtime()
  assert(
    out.includes('createMV3Runtime('),
    'User code calls createMV3Runtime()'
  );

  // 1c. The virtual module should export createMV3Runtime
  assert(
    vm.includes('export function createMV3Runtime'),
    'Virtual module exports createMV3Runtime'
  );

  // 1d. The virtual module should contain the runtime logic
  assert(
    vm.includes('async function __mv3_flushDirty'),
    'Virtual module contains __mv3_flushDirty'
  );

  // 1e. The user's code should NOT contain the full runtime inline
  assert(
    !out.includes('async function __mv3_flushDirty'),
    'User code does NOT contain inline __mv3_flushDirty'
  );

  // 1f. The adapter should be much smaller than the old inline runtime
  // (adapter is ~40-60 lines, old runtime was ~500 lines)
  const adapterLines = out.split('\n').length;
  const vmLines = vm.split('\n').length;
  assert(
    adapterLines < 80,
    `Adapter is compact (${adapterLines} lines, < 80)`
  );
  assert(
    vmLines > 100,
    `Virtual module has substantial content (${vmLines} lines, > 100)`
  );

  // 1g. Destructured API from createMV3Runtime
  assert(
    out.includes('__mv3_init') &&
    out.includes('__mv3_markDirty') &&
    out.includes('__mv3_setTimeout') &&
    out.includes('__mv3_setInterval') &&
    out.includes('__mv3_clearTimeout') &&
    out.includes('__mv3_clearInterval') &&
    out.includes('__mv3_reactive') &&
    out.includes('__mv3_getVar') &&
    out.includes('__mv3_bindMethod') &&
    out.includes('registerFn'),
    'All runtime API symbols destructured from createMV3Runtime'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Cross-browser Namespace (globalThis.browser || globalThis.chrome)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 2. Cross-browser namespace ===');

{
  const code = `let counter = 0;`;
  const { virtualModule: vm } = transform(code);

  // 2a. Virtual module defines the namespace alias
  assert(
    vm.includes('globalThis.browser || globalThis.chrome'),
    'Virtual module uses globalThis.browser || globalThis.chrome'
  );

  // 2b. No hardcoded chrome.* API calls in virtual module
  const chromeApiPattern = /chrome\.(storage|alarms|offscreen|runtime)\./;
  assert(
    !chromeApiPattern.test(vm),
    'No hardcoded chrome.* API calls in virtual module'
  );

  // 2c. Virtual module uses __mv3_ext.* for all API calls
  assert(
    vm.includes('__mv3_ext.storage') ||
    vm.includes('__mv3_ext.alarms') ||
    vm.includes('__mv3_ext.runtime'),
    'Virtual module uses __mv3_ext.* for extension API calls'
  );

  // 2d. The namespace constant is defined
  assert(
    vm.includes('const __mv3_ext'),
    '__mv3_ext constant is defined in virtual module'
  );
}

{
  // Test with offscreen strategy — should use __mv3_ext.offscreen
  const code = `let flag = false;`;
  const { virtualModule: vm } = transform(code, { keepaliveStrategy: 'offscreen' });

  assert(
    vm.includes('__mv3_ext.offscreen') ||
    vm.includes('__mv3_ext.runtime'),
    'Offscreen strategy uses __mv3_ext namespace'
  );

  assert(
    !/chrome\.(offscreen|runtime)\./.test(vm),
    'No hardcoded chrome.offscreen/runtime in offscreen virtual module'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 3. createMV3Runtime Factory Pattern
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 3. createMV3Runtime factory pattern ===');

{
  const code = `let counter = 0; let isProcessing = false; let config = { name: "test" };`;
  const { code: out, virtualModule: vm } = transform(code, { strategy: 'proxy' });

  // 3a. Config is passed to createMV3Runtime
  assert(
    out.includes('varNames:'),
    'Config includes varNames'
  );
  assert(
    out.includes('booleanVarNames:'),
    'Config includes booleanVarNames'
  );
  assert(
    out.includes('storageArea:'),
    'Config includes storageArea'
  );
  assert(
    out.includes('alarmThresholdMs:'),
    'Config includes alarmThresholdMs'
  );
  assert(
    out.includes('stateStrategy:'),
    'Config includes stateStrategy'
  );

  // 3b. Accessor functions are passed
  assert(
    out.includes('getVar(') || out.includes('getVar(name'),
    'Accessor getVar is passed'
  );
  assert(
    out.includes('setVar(') || out.includes('setVar(name'),
    'Accessor setVar is passed'
  );
  assert(
    out.includes('getDirtyData(') || out.includes('getDirtyData(name'),
    'Accessor getDirtyData is passed'
  );

  // 3c. setVar wraps with __mv3_reactive for proxy mode objects
  assert(
    out.includes("__mv3_reactive(value, 'config')"),
    'setVar wraps config with __mv3_reactive in proxy mode'
  );

  // 3d. getDirtyData uses prefix parameter
  assert(
    out.includes('prefix +') || out.includes('[prefix'),
    'getDirtyData uses prefix parameter for key construction'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Thin Adapter (user code is clean)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 4. Thin adapter — user code is clean ===');

{
  const code = `
let counter = 0;
let config = { name: "test" };

function myHandler() { counter++; }

chrome.runtime.onMessage.addListener((msg) => {
  console.log(counter);
});

setTimeout(myHandler, 5000);
`;
  const { code: out, virtualModule: vm } = transform(code, { strategy: 'proxy' });

  // 4a. Adapter does NOT contain heavy runtime code
  assert(
    !out.includes('new Proxy('),
    'Adapter does NOT contain Proxy implementation'
  );
  assert(
    !out.includes('ProxyHandler'),
    'Adapter does NOT contain ProxyHandler'
  );
  assert(
    !out.includes('__mv3_ext.alarms.onAlarm.addListener'),
    'Adapter does NOT contain alarm listener'
  );
  assert(
    !out.includes('__mv3_ensureOffscreenDocument'),
    'Adapter does NOT contain offscreen functions'
  );
  assert(
    !out.includes('__mv3_promise_pending'),
    'Adapter does NOT contain promise tracking'
  );
  assert(
    !out.includes('__native_setTimeout = globalThis.setTimeout'),
    'Adapter does NOT contain native timer setup'
  );

  // 4b. Virtual module DOES contain the heavy runtime code
  assert(
    vm.includes('new Proxy('),
    'Virtual module contains Proxy implementation'
  );
  assert(
    vm.includes('alarms.onAlarm.addListener'),
    'Virtual module contains alarm listener'
  );
  assert(
    vm.includes('globalThis.setTimeout'),
    'Virtual module contains native timer setup'
  );

  // 4c. Original user code is preserved in the output
  assert(
    out.includes('let counter = 0;'),
    'User variable declarations preserved'
  );
  assert(
    out.includes('function myHandler()'),
    'User function declarations preserved'
  );
  assert(
    out.includes('chrome.runtime.onMessage.addListener'),
    'User event listeners preserved'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Function Registry via registerFn() API
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 5. Function registry via registerFn() ===');

{
  const code = `
let counter = 0;

function myHandler() { counter++; }

const myCallback = () => { counter++; };

setTimeout(myHandler, 5000);
setTimeout(myCallback, 3000);
`;
  const { code: out, virtualModule: vm, combined } = transform(code);

  // 5a. registerFn is called for top-level functions
  assert(
    out.includes("registerFn('myHandler'"),
    'Top-level function registered via registerFn'
  );

  // 5b. registerFn is called for arrow-function variables used as timer callbacks
  assert(
    out.includes("registerFn('myCallback'"),
    'Arrow function callback registered via registerFn'
  );

  // 5c. Virtual module defines registerFn
  assert(
    vm.includes('function registerFn('),
    'Virtual module defines registerFn function'
  );

  // 5d. Virtual module's fn_registry is populated via registerFn
  assert(
    vm.includes('__mv3_fn_registry[name] = fn'),
    'registerFn populates __mv3_fn_registry'
  );

  // 5e. Virtual module's fn_names map is populated via registerFn
  assert(
    vm.includes('__mv3_fn_names.set(fn, name)'),
    'registerFn populates __mv3_fn_names map'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 6. Plugin Hooks (resolveId + load)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 6. Plugin hooks for virtual module ===');

{
  const { mv3Persistent } = require('/home/z/my-project/download/mv3-persistent-plugin');

  const plugin = mv3Persistent({
    backgroundEntry: /.*/,
  });

  // 6a. Plugin has resolveId hook
  assert(
    typeof plugin.resolveId === 'function',
    'Plugin has resolveId hook'
  );

  // 6b. Plugin has load hook
  assert(
    typeof plugin.load === 'function',
    'Plugin has load hook'
  );

  // 6c. resolveId resolves the virtual module with .ts extension
  const resolved = plugin.resolveId('virtual:mv3-persistent-runtime', '/src/bg.ts', {});
  assert(
    resolved === '\0virtual:mv3-persistent-runtime.ts',
    'resolveId returns virtual module ID with .ts extension'
  );

  // 6d. resolveId returns null for non-virtual imports
  const notResolved = plugin.resolveId('./utils.ts', '/src/bg.ts', {});
  assert(
    notResolved === undefined || notResolved === null,
    'resolveId returns null for non-virtual imports'
  );

  // 6e. load returns content after transform runs
  const code = `let x = 0;`;
  plugin.transform!.call({
    error(msg: string) { throw new Error(msg); },
  }, code, '/bg.ts');

  const loaded = plugin.load!.call({}, '\0virtual:mv3-persistent-runtime.ts');
  assert(
    typeof loaded === 'string' && loaded.length > 100,
    'load returns virtual module content after transform'
  );
  assert(
    loaded.includes('createMV3Runtime'),
    'Virtual module content includes createMV3Runtime'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 7. Version Header
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 7. Version consistency ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // 7a. File header says v7.1
  assert(
    source.includes('vite-plugin-mv3-persistent  v7.1'),
    'File header says v7.1'
  );

  // Changelog section removed from plugin source
}

{
  const code = `let x = 0;`;
  const { code: out, virtualModule: vm } = transform(code);

  // 7c. Adapter says v7.1
  assert(
    out.includes('v7.1'),
    'Generated adapter references v7.1'
  );

  // 7d. Virtual module says v7.1
  assert(
    vm.includes('v7.1'),
    'Generated virtual module references v7.1'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 8. WELL_KNOWN_GLOBALS includes 'browser'
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 8. browser in WELL_KNOWN_GLOBALS ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  const wellKnownSection = source.slice(
    source.indexOf('const WELL_KNOWN_GLOBALS'),
    source.indexOf(']);', source.indexOf('const WELL_KNOWN_GLOBALS')) + 2
  );

  // 8a. 'browser' is in WELL_KNOWN_GLOBALS (for Firefox/Safari compat)
  assert(
    wellKnownSection.includes("'browser'"),
    "'browser' is in WELL_KNOWN_GLOBALS"
  );

  // 8b. 'chrome' is still there
  assert(
    wellKnownSection.includes("'chrome'"),
    "'chrome' is still in WELL_KNOWN_GLOBALS"
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 9. End-to-end: transform produces working output
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 9. End-to-end transform ===');

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

  // 9a. setTimeout replaced
  assert(
    out.includes('__mv3_setTimeout(tick, 65000)'),
    'setTimeout replaced with __mv3_setTimeout'
  );

  // 9b. clearTimeout replaced
  assert(
    out.includes('__mv3_clearTimeout'),
    'clearTimeout replaced with __mv3_clearTimeout'
  );

  // 9c. markDirty injected for primitive assignment
  assert(
    out.includes("__mv3_markDirty('counter')"),
    'markDirty injected for counter assignment'
  );

  // 9d. markDirty NOT injected for object assignment in proxy mode
  assert(
    !out.includes("__mv3_markDirty('config')"),
    'markDirty NOT injected for config (proxy handles it)'
  );

  // 9e. addListener handler gets __mv3_init
  assert(
    out.includes('await __mv3_init'),
    'Event handler gets __mv3_init injection'
  );

  // 9f. Proxy wrapping in adapter for object vars
  assert(
    out.includes("__mv3_reactive(config, 'config')"),
    'Object var wrapped in __mv3_reactive'
  );

  // 9g. Virtual module has __mv3_ext namespace
  assert(
    vm.includes('__mv3_ext') && vm.includes('globalThis.browser || globalThis.chrome'),
    'Virtual module has cross-browser namespace'
  );

  // 9h. Virtual module has alarm dispatch listener
  assert(
    vm.includes('onAlarm.addListener'),
    'Virtual module has alarm dispatch listener'
  );

  // 9i. Virtual module has __mv3_init (restore state)
  assert(
    vm.includes('const __mv3_init ='),
    'Virtual module has __mv3_init restore promise'
  );

  // 9j. Stale-lock recovery for boolean vars
  assert(
    vm.includes('isProcessing') || vm.includes('booleanVarNames'),
    'Stale-lock recovery handles boolean vars'
  );
}

// ═══════════════════════════════════════════════════════════════════════
printResults();
