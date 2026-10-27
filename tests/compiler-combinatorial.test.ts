/**
 * Differential combinatorial test.
 *
 * mutation form x syntactic context x state strategy:
 *  - reference: run the ORIGINAL code untransformed, snapshot { v, o }
 *  - subject:   compile with the plugin, run in the MV3 simulator, hard-kill,
 *               cold-restart, snapshot { v, o } from persisted storage
 * The two snapshots must be identical, and the transformed code must be valid.
 */

import ts from 'typescript';
import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

const PRELUDE = `let v = 0;\nlet o = { n: 0, x: 1, arr: [] as number[] };\n`;

// Each form mutates persistent state and is a valid *expression*.
const MUTATIONS: Record<string, string> = {
  'v++': 'v++',
  '++v': '++v',
  'v = v + 1': 'v = v + 1',
  'v += 2': 'v += 2',
  'v ||= 9': 'v ||= 9',
  'o.n++': 'o.n++',
  'o.n = o.n + 1': 'o.n = o.n + 1',
  'o.arr.push': 'o.arr.push(7)',
  'delete o.x': 'delete o.x',
  'Object.assign': 'Object.assign(o, { z: 1 })',
  'chained': 'v = o.n = 4',
  'comma': '(v++, o.n++)',
  'ternary': 'v ? (o.n = 3) : (v = 3)',
  'in call arg': 'String(v = 8)',
  'as-cast': '(v as number)++',
};

// Each context embeds EXPR and defines callable `f` (invoked as f(true)).
const CONTEXTS: Record<string, string> = {
  'stmt': `function f(c) { EXPR; }`,
  'return': `function f(c) { return EXPR; }`,
  'arrow expr': `const f = (c) => EXPR;`,
  'arrow paren': `const f = (c) => (EXPR);`,
  'arrow block': `const f = (c) => { return EXPR; };`,
  'fn expr': `const f = function (c) { return EXPR; };`,
  'if bare': `function f(c) { if (c) EXPR; }`,
  'if/else bare': `function f(c) { if (!c) {} else EXPR; }`,
  'if else-if': `function f(c) { if (!c) {} else if (c) EXPR; else {} }`,
  'if test': `function f(c) { if (EXPR) {} }`,
  'for bare': `function f(c) { for (let i = 0; i < 2; i++) EXPR; }`,
  'for update': `function f(c) { for (let i = 0; i < 2; i++, EXPR) {} }`,
  'for-of bare': `function f(c) { for (const k of [1, 2]) EXPR; }`,
  'while bare': `function f(c) { let i = 0; while (i++ < 2) EXPR; }`,
  'while test': `function f(c) { let i = 0; while (i++ < 2 && (EXPR, true)) {} }`,
  'do-while': `function f(c) { do EXPR; while (false); }`,
  'try/finally': `function f(c) { try { EXPR; } finally {} }`,
  'catch': `function f(c) { try { throw 1; } catch (e) { EXPR; } }`,
  'switch': `function f(c) { switch (1) { case 1: EXPR; break; } }`,
  'switch default fallthrough': `function f(c) { switch (2) { case 1: break; default: EXPR; } }`,
  'label': `function f(c) { l: { EXPR; break l; } }`,
  'var init': `function f(c) { const x = EXPR; }`,
  'callback map': `function f(c) { return [1].map(() => EXPR)[0]; }`,
  'callback forEach': `function f(c) { [1, 2].forEach(x => EXPR); }`,
  'logical &&': `function f(c) { c && (EXPR); }`,
  'sequence return': `function f(c) { return (EXPR, 1); }`,
  'class method': `class K { m() { return EXPR; } }\nconst f = () => new K().m();`,
  'object method': `const obj = { m() { EXPR; } };\nconst f = () => obj.m();`,
  'async': `async function f(c) { await 0; EXPR; }`,
  'async arrow expr': `const f = async (c) => EXPR;`,
  'generator drive': `function* g() { EXPR; yield 1; }\nconst f = () => { [...g()]; };`,
  'nested fn': `function f(c) { function inner() { EXPR; } inner(); }`,
  'iife': `function f(c) { (() => { EXPR; })(); }`,
  'ts non-null': `function f(c) { (EXPR)!; }`,
};

const STRATEGIES: Array<'static' | 'proxy'> = ['static', 'proxy'];

function stripTs(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText;
}

async function reference(source: string): Promise<string> {
  const js = stripTs(source);
  const fn = new Function(
    `${js}\nreturn Promise.resolve(f(true)).then(() => JSON.stringify({ v, o }));`,
  );
  return fn();
}

function parsesOk(code: string): boolean {
  const r = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  });
  return !r.diagnostics || r.diagnostics.length === 0;
}

async function main() {
  let combos = 0;
  const failures: string[] = [];

  for (const [mName, mExpr] of Object.entries(MUTATIONS)) {
    for (const [cName, cTpl] of Object.entries(CONTEXTS)) {
      const body = cTpl.replace(/EXPR/g, mExpr);
      const source = `${PRELUDE}${body}\n`;

      let ref: string;
      if (!parsesOk(source)) continue; // the ORIGINAL source is invalid: not a plugin concern
      try {
        ref = await reference(source);
      } catch {
        continue; // combination throws at runtime even without the plugin
      }

      const runnable =
        source +
        `chrome.runtime.onMessage.addListener((m, s, send) => {\n` +
        `  Promise.resolve(f(true)).then(() => send(1), () => send(0));\n` +
        `  return true;\n` +
        `});\n`;

      for (const strategy of STRATEGIES) {
        combos++;
        const label = `[${strategy}] ${mName}  @  ${cName}`;
        try {
          const { code: out } = transform(runnable, { strategy });
          if (!parsesOk(out)) {
            failures.push(`${label}: transformed code does not parse`);
            continue;
          }

          const bundle = compileTestBundle(runnable, { strategy });
          const sim = createSimulator();
          await sim.boot(bundle);
          await sim.dispatchMessage('go');
          await sim.flush();
          sim.kill();
          await sim.restart();
          const got = sim.evaluate('JSON.stringify({ v, o })');
          sim.kill();

          if (got !== ref) {
            failures.push(`${label}: expected ${ref} but after cold restart got ${got}`);
          }
        } catch (e: any) {
          failures.push(`${label}: threw ${e?.message ?? e}`);
        }
      }
    }
  }

  console.log(`\nCombinations executed: ${combos}`);
  assert(combos > 500, `exercised a large matrix (${combos} combos)`);
  assert(failures.length === 0, `all combinations survive kill + cold restart identically to untransformed code (${failures.length} failures)`);
  for (const f of failures.slice(0, 60)) console.log('  FAILED ' + f);
  if (failures.length > 60) console.log(`  ... and ${failures.length - 60} more`);

  process.exit(printResults() ? 0 : 1);
}

main().catch((e) => {
  console.error('Unhandled failure in compiler-combinatorial.test.ts:', e);
  process.exit(1);
});
