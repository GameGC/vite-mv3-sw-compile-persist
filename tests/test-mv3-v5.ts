/**
 * Regression tests for v5 bugfixes:
 *
 *   #1  Expression-body addListener — syntax breakage with () => expr
 *   #3  flushDirty clears dirty on storage error — markers erased on failure
 *   #4  __mv3_closeOffscreenDocument — dead code (never called)
 *   #5  Version header consistency
 *   #6  DECL_TYPES Set created on every call
 *   #7  excludeVars uses Array.includes instead of Set
 */

import {
  assert,
  transform,
  resetCounters,
  getResults,
  printResults,
} from './test-utils-mv3';

resetCounters();

// ═══════════════════════════════════════════════════════════════════════
// Bug #1: Expression-body addListener — syntax breakage
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #1: Expression-body addListener ===');

{
  // Arrow function with expression body: () => handleMsg(msg)
  // Previously: async () => await __mv3_init; handleMsg(msg)  ← syntax error
  // Now: async () => { await __mv3_init; return handleMsg(msg); }
  const src = `
let count = 0;
chrome.runtime.onMessage.addListener(() => handleMsg(msg));
`;
  const { code, virtualModule, combined } = transform(src);

  // Should convert expression body to block body
  assert(
    combined.includes('async ') && combined.includes('{ await __mv3_init; return '),
    'Expression-body addListener is converted to block body with return'
  );

  // Should NOT have the broken pattern: => await __mv3_init;
  // (without the { block body wrapping)
  const addListenerSection = combined.substring(
    combined.indexOf('chrome.runtime.onMessage.addListener'),
    combined.indexOf('chrome.runtime.onMessage.addListener') + 200
  );
  const brokenPattern = /=>\s*await\s+__mv3_init\s*;/;
  // The broken pattern would be "=> await __mv3_init;" without a preceding {
  // The fixed pattern is "=> { await __mv3_init; return ..."
  assert(
    !addListenerSection.match(/=>\s*await\s+__mv3_init\s*;/),
    'No broken expression-body injection pattern'
  );
}

{
  // Block-body addListener should still work normally (no conversion needed)
  const src = `
let count = 0;
chrome.runtime.onMessage.addListener(async (msg) => { handleMsg(msg); });
`;
  const { code, virtualModule, combined } = transform(src);

  assert(
    combined.includes('await __mv3_init'),
    'Block-body addListener still gets __mv3_init injection'
  );

  // Should NOT wrap in return (it's already a block)
  const addListenerSection = combined.substring(
    combined.indexOf('chrome.runtime.onMessage.addListener'),
    combined.indexOf('chrome.runtime.onMessage.addListener') + 300
  );
  assert(
    !addListenerSection.includes('return {'),
    'Block-body addListener does NOT get wrapped in return'
  );
}

{
  // Expression-body with already-async arrow function
  const src = `
let count = 0;
chrome.runtime.onMessage.addListener(async () => handleMsg(msg));
`;
  const { code, virtualModule, combined } = transform(src);

  // Already async — no need to add 'async' again, but still needs block conversion
  assert(
    combined.includes('{ await __mv3_init; return '),
    'Async expression-body addListener also gets block body conversion'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #3: flushDirty clears dirty on storage error
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #3: flushDirty clears dirty on storage error ===');

{
  const src = `let x = 0; let flag = false;`;
  const { code, virtualModule, combined } = transform(src);

  // v7: __mv3_flushDirty is in the virtual module
  const flushDirtyFn = virtualModule.substring(
    virtualModule.indexOf('async function __mv3_flushDirty'),
    virtualModule.indexOf('__native_setInterval(__mv3_flushDirty')
  );

  // The __mv3_dirty.delete loop should be INSIDE the try block (after await storage.set)
  // NOT outside the try/catch
  const tryBlockMatch = flushDirtyFn.match(/try\s*\{/);
  const catchBlockMatch = flushDirtyFn.match(/catch/);

  assert(
    tryBlockMatch !== null && catchBlockMatch !== null,
    '__mv3_flushDirty has try/catch structure'
  );

  // The dirty.delete loop should appear BEFORE the catch block
  const tryPos = flushDirtyFn.indexOf('try {');
  const deletePos = flushDirtyFn.indexOf('__mv3_dirty.delete(__name)');
  const catchMatch = flushDirtyFn.match(/\}\s*catch\s*\(/);
  const catchPos = catchMatch ? flushDirtyFn.indexOf(catchMatch[0]) : -1;

  assert(
    deletePos > tryPos && catchPos > 0 && deletePos < catchPos,
    '__mv3_dirty.delete is INSIDE try block (before catch)'
  );

  // v7: Verify behavior structurally — the catch block should NOT clear dirty markers
  if (catchMatch) {
    const catchStart = flushDirtyFn.indexOf(catchMatch[0]) + catchMatch[0].length;
    const catchBody = flushDirtyFn.substring(catchStart);
    assert(
      !catchBody.includes('__mv3_dirty.delete'),
      'Dirty markers preserved on storage error (catch block does NOT clear them)'
    );
  } else {
    assert(false, 'Could not find catch block to verify dirty marker preservation');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #4: __mv3_closeOffscreenDocument — no longer dead code
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #4: __mv3_closeOffscreenDocument is called ===');

{
  // Use offscreen strategy to generate the offscreen code
  const src = `
let count = 0;
let timer = null;
function tick() { count++; }
timer = setTimeout(tick, 70000);
function stop() { clearTimeout(timer); }
`;
  const { code, virtualModule, combined } = transform(src, { keepaliveStrategy: 'offscreen' });

  // v7: __mv3_closeOffscreenDocument is defined in the virtual module
  assert(
    virtualModule.includes('__mv3_closeOffscreenDocument'),
    '__mv3_closeOffscreenDocument is defined in virtual module'
  );

  // It should be CALLED somewhere (not just defined)
  // Count occurrences: 1 = definition only (dead), 2+ = definition + call(s)
  const definitionCount = (virtualModule.match(/async function __mv3_closeOffscreenDocument/g) || []).length;
  const callCount = (virtualModule.match(/__mv3_closeOffscreenDocument\(\)/g) || []).length;

  assert(
    callCount > 0,
    `__mv3_closeOffscreenDocument is called ${callCount} time(s) (not dead code)`
  );

  // Should be called in clearTimeout/clearInterval when no more alarms
  assert(
    virtualModule.includes('__mv3_alarm_callbacks.size === 0'),
    'closeOffscreenDocument called when alarm_callbacks.size === 0'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #5: Version header consistency
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #5: Version header consistency ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // v7: Header should say v7 (or later)
  assert(
    source.includes('vite-plugin-mv3-persistent  v7'),
    'File header says v7+'
  );

  // v7: Runtime code should also say v7 (or later)
  assert(
    source.includes('vite-plugin-mv3-persistent v7'),
    'Generated runtime code says v7+'
  );

  // Changelog section removed from plugin source
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #6: DECL_TYPES is module-level constant
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #6: DECL_TYPES is module-level constant ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // DECL_TYPES should be defined at module level (outside any function)
  const declTypesPos = source.indexOf('const DECL_TYPES = new Set([');
  const findInsertPosFn = source.indexOf('function findInsertPosition(');

  // DECL_TYPES should appear BEFORE the function definition
  assert(
    declTypesPos > 0 && declTypesPos < findInsertPosFn,
    'DECL_TYPES is defined before findInsertPosition (module-level)'
  );

  // There should be only ONE definition of DECL_TYPES
  const declTypesCount = (source.match(/const DECL_TYPES = new Set/g) || []).length;
  assert(
    declTypesCount === 1,
    `DECL_TYPES is defined exactly once (found ${declTypesCount})`
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #7: excludeVars uses Set instead of Array.includes
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #7: excludeVars uses Set ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // ResolvedOptions should use Set<string>
  assert(
    source.includes('excludeVars: Set<string>'),
    'ResolvedOptions.excludeVars is Set<string>'
  );

  // Should NOT use .includes on excludeVars
  assert(
    !source.includes('opts.excludeVars.includes'),
    'No opts.excludeVars.includes calls (uses .has instead)'
  );

  // Should use .has
  assert(
    source.includes('opts.excludeVars.has'),
    'Uses opts.excludeVars.has for O(1) lookups'
  );

  // DEFAULTS should NOT include excludeVars (it's always overridden)
  assert(
    !source.includes("excludeVars: new Set<string>()"),
    'DEFAULTS does NOT include excludeVars (dead value removed)'
  );

  // DEFAULTS should use Omit type to exclude Set fields
  assert(
    source.includes("Omit<ResolvedOptions,") && source.includes("'excludeVars'"),
    'DEFAULTS uses Omit<ResolvedOptions, ...> to exclude Set fields'
  );
}

{
  // Functional test: excludeVars actually works
  const src = `let keep = 0; let skipMe = 0;`;
  const { code, virtualModule, combined } = transform(src, { excludeVars: ['skipMe'] });

  // 'keep' should be persisted, 'skipMe' should NOT
  assert(
    code.includes("case 'keep':"),
    'keep is in the persistent vars'
  );
  assert(
    !code.includes("case 'skipMe':"),
    'skipMe is excluded from persistent vars'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════
printResults();
if (getResults().failed > 0) {
  process.exit(1);
}
