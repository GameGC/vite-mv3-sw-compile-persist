/**
 * Regression tests for v6.1 bugfixes:
 *
 *   #1  promiseResolverStrategy: 'alarm' — resolve not in fn_registry,
 *       recovery after SW restart impossible. JSDoc was misleading.
 *   #2  AssignmentInfo.kind type mismatch — 'deep-mutation' not in union
 *   #3  kind computed but never read — dead field, removed entirely
 *   #4  Promise-resolver detection through nested functions —
 *       path.getFunctionParent() only returns nearest ancestor
 *   #5  Double full-storage read at startup — merged into single IIFE
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
// Bug #1: promiseResolverStrategy: 'alarm' — resolve not in fn_registry
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #1: promiseResolverStrategy alarm — resolve not recoverable ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // The JSDoc should now correctly state that 'alarm' does NOT make
  // the Promise survive restarts — resolve is an anonymous parameter
  assert(
    source.includes('does NOT make') && source.includes('resolve') && source.includes('cannot be persisted'),
    "JSDoc correctly states alarm does NOT make Promise survive restarts"
  );

  // v7: JSDoc text was updated — "The alarm fires but with no callback, it is a no-op."
  assert(
    source.includes('The alarm fires but with no callback') && source.includes('no-op'),
    "JSDoc documents that alarm fires but callback is a no-op"
  );

  // The JSDoc should NOT claim 'survive restarts' for promise resolvers
  const alarmJSDoc = source.substring(
    source.indexOf("'alarm'"),
    source.indexOf("promiseResolverStrategy?: 'native' | 'alarm'")
  );
  assert(
    !alarmJSDoc.includes('survive SW restarts') || alarmJSDoc.includes('does NOT make'),
    "JSDoc no longer misleadingly claims 'survive SW restarts' for alarm+promise"
  );
}

{
  // With 'alarm' strategy, the promise-resolver timer should still be
  // converted to __mv3_setTimeout (which uses chrome.alarms for long delays)
  const src = `
let x = 0;
const p = new Promise(resolve => setTimeout(resolve, 120000));
`;
  const { code, virtualModule, combined } = transform(src, { promiseResolverStrategy: 'alarm' });

  assert(
    combined.includes('__mv3_setTimeout(resolve, 120000)'),
    'Alarm strategy still wraps promise-resolver with __mv3_setTimeout'
  );

  // The resolve callback won't be in the function registry, so on restart
  // the alarm will fire but the callback won't be found — logged as warning.
  // This is the expected behavior now documented in the JSDoc.
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #2 + #3: AssignmentInfo.kind — type mismatch and dead field
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #2+#3: AssignmentInfo.kind — removed dead field ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // AssignmentInfo should NOT have a 'kind' field anymore
  const assignmentInfoMatch = source.match(/interface AssignmentInfo \{[^}]+\}/s);
  assert(
    assignmentInfoMatch !== null && !assignmentInfoMatch[0].includes('kind'),
    'AssignmentInfo interface no longer has a kind field'
  );

  // No 'deep-mutation' string should exist in the source code
  // (changelog removed, so search entire source)
  assert(
    !source.includes("'deep-mutation'"),
    "No 'deep-mutation' string in source code (removed with kind field)"
  );

  // No 'mutating-call' string should exist in the source code
  assert(
    !source.includes("'mutating-call'"),
    "No 'mutating-call' string in source code (removed with kind field)"
  );

  // No 'compound-assign' string should exist in the source code
  assert(
    !source.includes("'compound-assign'"),
    "No 'compound-assign' string in source code (removed with kind field)"
  );
}

{
  // Functional test: assignments still get markDirty injected
  const src = `
let config = { name: 'test' };
config.name = 'updated';
config.count = 1;
`;
  const { code, virtualModule, combined } = transform(src);

  assert(
    combined.includes("__mv3_markDirty('config')"),
    'markDirty still injected for deep mutation (config.name = ...)'
  );
}

{
  // Functional test: method call mutations still get markDirty
  const src = `
let items = [];
items.push(1);
`;
  const { code, virtualModule, combined } = transform(src);

  assert(
    combined.includes("__mv3_markDirty('items')"),
    'markDirty still injected for mutating call (items.push(...))'
  );
}

{
  // Functional test: direct assignment still works
  const src = `
let count = 0;
count = 5;
`;
  const { code, virtualModule, combined } = transform(src);

  assert(
    combined.includes("__mv3_markDirty('count')"),
    'markDirty still injected for direct assignment (count = 5)'
  );
}

{
  // Functional test: compound assignment still works
  const src = `
let count = 0;
count += 1;
`;
  const { code, virtualModule, combined } = transform(src);

  assert(
    combined.includes("__mv3_markDirty('count')"),
    'markDirty still injected for compound assignment (count += 1)'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #4: Promise-resolver detection through nested functions
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #4: Promise-resolver detection through nested functions ===');

{
  // Direct (already worked): new Promise(r => setTimeout(r, d))
  const src1 = `
let x = 0;
const p = new Promise(r => setTimeout(r, 2000));
`;
  const { code: code1, virtualModule: vm1, combined: combined1 } = transform(src1);
  assert(
    combined1.includes('__mv3_setTimeout(r, 2000)'),
    'Direct promise-resolver still detected'
  );
}

{
  // Nested function inside executor:
  // new Promise(r => { function inner() { setTimeout(r, d) } inner() })
  const src2 = `
let x = 0;
const p = new Promise(r => {
  function inner() { setTimeout(r, 2000); }
  inner();
});
`;
  const { code: code2, virtualModule: vm2, combined: combined2 } = transform(src2);
  assert(
    combined2.includes('__mv3_setTimeout(r, 2000)'),
    'Nested function promise-resolver detected (setTimeout inside inner() inside executor)'
  );
}

{
  // Arrow function inside executor:
  // new Promise(r => { const fn = () => setTimeout(r, d); fn(); })
  const src3 = `
let x = 0;
const p = new Promise(r => {
  const fn = () => setTimeout(r, 2000);
  fn();
});
`;
  const { code: code3, virtualModule: vm3, combined: combined3 } = transform(src3);
  assert(
    combined3.includes('__mv3_setTimeout(r, 2000)'),
    'Arrow function promise-resolver detected (setTimeout inside arrow inside executor)'
  );
}

{
  // Deeply nested:
  // new Promise(r => { function a() { function b() { setTimeout(r, d) } b() } a() })
  const src4 = `
let x = 0;
const p = new Promise(r => {
  function a() {
    function b() { setTimeout(r, 2000); }
    b();
  }
  a();
});
`;
  const { code: code4, virtualModule: vm4, combined: combined4 } = transform(src4);
  assert(
    combined4.includes('__mv3_setTimeout(r, 2000)'),
    'Deeply nested promise-resolver detected (2 levels of nesting)'
  );
}

{
  // NOT a promise-resolver: regular setTimeout in a regular function
  // Check by verifying the timer is NOT classified as promise-resolver
  // (the runtime contains 'Promise-resolver' in comments, so check the
  // actual timer replacement pattern instead)
  const src5 = `
let x = 0;
function tick() { x++; }
setTimeout(tick, 2000);
`;
  const { code: code5, virtualModule: vm5, combined: combined5 } = transform(src5);
  // Regular named-ref timer: setTimeout(tick, 2000) → __mv3_setTimeout(tick, 2000)
  // This is different from promise-resolver which wraps the raw 'resolve' param
  assert(
    combined5.includes('__mv3_setTimeout(tick, 2000)'),
    'Regular setTimeout with named function still works (named-ref, not promise-resolver)'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #5: Double full-storage read merged into single IIFE
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #5: Double storage.get(null) merged ===');

{
  const src = `
let x = 0;
setTimeout(() => { x++; }, 70000);
`;
  const { code, virtualModule, combined } = transform(src);

  // v7: Only ONE actual await __mv3_storage.get(null) call in the virtual module
  const actualGets = (virtualModule.match(/await __mv3_storage\.get\(null\)/g) || []).length;
  assert(
    actualGets === 1,
    `Only 1 actual storage.get(null) call in runtime (found ${actualGets})`
  );

  // The merged IIFE should handle both alarm re-registration AND promise check
  // v7: Find the merged IIFE section in the virtual module
  const mergedIifeStart = virtualModule.indexOf('Re-register pending alarms + check unresolved promises');
  assert(
    mergedIifeStart > 0,
    'Merged IIFE comment found in virtual module (handles both alarms and promises)'
  );

  // The merged IIFE should contain both alarm_ and promise_ key checks
  const mergedIifeSection = virtualModule.substring(mergedIifeStart, mergedIifeStart + 2000);
  assert(
    mergedIifeSection.includes("startsWith(__mv3_prefix + 'alarm_')") &&
    mergedIifeSection.includes("startsWith(__mv3_prefix + 'promise_')"),
    'Merged IIFE checks both alarm_ and promise_ keys'
  );
}

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // The source should not have two separate storage.get(null) IIFEs
  // Count actual IIFE blocks with storage.get(null)
  const iifeWithGetNull = source.match(/\(async\s*\(\)\s*=>\s*\{[^}]*__mv3_storage\.get\(null\)/g) || [];
  assert(
    iifeWithGetNull.length === 1,
    `Source has exactly 1 IIFE with storage.get(null) (found ${iifeWithGetNull.length})`
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Version header checks
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Version v7 header consistency ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // v7: Header should say v7
  assert(
    source.includes('vite-plugin-mv3-persistent  v7'),
    'File header says v7'
  );

  // v7: Runtime code should say v7
  assert(
    source.includes('vite-plugin-mv3-persistent v7'),
    'Generated runtime code says v7'
  );

  // Changelog section removed from plugin source
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════
printResults();
if (getResults().failed > 0) {
  process.exit(1);
}
