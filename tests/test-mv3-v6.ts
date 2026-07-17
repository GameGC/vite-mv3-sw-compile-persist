/**
 * Regression tests for v6 bugfixes:
 *
 *   #8  Promise resolver vulnerability — native timers in Promise
 *       executors never resolve after SW restart
 *   #9  Offscreen strategy deficiencies — single-doc conflict and
 *       permission requirement
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
// Bug #8: Promise resolver vulnerability
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #8: Promise resolver vulnerability ===');

{
  // Promise-resolver timers should be detected and wrapped with __mv3_setTimeout
  // even when using 'native' strategy (default) — so tracking works
  const src = `
let x = 0;
const p = new Promise(resolve => setTimeout(resolve, 2000));
`;
  const { code, virtualModule, combined } = transform(src, { promiseResolverStrategy: 'native' });

  // The setTimeout should be replaced with __mv3_setTimeout for tracking
  assert(
    combined.includes('__mv3_setTimeout(resolve, 2000)'),
    'Promise-resolver setTimeout replaced with __mv3_setTimeout (native strategy)'
  );

  // The runtime should include the promise tracking registry
  assert(
    virtualModule.includes('__mv3_promise_pending'),
    'Runtime includes __mv3_promise_pending registry'
  );

  assert(
    virtualModule.includes('__mv3_trackPromiseTimer'),
    'Runtime includes __mv3_trackPromiseTimer function'
  );

  assert(
    virtualModule.includes('__mv3_untrackPromiseTimer'),
    'Runtime includes __mv3_untrackPromiseTimer function'
  );
}

{
  // Promise-resolver with 'alarm' strategy — should fall through to normal conversion
  const src = `
let x = 0;
const p = new Promise(resolve => setTimeout(resolve, 60000));
`;
  const { code, virtualModule, combined } = transform(src, { promiseResolverStrategy: 'alarm' });

  // Should be converted like a normal timer (since alarm strategy falls through)
  assert(
    combined.includes('__mv3_setTimeout'),
    'Promise-resolver with alarm strategy uses __mv3_setTimeout'
  );
}

{
  // Promise-resolver with offscreen strategy and native promiseResolverStrategy
  const src = `
let x = 0;
const p = new Promise(resolve => setTimeout(resolve, 2000));
`;
  const { code, virtualModule, combined } = transform(src, {
    keepaliveStrategy: 'offscreen',
    promiseResolverStrategy: 'native',
  });

  // Should still be wrapped with __mv3_setTimeout
  assert(
    combined.includes('__mv3_setTimeout'),
    'Promise-resolver with offscreen+native uses __mv3_setTimeout'
  );

  // Should have __mv3_native_timer_count for offscreen (in virtual module)
  assert(
    virtualModule.includes('__mv3_native_timer_count'),
    'Runtime includes native timer counter for offscreen'
  );
}

{
  // Non-promise-resolver timers should NOT trigger promise-specific warnings
  const src = `
let x = 0;
function tick() { x++; }
setTimeout(tick, 5000);
`;
  const { code, virtualModule, combined } = transform(src);

  // Regular timer should be converted normally
  assert(
    combined.includes('__mv3_setTimeout(tick, 5000)'),
    'Regular timer converted normally'
  );
}

{
  // Verify the runtime tracks native timers in __mv3_setTimeout
  const src = `let x = 0; setTimeout(() => { x++; }, 2000);`;
  const { code, virtualModule, combined } = transform(src);

  // v7: The __mv3_setTimeout runtime function is in the virtual module
  const setTimeoutFn = virtualModule.substring(
    virtualModule.indexOf('function __mv3_setTimeout'),
    virtualModule.indexOf('function __mv3_setInterval')
  );

  assert(
    setTimeoutFn.includes('__mv3_trackPromiseTimer'),
    '__mv3_setTimeout tracks native timers as potential promise resolvers'
  );

  assert(
    setTimeoutFn.includes('__mv3_untrackPromiseTimer'),
    '__mv3_setTimeout untracks native timers when they fire'
  );
}

{
  // Verify the runtime has promise-resolver restart detection
  const src = `let x = 0;`;
  const { code, virtualModule, combined } = transform(src);

  // v7: The runtime should check for unresolved promises on SW restart (in virtual module)
  assert(
    virtualModule.includes('Unresolved Promise detected from previous SW session'),
    'Runtime warns about unresolved promises from previous session'
  );

  assert(
    virtualModule.includes("promiseResolverStrategy") || virtualModule.includes("promise_"),
    'Runtime references promise tracking in storage keys'
  );
}

{
  // Verify clearTimeout/clearInterval untrack promise timers
  const src = `let x = 0; let t = setTimeout(() => {}, 2000); clearTimeout(t);`;
  const { code, virtualModule, combined } = transform(src);

  // v7: Function definitions are in the virtual module
  const clearTimeoutFn = virtualModule.substring(
    virtualModule.indexOf('function __mv3_clearTimeout'),
    virtualModule.indexOf('function __mv3_clearInterval')
  );

  assert(
    clearTimeoutFn.includes('__mv3_untrackPromiseTimer'),
    '__mv3_clearTimeout untracks promise timers'
  );
}

{
  // Verify clearInterval untracks promise timers
  const src = `let x = 0; let t = setInterval(() => {}, 2000); clearInterval(t);`;
  const { code, virtualModule, combined } = transform(src);

  // v7: Use __mv3_ext.alarms.onAlarm as delimiter (chrome. replaced with __mv3_ext.)
  const clearIntervalFn = virtualModule.substring(
    virtualModule.indexOf('function __mv3_clearInterval'),
    virtualModule.indexOf('__mv3_ext.alarms.onAlarm')
  );

  assert(
    clearIntervalFn.includes('__mv3_untrackPromiseTimer'),
    '__mv3_clearInterval untracks promise timers'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #8 (continued): promiseResolverStrategy option
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #8: promiseResolverStrategy option ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // MV3PersistentOptions should have promiseResolverStrategy
  assert(
    source.includes("promiseResolverStrategy?: 'native' | 'alarm'"),
    'MV3PersistentOptions has promiseResolverStrategy option'
  );

  // ResolvedOptions should have promiseResolverStrategy
  assert(
    source.includes("promiseResolverStrategy: 'native' | 'alarm'"),
    'ResolvedOptions has promiseResolverStrategy'
  );

  // DEFAULTS should include promiseResolverStrategy
  assert(
    source.includes("promiseResolverStrategy: 'native'"),
    'DEFAULTS.promiseResolverStrategy is native'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #9: Offscreen strategy — single-doc conflict
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #9: Offscreen strategy — single-doc conflict ===');

{
  const src = `
let count = 0;
let timer = null;
function tick() { count++; }
timer = setTimeout(tick, 70000);
function stop() { clearTimeout(timer); }
`;
  const { code, virtualModule, combined } = transform(src, { keepaliveStrategy: 'offscreen' });

  // v7: __mv3_offscreen_owned flag is in the virtual module
  assert(
    virtualModule.includes('__mv3_offscreen_owned'),
    'Runtime includes __mv3_offscreen_owned flag'
  );

  // __mv3_closeOffscreenDocument should check the owned flag
  assert(
    virtualModule.includes('if (!__mv3_offscreen_owned) return'),
    '__mv3_closeOffscreenDocument checks owned flag before closing'
  );

  // __mv3_ensureOffscreenDocument should set owned = false when doc already exists
  assert(
    virtualModule.includes('__mv3_offscreen_owned = false'),
    'ensureOffscreenDocument sets owned = false when doc already exists'
  );

  // __mv3_ensureOffscreenDocument should set owned = true when WE create the doc
  assert(
    virtualModule.includes('__mv3_offscreen_owned = true'),
    'ensureOffscreenDocument sets owned = true when plugin creates the doc'
  );
}

{
  // When offscreen doc already exists (created by extension for other purposes),
  // the plugin should NOT close it when timers are done
  const src = `
let count = 0;
function tick() { count++; }
setTimeout(tick, 70000);
`;
  const { code, virtualModule, combined } = transform(src, { keepaliveStrategy: 'offscreen' });

  // v7: The closeOffscreenDocument function is in the virtual module
  const closeStart = virtualModule.indexOf('async function __mv3_closeOffscreenDocument');
  const closeEnd = virtualModule.indexOf('// ── Function registry', closeStart);
  const closeFn = closeStart > 0 && closeEnd > closeStart
    ? virtualModule.substring(closeStart, closeEnd)
    : '';

  assert(
    closeFn.includes('if (!__mv3_offscreen_owned) return'),
    'closeOffscreenDocument has ownership guard — only closes docs we created'
  );

  assert(
    closeFn.includes('__mv3_offscreen_owned = false'),
    'closeOffscreenDocument resets owned flag after closing'
  );
}

{
  // For non-offscreen strategies, __mv3_offscreen_owned should NOT appear
  const src = `let count = 0; setTimeout(() => {}, 70000);`;
  const { code, virtualModule, combined } = transform(src, { keepaliveStrategy: 'alarm' });

  assert(
    !combined.includes('__mv3_offscreen_owned'),
    'No __mv3_offscreen_owned for alarm strategy (not needed)'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Bug #9 (continued): Offscreen permission warning
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Bug #9: Offscreen permission warning ===');

{
  const { readFileSync } = require('fs');
  const source = readFileSync('/home/z/my-project/download/mv3-persistent-plugin.ts', 'utf-8');

  // The plugin should warn about offscreen permission at config time
  assert(
    source.includes("keepaliveStrategy is 'offscreen'") &&
    source.includes("'offscreen' permission"),
    'Plugin warns about offscreen permission requirement'
  );

  // The warning should mention manifest.json
  assert(
    source.includes('manifest.json'),
    'Warning mentions manifest.json'
  );

  // The warning should mention Chrome Web Store moderation
  assert(
    source.includes('Chrome Web Store moderation') || source.includes('CWS moderation'),
    'Warning mentions Chrome Web Store moderation'
  );

  // The warning should mention single-doc conflict
  assert(
    source.includes('only ONE offscreen document') || source.includes('only one offscreen'),
    'Warning mentions single-document conflict'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Version header checks
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Version v7 header consistency ===');

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
// Backward compatibility: ensure existing features still work
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Backward compatibility ===');

{
  // Basic transform still works
  const src = `
let count = 0;
let config = { name: 'test' };
function tick() { count++; }
setTimeout(tick, 70000);
chrome.runtime.onMessage.addListener((msg) => { handleMsg(msg); });
`;
  const { code, virtualModule, combined } = transform(src);

  assert(
    combined.includes('__mv3_init'),
    'Basic transform still injects __mv3_init'
  );

  assert(
    combined.includes('__mv3_setTimeout'),
    'Timer replacement still works'
  );

  assert(
    combined.includes('await __mv3_init'),
    'Event handler init injection still works'
  );

  assert(
    combined.includes('async'),
    'Event handlers still made async'
  );
}

{
  // Proxy strategy still works
  const src = `let config = { name: 'test' };`;
  const { code, virtualModule, combined } = transform(src, { strategy: 'proxy' });

  assert(
    combined.includes('__mv3_reactive'),
    'Proxy strategy still generates reactive wrappers'
  );
}

{
  // excludeVars still works with the Set conversion
  const src = `let keep = 0; let skipMe = 0;`;
  const { code, virtualModule, combined } = transform(src, { excludeVars: ['skipMe'] });

  assert(
    code.includes("case 'keep':"),
    'keep is in persistent vars'
  );
  assert(
    !code.includes("case 'skipMe':"),
    'skipMe is excluded from persistent vars'
  );
}

{
  // persistentVars still works
  const src = `let a = 0; let b = 0; let c = 0;`;
  const { code, virtualModule, combined } = transform(src, { persistentVars: ['a', 'c'] });

  assert(
    code.includes("case 'a':"),
    'a is in persistent vars'
  );
  assert(
    !code.includes("case 'b':"),
    'b is NOT in persistent vars (not in persistentVars list)'
  );
  assert(
    code.includes("case 'c':"),
    'c is in persistent vars'
  );
}

{
  // Stale-lock recovery still works
  const src = `let isProcessing = false;`;
  const { code, virtualModule, combined } = transform(src);

  // v7: lockAge_ is in the virtual module (runtime code)
  assert(
    virtualModule.includes('lockAge_'),
    'Stale-lock recovery with lockAge key still present'
  );

  assert(
    virtualModule.includes('__mv3_staleThreshold') || combined.includes('staleLockThreshold'),
    'Stale-lock threshold still referenced'
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════
printResults();
if (getResults().failed > 0) {
  process.exit(1);
}
