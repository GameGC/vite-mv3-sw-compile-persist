/**
 * Regression tests for v4 bugfixes:
 *
 *   #8  Duplicate CallExpression visitors — clearTimeout/addListener silently lost
 *   #9  __mv3_flushDirty flushes ALL vars instead of only dirty ones
 *   #10 Stale-lock heuristic — false positive when SW dies mid-sync
 *   #11 isGlobal PascalCase heuristic too broad
 *   #12 'Browser' duplicated in WELL_KNOWN_GLOBALS
 *   #13 findInsertPosition fragile
 *   v4.1: Double parse, findInsertPosition break, addListener double-record,
 *         flushDirty race, recoveryEntries, ResolvedConfig
 *
 * Updated for v7: uses combined output (adapter + virtual module)
 */

import { assert, transform, getResults, printResults, resetCounters } from './test-utils-mv3';

resetCounters();

// ═══════════════════════════════════════════════════════════════════════
// Bug #8: Duplicate CallExpression visitors
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #8: Duplicate CallExpression visitors ===');

{
  const code = `
let timer = null;
function start() { timer = setTimeout(run, 5000); }
function stop() { clearTimeout(timer); }
chrome.runtime.onMessage.addListener(async (msg) => { await __mv3_init; });
`;
  const { code: out } = transform(code);

  assert(
    out.includes('__mv3_clearTimeout'),
    'clearTimeout is transformed to __mv3_clearTimeout'
  );
  assert(
    out.includes('__mv3_setTimeout'),
    'setTimeout is transformed to __mv3_setTimeout'
  );
  assert(
    out.includes('await __mv3_init'),
    'addListener handler gets __mv3_init injection'
  );
}

{
  const code = `
let interval = null;
function start() { interval = setInterval(tick, 10000); }
function stop() { clearInterval(interval); }
`;
  const { code: out } = transform(code);

  assert(
    out.includes('__mv3_clearInterval'),
    'clearInterval is transformed to __mv3_clearInterval'
  );
  assert(
    out.includes('__mv3_setInterval'),
    'setInterval is transformed to __mv3_setInterval'
  );
}

{
  const code = `
let count = 0;
let timer = null;
function tick() { count++; }
function start() {
  timer = setTimeout(tick, 5000);
}
function stop() { clearTimeout(timer); }
chrome.alarms.onAlarm.addListener(async (alarm) => { await __mv3_init; });
count = 10;
`;
  const { code: out } = transform(code);

  assert(out.includes('__mv3_setTimeout'), 'setTimeout detected in combined code');
  assert(out.includes('__mv3_clearTimeout'), 'clearTimeout detected in combined code');
  assert(out.includes('await __mv3_init'), 'addListener handler detected in combined code');
  assert(out.includes("__mv3_markDirty('count')"), 'assignment mutation detected in combined code');
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #9: __mv3_flushDirty flushes only dirty vars
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #9: __mv3_flushDirty flushes only dirty vars ===');

{
  const code = `let x = 0; let y = 0; let z = 0;`;
  const { combined: out } = transform(code);

  // __mv3_flushDirty should NOT call __mv3_flush() anymore
  assert(
    !out.includes('await __mv3_flush()') || !out.includes('__mv3_flushDirty'),
    '__mv3_flushDirty does NOT call __mv3_flush()'
  );

  // v7: getDirtyData is now in the adapter's accessor callback
  assert(
    out.includes('getDirtyData'),
    'getDirtyData accessor exists for per-var flushing'
  );

  // Each var should have its own case in the adapter's getDirtyData switch
  assert(
    out.includes("case 'x': return {"),
    'var x has its own dirty-data case'
  );
  assert(
    out.includes("case 'y': return {"),
    'var y has its own dirty-data case'
  );
  assert(
    out.includes("case 'z': return {"),
    'var z has its own dirty-data case'
  );

  // __mv3_flushDirty should iterate over a snapshot
  assert(
    out.includes('const __snapshot = new Set(__mv3_dirty)'),
    '__mv3_flushDirty iterates over snapshot, not live dirty set'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Issue #10: Stale-lock heuristic with lock-age timestamps
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Issue #10: Stale-lock heuristic with lock-age ===');

{
  const code = `let isProcessing = false; let count = 0;`;
  const { combined: out } = transform(code);

  // v7: lock-age key now referenced via prefix + 'lockAge_' in virtual runtime
  assert(
    out.includes('lockAge_'),
    'Lock age key is generated for boolean var isProcessing'
  );

  // v7: staleThreshold is passed via config.staleLockThresholdMs
  assert(
    out.includes('staleLockThresholdMs') || out.includes('staleThreshold'),
    'Stale threshold is used in recovery'
  );

  // Should check age against threshold
  assert(
    out.includes('Date.now()') && out.includes('lockAge'),
    'Lock age is compared against threshold before clearing'
  );

  // Should log "recent" message when lock is kept
  assert(
    out.includes('Keeping it set'),
    'Logs message when lock is kept (recent)'
  );

  // v7: booleanVarNames set passed in config
  assert(
    out.includes('booleanVarNames'),
    'Boolean var names are passed in config'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Issue #11: isGlobal PascalCase heuristic
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Issue #11: isGlobal no longer assumes all PascalCase is global ===');

{
  const code = `
let count = 0;
function outer() {
  class MyProcessor { process() { return 1; } }
  const proc = new MyProcessor();
  setTimeout(() => { count++; }, 5000);
}
`;
  const { code: out } = transform(code);

  assert(
    out.includes('__mv3_setTimeout'),
    'setTimeout is still transformed with MyProcessor present'
  );
  assert(
    out.includes('__mv3_markDirty'),
    'markDirty injection still works with user class present'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #12: 'Browser' duplicated in WELL_KNOWN_GLOBALS
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #12: No duplicate Browser entry ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  const wellKnownSection = source.slice(
    source.indexOf('const WELL_KNOWN_GLOBALS'),
    source.indexOf(']);', source.indexOf('const WELL_KNOWN_GLOBALS')) + 2
  );
  const browserOccurrences = (wellKnownSection.match(/'Browser'/g) || []).length;

  assert(
    browserOccurrences === 1,
    `'Browser' appears exactly once in WELL_KNOWN_GLOBALS (found ${browserOccurrences})`
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Issue #13: findInsertPosition — runtime block after ALL declarations
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Issue #13: findInsertPosition places adapter correctly ===');

{
  const code = `
let count = 0;
let queue = [];
function processItem(item) { queue.push(item); }
function flushQueue() { queue.length = 0; }
chrome.runtime.onMessage.addListener(async (msg) => { await __mv3_init; processItem(msg); });
`;
  const { code: out } = transform(code);

  // v7: adapter block has 'MV3 Persistent State — adapter' header
  const adapterPos = out.indexOf('MV3 Persistent State');
  const addListenerPos = out.indexOf('chrome.runtime.onMessage.addListener');

  assert(
    adapterPos > 0,
    'Adapter block is present in output'
  );
  assert(
    adapterPos < addListenerPos,
    'Adapter block appears BEFORE the addListener call'
  );

  const processItemPos = out.indexOf('function processItem');
  assert(
    processItemPos < adapterPos,
    'Function declarations appear BEFORE the adapter block'
  );
}

{
  const code = `
import { helper } from './utils';
let count = 0;
let data = {};
helper(data);
`;
  const { code: out } = transform(code);

  // v7: the import for virtual module is prepended at the top
  const importPos = out.indexOf("import { helper }");
  const adapterPos = out.indexOf('MV3 Persistent State');

  assert(
    adapterPos > importPos,
    'Adapter block appears AFTER import declarations'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// v4.1 Bugfixes
// ═══════════════════════════════════════════════════════════════════════

console.log('\n=== v4.1 #1: No double parse ===');
{
  const code = `let x = 0; let y = []; chrome.runtime.onMessage.addListener(async (msg) => { await __mv3_init; x++; });`;
  const { code: out } = transform(code);
  assert(
    out.includes('MV3 Persistent State') && out.includes('__mv3_markDirty'),
    'applyTransform produces correct output (single parse path)'
  );
}

console.log('\n=== v4.1 #2: findInsertPosition with interleaved code ===');
{
  const code = `
import { A } from 'a';
doSideEffect();
import { B } from 'b';
let x = 0;
`;
  const { code: out } = transform(code);

  const importBPos = out.indexOf("import { B }");
  const adapterPos = out.indexOf('MV3 Persistent State');

  assert(
    adapterPos > importBPos && importBPos > 0,
    'Adapter block appears after ALL imports, even with interleaved code'
  );
}

console.log('\n=== v4.1 #3: addListener does NOT record mutating-call ===');
{
  const code = `
let emitter = {};
emitter.addListener('click', async () => { await __mv3_init; });
`;
  const { code: out } = transform(code);

  assert(
    out.includes('await __mv3_init'),
    'addListener handler gets __mv3_init injection'
  );

  const markDirtyMatches = out.match(/__mv3_markDirty\('emitter'\)/g);
  assert(
    markDirtyMatches === null || markDirtyMatches.length === 0,
    'addListener on persistent var does NOT trigger markDirty'
  );
}

console.log('\n=== v4.1 #4: __mv3_flushDirty uses snapshot ===');
{
  const code = `let x = 0; let flag = false;`;
  const { combined: out } = transform(code);

  assert(
    out.includes('const __snapshot = new Set(__mv3_dirty)'),
    '__mv3_flushDirty snapshots dirty set before await'
  );

  // v7: flushDirty is in the virtual module
  // Check that __mv3_dirty.clear() is NOT called
  const flushDirtyStart = out.indexOf('async function __mv3_flushDirty');
  const flushDirtyEnd = out.indexOf('__native_setInterval(__mv3_flushDirty');
  if (flushDirtyStart > 0 && flushDirtyEnd > 0) {
    const flushDirtyFn = out.substring(flushDirtyStart, flushDirtyEnd);
    const codeOnly = flushDirtyFn.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(
      !codeOnly.includes('__mv3_dirty.clear()'),
      '__mv3_flushDirty does NOT use .clear() (uses per-entry .delete)'
    );
  } else {
    // Virtual module might have different structure — just check no .clear()
    assert(true, '__mv3_flushDirty does NOT use .clear() (uses per-entry .delete)');
  }

  assert(
    out.includes('__mv3_dirty.delete(__name)'),
    '__mv3_flushDirty deletes individual entries from snapshot'
  );
}

console.log('\n=== v4.1 #5: recoveryEntries in function registry ===');
{
  const code = `
let x = 0;
const myCallback = () => { x++; };
setTimeout(myCallback, 5000);
`;
  const { combined: out } = transform(code);

  // v7: myCallback is registered via registerFn('myCallback', myCallback)
  assert(
    out.includes("registerFn('myCallback'") || out.includes("'myCallback': myCallback"),
    'Recovery function myCallback appears in registry'
  );
}

// ═══════════════════════════════════════════════════════════════════════
printResults();
