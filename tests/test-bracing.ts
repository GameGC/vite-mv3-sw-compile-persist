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
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 1: Bare if body — needsBracing should be true
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 1. Bare if body ===');
{
  const code = `let obj = { x: 0 };\nif (cond) obj.x = 1;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing is true for bare if body');
    assert(result.assignments[0].varName === 'obj', 'varName is obj');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 2: Braced if body — needsBracing should be false
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 2. Braced if body ===');
{
  const code = `let obj = { x: 0 };\nif (cond) { obj.x = 1; }\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === false, 'needsBracing is false for braced if body');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 3: Bare for body
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 3. Bare for body ===');
{
  const code = `let obj = { x: 0 };\nfor (let i = 0; i < n; i++) obj.x += i;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing is true for bare for body');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 4: Bare while body
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 4. Bare while body ===');
{
  const code = `let obj = { x: 0 };\nwhile (cond) obj.x = 1;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing is true for bare while body');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 5: Top-level assignment — needsBracing should be false
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 5. Top-level assignment ===');
{
  const code = `let obj = { x: 0 };\nobj.x = 1;\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === false, 'needsBracing is false for top-level assignment');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 6: Full transform — bare if with markDirty inside braces
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 6. Full transform — bare if ===');
{
  const code = `let obj = { x: 0 };\nif (cond) obj.x = 1;\n`;
  let virtualCode = '';
  const result = applyTransform(code, opts, (v) => { virtualCode = v; });
  const out = result.code;
  
  // The markDirty should be INSIDE braces after the if condition
  assert(out.includes('{ obj.x = 1;') || out.includes('{ obj.x=1;'), 'Opening brace before obj.x = 1');
  assert(out.includes("__mv3_markDirty('obj'); }"), 'markDirty inside closing brace');
  
  console.log('  Transformed output:');
  console.log('  ' + out.split('\n').join('\n  '));
}

// ═══════════════════════════════════════════════════════════════
// Test 7: Full transform — bare else body
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 7. Full transform — bare else ===');
{
  const code = `let obj = { x: 0 };\nif (cond) foo(); else obj.x = 1;\n`;
  let virtualCode = '';
  const result = applyTransform(code, opts, (v) => { virtualCode = v; });
  const out = result.code;
  
  // The else branch's obj.x = 1 should be braced
  assert(out.includes('else {'), 'else has opening brace');
  assert(out.includes("__mv3_markDirty('obj'); }"), 'markDirty inside else closing brace');
  
  console.log('  Transformed output:');
  console.log('  ' + out.split('\n').join('\n  '));
}

// ═══════════════════════════════════════════════════════════════
// Test 8: Method call on persistent var in bare if body
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 8. Method call in bare if body ===');
{
  const code = `let arr = [1, 2];\nif (cond) arr.push(3);\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment (method call)');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing is true for method call in bare if body');
    assert(result.assignments[0].isFullReassignment === false, 'isFullReassignment is false for method call');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 9: Bare do-while body
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 9. Bare do-while body ===');
{
  const code = `let obj = { x: 0 };\ndo obj.x = 1; while (cond);\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing is true for bare do-while body');
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 10: Assignment inside function (no bracing needed)
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 10. Assignment inside function ===');
{
  const code = `let obj = { x: 0 };\nfunction fn() { if (cond) obj.x = 1; }\n`;
  const result = analyze(code, opts);
  assert(result.assignments.length === 1, 'Found 1 assignment');
  if (result.assignments.length > 0) {
    assert(result.assignments[0].needsBracing === true, 'needsBracing is true for bare if body inside function too');
  }
}

console.log(`\n═══ Bracing Test Results: ${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
