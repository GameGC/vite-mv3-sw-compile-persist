/**
 * Comprehensive Test Suite for Control Flow & Syntax Edge Cases:
 * 1. Automatic bracing { ... } around bare statements (if/else, for, while, do-while, for..of, for..in)
 * 2. UpdateExpression (++ / --) in expressions and loop headers
 * 3. Destructuring assignments (array, object, nested, rest)
 * 4. Scope shadowing: function params and inner block variables do NOT emit __mv3_markDirty
 * 5. Runtime execution in MV3 simulator
 */

import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

console.log('\n=== 1. AST Analysis: Bare Control Flow Bracing ===');
{
  const source = `
let queue = [];
let counter = 0;
let obj = { x: 0 };

// Bare if
if (true) counter++;

// Bare if with else
if (false) counter = 1; else queue.push('item');

// Bare for loop
for (let i = 0; i < 3; i++) counter += i;

// Bare while loop
while (counter < 10) counter++;

// Bare do-while loop
do obj.x++; while (obj.x < 5);

// Bare for..of loop
for (const x of ['a', 'b']) queue.push(x);

// Bare for..in loop
for (const k in { a: 1 }) queue.push(k);
`;

  const { code: out } = transform(source);

  // Bare if
  assert(
    out.includes('if (true) { counter++; __mv3_markDirty(\'counter\'); }'),
    'Bare if body wrapped with braces and markDirty',
  );

  // Bare else
  assert(
    out.includes('else { queue.push(\'item\'); __mv3_markDirty(\'queue\'); }'),
    'Bare else body wrapped with braces and markDirty',
  );

  // Bare for
  assert(
    out.includes('for (let i = 0; i < 3; i++) { counter += i; __mv3_markDirty(\'counter\'); }'),
    'Bare for loop body wrapped with braces and markDirty',
  );

  // Bare while
  assert(
    out.includes('while (counter < 10) { counter++; __mv3_markDirty(\'counter\'); }'),
    'Bare while loop body wrapped with braces and markDirty',
  );

  // Bare do-while
  assert(
    out.includes('do { obj.x++; __mv3_markDirty(\'obj\'); } while (obj.x < 5);'),
    'Bare do-while body wrapped with braces and markDirty',
  );

  // Bare for..of
  assert(
    out.includes('for (const x of [\'a\', \'b\']) { queue.push(x); __mv3_markDirty(\'queue\'); }'),
    'Bare for..of body wrapped with braces and markDirty',
  );

  // Bare for..in
  assert(
    out.includes('for (const k in { a: 1 }) { queue.push(k); __mv3_markDirty(\'queue\'); }'),
    'Bare for..in body wrapped with braces and markDirty',
  );
}

console.log('\n=== 2. AST Analysis: UpdateExpression (++ / --) Tracking ===');
{
  const source = `
let count = 0;
let total = 0;
let next = 0;

// Postfix & prefix in statements
count++;
++count;
count--;
--count;

// Inside expressions
next = count++;
if (++count > 5) {
  total = --count;
}

// In loop headers
for (let i = 0; i < 5; count++) {
  total++;
}
`;

  const { code: out } = transform(source);

  assert(
    out.includes('count++; __mv3_markDirty(\'count\');'),
    'Postfix count++ marked dirty',
  );
  assert(
    out.includes('++count; __mv3_markDirty(\'count\');'),
    'Prefix ++count marked dirty',
  );
  assert(
    out.includes('count--; __mv3_markDirty(\'count\');'),
    'Postfix count-- marked dirty',
  );
  assert(
    out.includes('--count; __mv3_markDirty(\'count\');'),
    'Prefix --count marked dirty',
  );
  assert(
    out.includes("next = count++; __mv3_markDirty('next'); __mv3_markDirty('count');"),
    'UpdateExpression inside variable assignment marked dirty for both variables',
  );
}

console.log('\n=== 3. AST Analysis: Destructuring Assignments ===');
{
  const source = `
let a = 1;
let b = 2;
let x = 10;
let y = 20;
let nested = 30;

// Array destructuring
[a, b] = [100, 200];

// Object destructuring
({ x, y } = { x: 1000, y: 2000 });

// Nested destructuring
({ deep: { val: nested } } = { deep: { val: 500 } });
`;

  const { code: out } = transform(source);

  assert(
    out.includes('[a, b] = [100, 200];') &&
      out.includes("__mv3_markDirty('a')") &&
      out.includes("__mv3_markDirty('b')"),
    'Array destructuring marked dirty for both a and b',
  );
  assert(
    out.includes('({ x, y } = { x: 1000, y: 2000 });') &&
      out.includes("__mv3_markDirty('x')") &&
      out.includes("__mv3_markDirty('y')"),
    'Object destructuring marked dirty for both x and y',
  );
  assert(
    out.includes('({ deep: { val: nested } } = { deep: { val: 500 } });') &&
      out.includes("__mv3_markDirty('nested')"),
    'Nested destructuring marked dirty for nested target',
  );
}

console.log('\n=== 4. AST Analysis: Scope Shadowing Protection ===');
{
  const source = `
let counter = 0;
let target = 'global';

// Local function parameter shadows global
function shadowParam(counter) {
  counter = 999;
  counter++;
}

// Inner block scope shadows global
{
  let counter = 50;
  counter = 60;
  counter++;
}

// Arrow function parameter shadows global
const fn = (counter) => {
  counter += 10;
};

// Catch parameter shadows global
try {
  throw new Error();
} catch (counter) {
  counter = 0;
}
`;

  const { code: out } = transform(source);

  // Split code to verify function body does not contain __mv3_markDirty('counter')
  const fnBodyMatch = out.match(/function shadowParam\(counter\) \{([\s\S]*?)\}/);
  assert(
    fnBodyMatch !== null && !fnBodyMatch[1].includes("__mv3_markDirty('counter')"),
    'Shadowed function parameter does not emit __mv3_markDirty',
  );

  const blockMatch = out.match(/\{\s*let counter = 50;([\s\S]*?)\}/);
  assert(
    blockMatch !== null && !blockMatch[1].includes("__mv3_markDirty('counter')"),
    'Shadowed block-scoped let does not emit __mv3_markDirty',
  );

  const arrowMatch = out.match(/\(counter\) => \{([\s\S]*?)\}/);
  assert(
    arrowMatch !== null && !arrowMatch[1].includes("__mv3_markDirty('counter')"),
    'Shadowed arrow function parameter does not emit __mv3_markDirty',
  );

  const catchMatch = out.match(/catch \(counter\) \{([\s\S]*?)\}/);
  assert(
    catchMatch !== null && !catchMatch[1].includes("__mv3_markDirty('counter')"),
    'Shadowed catch clause parameter does not emit __mv3_markDirty',
  );
}

console.log('\n=== 5. Runtime Simulator: Bare Control Flow Execution ===');
async function testBareControlFlowRuntime() {
  const source = `
let loopCount = 0;
let collected = [];

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'RUN_BARE') {
    const condition = true;
    if (condition) loopCount++;
    if (!condition) loopCount = 999; else loopCount += 10;

    for (let i = 0; i < 5; i++) loopCount += i;

    while (loopCount < 25) loopCount++;

    for (const item of ['x', 'y', 'z']) collected.push(item);

    return { loopCount, collected };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  const res = await sim.dispatchMessage({ type: 'RUN_BARE' });
  assert(res.loopCount === 25, 'loopCount executed across bare loops to 25');
  assert(res.collected.length === 3, 'collected array has 3 items');

  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('loopCount') === 25, 'loopCount preserved across restart');
  assert(sim.evaluate('collected.length') === 3, 'collected array preserved across restart');
}

console.log('\n=== 6. Runtime Simulator: Destructuring & UpdateExpression ===');
async function testDestructuringRuntime() {
  const source = `
let posA = 0;
let posB = 0;
let configVal = 10;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'DESTRUCTURE') {
    [posA, posB] = [msg.a, msg.b];
    posA++;
    --posB;
    ({ val: configVal } = { val: msg.config });
    return { posA, posB, configVal };
  }
});
`;

  const bundle = compileTestBundle(source);
  const sim = createSimulator();

  await sim.boot(bundle);

  const res = await sim.dispatchMessage({ type: 'DESTRUCTURE', a: 10, b: 20, config: 99 });
  assert(res.posA === 11, 'posA updated via destructure + increment');
  assert(res.posB === 19, 'posB updated via destructure + decrement');
  assert(res.configVal === 99, 'configVal updated via object destructure');

  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('posA') === 11, 'posA preserved after restart');
  assert(sim.evaluate('posB') === 19, 'posB preserved after restart');
  assert(sim.evaluate('configVal') === 99, 'configVal preserved after restart');
}

async function runAll() {
  await testBareControlFlowRuntime();
  await testDestructuringRuntime();

  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runAll().catch((err) => {
  console.error('Unhandled failure in control-flow.test.ts:', err);
  process.exit(1);
});
