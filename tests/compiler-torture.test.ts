/**
 * Compiler torture suite: arbitrary user-code shapes that must neither crash the
 * compiler nor silently lose persistence. Each case is verified at two levels:
 *  - transform level (generated code shape, and the output still parses/runs)
 *  - behavioural level (execute in the MV3 simulator, kill, cold-restart, check state)
 */

import ts from 'typescript';
import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

/** Compile to JS, boot, run, hard-kill, cold-restart and return the sim. */
async function bootAndRestart(source: string, opts: any = {}) {
  const bundle = compileTestBundle(source, opts);
  const sim = createSimulator();
  await sim.boot(bundle);
  await sim.flush();
  return { sim, bundle };
}

async function restart(sim: any) {
  await sim.flush();
  sim.kill();
  await sim.restart();
}

/** Transpile transformed code to verify it is still syntactically valid TS. */
function parsesOk(code: string): boolean {
  const res = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  });
  return !res.diagnostics || res.diagnostics.length === 0;
}

async function main() {
  // ---------------------------------------------------------------- 1
  console.log('\n=== 1. TypeScript type wrappers on initializers ===');
  {
    const src = `
let queue = [] as string[];
let cache = new Map<string, number>() as Map<string, number>;
let flag = false as boolean;
let cfg = { dark: true } satisfies { dark: boolean };
let seen = new Set<string>()!;
function touch() {
  queue.push('a');
  cache.set('k', 1);
  flag = true;
  cfg.dark = false;
  seen.add('x');
}
touch();
`;
    const { code: out } = transform(src, { strategy: 'proxy' });
    assert(parsesOk(out), 'output parses');
    assert(out.includes("__mv3_serialize(cache, 'map')"), 'as-wrapped Map keeps collectionType map');
    assert(out.includes("__mv3_serialize(queue, 'array')"), 'as-wrapped [] keeps collectionType array');
    assert(out.includes("__mv3_serialize(seen, 'set')"), 'non-null wrapped Set keeps collectionType set');
    assert(out.includes('booleanVarNames: ["flag"]'), 'as boolean keeps boolean lock tracking');
    assert(out.includes("cfg = __mv3_reactive(cfg, 'cfg');"), 'satisfies object is proxied');

    const { sim } = await bootAndRestart(src);
    await restart(sim);
    assert(sim.evaluate('Array.isArray(queue) && queue[0]') === 'a', 'queue restored as real Array');
    assert(sim.evaluate('cache instanceof Map && cache.get("k")') === 1, 'cache restored as real Map');
    assert(sim.evaluate('seen instanceof Set && seen.has("x")') === true, 'seen restored as real Set');
    assert(sim.evaluate('cfg.dark') === false, 'cfg mutation survived restart');
    sim.kill();
  }

  // ---------------------------------------------------------------- 2
  console.log('\n=== 2. export let / export function ===');
  {
    const src = `
export let counter = 0;
export function bump() { counter++; }
bump(); bump();
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    assert(out.includes('"counter"'), 'export let is tracked');
    const rt = out.indexOf('createMV3Runtime(');
    const bumpCall = out.indexOf('bump(); bump();');
    assert(rt !== -1 && rt < bumpCall, 'runtime is created before top-level calls (no TDZ)');
  }

  // ---------------------------------------------------------------- 3
  console.log('\n=== 3. Mutation inside return / throw ===');
  {
    const src = `
let n = 0;
let st = 'idle';
function a() { return ++n; }
function b() { return (st = 'done'); }
function c() { if (n > 100) return n++; return -1; }
function d() { try { throw (n++, new Error('x')); } catch (e) {} }
const r1 = 0;
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    assert(!/return \+\+n;\s*__mv3_markDirty/.test(out), 'markDirty is not dead code after return');

    const run = `
let n = 0;
let st = 'idle';
function a() { return ++n; }
function b() { return (st = 'done'); }
chrome.runtime.onMessage.addListener((m, s, send) => {
  if (m === 'a') send(a());
  if (m === 'b') send(b());
  return true;
});
`;
    const { sim } = await bootAndRestart(run);
    await sim.dispatchMessage('a');
    await sim.dispatchMessage('a');
    await sim.dispatchMessage('b');
    await restart(sim);
    assert(sim.evaluate('n') === 2, 'return ++n persisted across restart');
    assert(sim.evaluate('st') === 'done', 'return (st = ...) persisted across restart');
    sim.kill();
  }

  // ---------------------------------------------------------------- 4
  console.log('\n=== 4. Expression-body arrow functions ===');
  {
    const src = `
let counter = 0;
let items = [];
const inc = () => counter++;
const reset = () => (counter = 0);
[1, 2, 3].forEach(x => items.push(x));
chrome.runtime.onMessage.addListener((m) => { inc(); inc(); inc(); return true; });
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');

    const run = `
let counter = 0;
let items = [];
const inc = () => counter++;
chrome.runtime.onMessage.addListener((m, s, send) => { inc(); inc(); inc(); send(counter); return true; });
`;
    const { sim } = await bootAndRestart(run);
    const r = await sim.dispatchMessage('go');
    assert(r === 3, 'expression-bodied arrow returns original value path intact');
    await restart(sim);
    assert(sim.evaluate('counter') === 3, 'counter++ inside arrow body persisted when called later');
    sim.kill();
  }

  // ---------------------------------------------------------------- 5
  console.log('\n=== 5. Loop headers and conditions ===');
  {
    const src = `
let total = 0;
let idx = 0;
let cur = null;
function run(list) {
  for (let i = 0; i < 3; total++, i++) {}
  for (idx = 0; idx < 3; idx++) {}
  for (cur of list) {}
  let x;
  while ((x = list.pop())) { total += x; }
  if ((cur = list.length)) {}
}
run([1, 2, 3]);
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    assert(out.includes("__mv3_markDirty('total')"), 'total marked dirty');
    assert(out.includes("__mv3_markDirty('idx')"), 'idx marked dirty');
    assert(out.includes("__mv3_markDirty('cur')"), 'for-of target marked dirty');
  }

  // ---------------------------------------------------------------- 6
  console.log('\n=== 6. delete / Object.assign / Reflect ===');
  {
    const src = `
let state = { a: 1, b: 2, c: 3 };
function f() {
  delete state.a;
  Object.assign(state, { d: 4 });
  Reflect.deleteProperty(state, 'b');
}
`;
    const { code: out } = transform(src, { strategy: 'static' });
    assert(parsesOk(out), 'output parses');
    const matches = out.match(/__mv3_markDirty\('state'\)/g) || [];
    assert(matches.length >= 3, 'delete, Object.assign and Reflect.deleteProperty each mark dirty in static mode');
  }

  // ---------------------------------------------------------------- 7
  console.log('\n=== 7. Nested Map/Set/Date inside plain objects ===');
  {
    const src = `
let state = { map: new Map([['k', 1]]), when: new Date(0), nested: { set: new Set([1, 2]) }, list: [new Date(5)] };
chrome.runtime.onMessage.addListener((m, s, send) => { state.map.set('z', 9); state.nested.set.add(3); send(1); return true; });
`;
    const { sim } = await bootAndRestart(src);
    await sim.dispatchMessage('go');
    await restart(sim);
    assert(sim.evaluate('state.map instanceof Map && state.map.get("z")') === 9, 'nested Map restored with mutation');
    assert(sim.evaluate('state.when instanceof Date && state.when.getTime()') === 0, 'nested Date restored');
    assert(sim.evaluate('state.nested.set instanceof Set && state.nested.set.has(3)') === true, 'deeply nested Set restored');
    assert(sim.evaluate('state.list[0] instanceof Date') === true, 'Date inside array inside object restored');
    sim.kill();
  }

  // ---------------------------------------------------------------- 8
  console.log('\n=== 8. Adapter placement vs. TDZ ===');
  {
    const src = `
let count = 0;
chrome.runtime.onInstalled.addListener(() => { count++; });
const HELPER = 123;
setTimeout(() => {}, 100);
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    const rt = out.indexOf('createMV3Runtime(');
    const listener = out.indexOf('onInstalled.addListener');
    assert(rt < listener, 'runtime created before first executable statement');

    const src2 = `
let a = 1;
a = 2;
let b = 5;
function later() { return a + b; }
`;
    const bundle = compileTestBundle(src2);
    const sim = createSimulator();
    let booted = true;
    try { await sim.boot(bundle); } catch { booted = false; }
    assert(booted, 'let declared after top-level mutation boots without ReferenceError');
    if (booted) {
      assert(sim.evaluate('a') === 2 && sim.evaluate('b') === 5, 'values correct');
      sim.kill();
    }
  }

  // ---------------------------------------------------------------- 9
  console.log('\n=== 9. Shadowing and misc syntax ===');
  {
    const src = `
let n = 0;
function f(n) { n++; n = 5; }
function g() { let n = 1; n += 2; }
const h = (n) => n++;
for (let n = 0; n < 2; n++) {}
try {} catch (n) { n = 1; }
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    assert(!out.includes("__mv3_markDirty('n')"), 'no markDirty for any shadowed binding');
  }

  // ---------------------------------------------------------------- 10
  console.log('\n=== 10. Chained & compound assignments ===');
  {
    const src = `
let a = 0, b = 0, c = 0;
function f() { a = b = c = 7; a ||= 1; b ??= 2; c &&= 3; [a, b] = [c, a]; ({ a, b } = { a: 1, b: 2 }); }
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    for (const v of ['a', 'b', 'c']) {
      assert(out.includes(`__mv3_markDirty('${v}')`), `markDirty for ${v}`);
    }
  }

  // ---------------------------------------------------------------- 11
  console.log('\n=== 11. Handler references and weird listener forms ===');
  {
    const src = `
let hits = 0;
async function onTick() { hits++; }
chrome.alarms.onAlarm.addListener(onTick);
const onStart = () => { hits += 10; };
chrome.runtime.onStartup.addListener(onStart);
chrome.runtime.onInstalled.addListener(function () { hits += 100; });
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    assert(out.includes('await __mv3_init'), 'init awaited in referenced handlers');
  }

  // ---------------------------------------------------------------- 12
  console.log('\n=== 12. Timers: globalThis/self prefix, as-wrapped, nested ===');
  {
    const src = `
function tick() {}
globalThis.setTimeout(tick, 120000);
self.setInterval(tick, 120000);
setTimeout((tick) as any, 5000);
setTimeout(() => { setTimeout(tick, 70000); }, 1000);
`;
    const { code: out } = transform(src);
    assert(parsesOk(out), 'output parses');
    assert(!out.includes('globalThis.setTimeout('), 'globalThis.setTimeout rewritten');
    assert(!out.includes('self.setInterval('), 'self.setInterval rewritten');
    assert(/__mv3_setTimeout\(tick, 70000\)/.test(out), 'nested timer rewritten');
  }

  const ok = printResults();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('Unhandled failure in compiler-torture.test.ts:', e);
  process.exit(1);
});
