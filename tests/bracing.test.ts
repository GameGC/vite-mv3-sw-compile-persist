import { analyze } from '../src/analyzer.js';
import { applyTransform } from '../src/transformer.js';
import { DEFAULTS } from '../src/types.js';

const opts = {
  ...DEFAULTS,
  persistentVars: new Set(),
  excludeVars: new Set(),
  safeClosureVars: new Set(),
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

// --- Bare if body ---

console.log('\n=== Bare if body ===');
{
  const code = `let obj = { x: 0 };\nif (cond) obj.x = 1;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing=true for bare if body');
    assert(result.assignments[0].varName === 'obj', 'varName is obj');
  }
}

// --- Braced if body ---

console.log('\n=== Braced if body ===');
{
  const code = `let obj = { x: 0 };\nif (cond) { obj.x = 1; }\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === false, 'needsBracing=false for braced if body');
  }
}

// --- Bare for body ---

console.log('\n=== Bare for body ===');
{
  const code = `let obj = { x: 0 };\nfor (let i = 0; i < n; i++) obj.x += i;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing=true for bare for body');
  }
}

// --- Bare while body ---

console.log('\n=== Bare while body ===');
{
  const code = `let obj = { x: 0 };\nwhile (cond) obj.x = 1;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing=true for bare while body');
  }
}

// --- Top-level assignment ---

console.log('\n=== Top-level assignment ===');
{
  const code = `let obj = { x: 0 };\nobj.x = 1;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === false, 'needsBracing=false for top-level');
  }
}

// --- Full transform: bare if ---

console.log('\n=== Full transform: bare if ===');
{
  const code = `let obj = { x: 0 };\nif (cond) obj.x = 1;\n`;
  let virtualCode = '';
  const result = applyTransform(code, opts, (v) => { virtualCode = v; });
  const out = result.code;

  assert(out.includes('{ obj.x = 1;') || out.includes('{ obj.x=1;'), 'Opening brace before obj.x = 1');
  assert(out.includes("__mv3_markDirty('obj'); }"), 'markDirty inside closing brace');
}

// --- Full transform: bare else ---

console.log('\n=== Full transform: bare else ===');
{
  const code = `let obj = { x: 0 };\nif (cond) foo(); else obj.x = 1;\n`;
  let virtualCode = '';
  const result = applyTransform(code, opts, (v) => { virtualCode = v; });
  const out = result.code;

  assert(out.includes('else {'), 'else has opening brace');
  assert(out.includes("__mv3_markDirty('obj'); }"), 'markDirty inside else closing brace');
}

// --- Method call in bare if body ---

console.log('\n=== Method call in bare if body ===');
{
  const code = `let arr = [1, 2];\nif (cond) arr.push(3);\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment (method call)');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing=true for method call in bare if');
    assert(result.assignments[0].isFullReassignment === false, 'isFullReassignment=false for method call');
  }
}

// --- Bare do-while body ---

console.log('\n=== Bare do-while body ===');
{
  const code = `let obj = { x: 0 };\ndo obj.x = 1; while (cond);\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing=true for bare do-while');
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
