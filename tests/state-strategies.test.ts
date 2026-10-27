/**
 * Comprehensive Test Suite for State Strategies & Data Types:
 * 1. static strategy vs proxy strategy
 * 2. Deep mutation tracking: Map, Set, Date, Array, nested Object
 * 3. Serialization (__mv3_toPlain, __mv3_serialize, __mv3_deserialize)
 * 4. Cold restart restoration & memory isolation
 */

import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

console.log('\n=== 1. AST Analysis: Static vs Proxy Strategy ===');
{
  const source = `
let counter = 0;
let user = { name: 'Alice', scores: [10, 20] };
let myMap = new Map();
let mySet = new Set();
let myDate = new Date();
`;

  // Static strategy
  const { code: staticCode, virtualModule: staticVm } = transform(source, { strategy: 'static' });
  assert(
    staticVm.includes('function __mv3_reactive<T extends object>(target: T, _varName: string): T {\n  return target;\n}'),
    'Static strategy defines no-op __mv3_reactive returning raw target',
  );
  assert(
    !staticCode.includes("user = __mv3_reactive(user, 'user');"),
    'Static strategy does not wrap initial declarations in reactive proxy',
  );

  // Proxy strategy
  const { code: proxyCode, virtualModule: proxyVm } = transform(source, { strategy: 'proxy' });
  assert(
    proxyVm.includes('const __mv3_PROXY_CACHE = new WeakMap<object, object>();') &&
      proxyVm.includes('new Proxy(target, handler)'),
    'Proxy strategy includes deep ProxyCache and Proxy constructor in virtual module',
  );
  assert(
    proxyCode.includes("user = __mv3_reactive(user, 'user');"),
    'Proxy strategy wraps user in reactive proxy at boot',
  );
  assert(
    proxyCode.includes("myMap = __mv3_reactive(myMap, 'myMap');"),
    'Proxy strategy wraps myMap in reactive proxy at boot',
  );
  assert(
    proxyCode.includes("mySet = __mv3_reactive(mySet, 'mySet');"),
    'Proxy strategy wraps mySet in reactive proxy at boot',
  );
  assert(
    proxyCode.includes("myDate = __mv3_reactive(myDate, 'myDate');"),
    'Proxy strategy wraps myDate in reactive proxy at boot',
  );
}

console.log('\n=== 2. Static Strategy State Persistence ===');
async function testStaticStrategy() {
  const source = `
let staticCount = 0;
let staticName = 'initial';
let staticFlags = [true, false];

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'UPDATE') {
    staticCount = msg.count;
    staticName = msg.name;
    staticFlags = [false, true, true];
    return { ok: true };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'static' });
  const sim = createSimulator();

  await sim.boot(bundle);

  const res = await sim.dispatchMessage({ type: 'UPDATE', count: 42, name: 'static_updated' });
  assert(res.ok === true, 'Static message handler executed');
  assert(sim.evaluate('staticCount') === 42, 'staticCount updated');
  assert(sim.evaluate('staticName') === 'static_updated', 'staticName updated');
  assert(sim.evaluate('staticFlags.length') === 3, 'staticFlags updated');

  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('staticCount') === 42, 'staticCount preserved in static strategy');
  assert(sim.evaluate('staticName') === 'static_updated', 'staticName preserved in static strategy');
  assert(sim.evaluate('staticFlags.length') === 3, 'staticFlags length preserved in static strategy');
  assert(sim.evaluate('staticFlags[0]') === false, 'staticFlags items preserved');
}

console.log('\n=== 3. Proxy Strategy: Array Deep Mutations & Methods ===');
async function testArrayMutations() {
  const source = `
let tasks = ['task-a', 'task-b'];
let matrix = [[1, 2], [3, 4]];

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'ARRAY_OPS') {
    tasks.push('task-c');        // push
    const shifted = tasks.shift(); // shift
    tasks.unshift('task-z');     // unshift
    tasks.splice(1, 1, 'task-replaced'); // splice
    tasks[0] = 'task-indexed';   // index assignment
    matrix[1][0] = 99;           // nested array index assignment
    return { shifted, len: tasks.length };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  const res = await sim.dispatchMessage({ type: 'ARRAY_OPS' });
  assert(res.shifted === 'task-a', 'shift removed first element');
  assert(res.len === 3, 'tasks length matches expected ops');

  // Verify in isolate
  const inMemoryTasks = sim.evaluate('tasks');
  assert(inMemoryTasks[0] === 'task-indexed', 'tasks[0] updated by index assignment');
  assert(inMemoryTasks[1] === 'task-replaced', 'tasks[1] updated by splice');
  assert(inMemoryTasks[2] === 'task-c', 'tasks[2] is task-c');
  assert(sim.evaluate('matrix[1][0]') === 99, 'Nested array element updated to 99');

  // Flush and Cold Restart
  await sim.flush();
  await sim.restart(bundle);

  // Assert restored array has Array prototype methods without TypeError
  assert(sim.evaluate('Array.isArray(tasks)'), 'Restored tasks is an Array');
  assert(sim.evaluate('tasks.length') === 3, 'Restored tasks has length 3');
  assert(sim.evaluate('tasks[0]') === 'task-indexed', 'Restored tasks[0] matches');
  assert(sim.evaluate('tasks[1]') === 'task-replaced', 'Restored tasks[1] matches');
  assert(sim.evaluate('tasks[2]') === 'task-c', 'Restored tasks[2] matches');
  assert(sim.evaluate('matrix[1][0]') === 99, 'Restored nested array matches');

  // Verify array operations work cleanly on the restored object
  sim.evaluate('tasks.push("task-after-restart")');
  assert(sim.evaluate('tasks.length') === 4, 'push works on restored array');
  const popped = sim.evaluate('tasks.pop()');
  assert(popped === 'task-after-restart', 'pop works on restored array');
  const found = sim.evaluate('tasks.find(t => t === "task-indexed")');
  assert(found === 'task-indexed', 'find works on restored array');
}

console.log('\n=== 4. Proxy Strategy: Map Deep Mutations & Lifecycle ===');
async function testMapMutations() {
  const source = `
let userSessions = new Map();

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'SET_SESSIONS') {
    userSessions.set('session-1', { uid: 'u100', role: 'admin' });
    userSessions.set('session-2', { uid: 'u200', role: 'user' });
    userSessions.set('session-3', { uid: 'u300', role: 'guest' });
    return { size: userSessions.size };
  }
  if (msg.type === 'DELETE_SESSION') {
    const deleted = userSessions.delete(msg.key);
    return { deleted, size: userSessions.size };
  }
  if (msg.type === 'CLEAR_SESSIONS') {
    userSessions.clear();
    return { size: userSessions.size };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Set entries
  const res1 = await sim.dispatchMessage({ type: 'SET_SESSIONS' });
  assert(res1.size === 3, 'Map populated with 3 items');

  // Delete entry
  const res2 = await sim.dispatchMessage({ type: 'DELETE_SESSION', key: 'session-2' });
  assert(res2.deleted === true && res2.size === 2, 'Map key deleted');

  // Flush and Cold Restart
  await sim.flush();
  await sim.restart(bundle);

  // Verify restored Map
  assert(sim.evaluate('userSessions instanceof Map'), 'userSessions restored as instanceof Map');
  assert(sim.evaluate('userSessions.size') === 2, 'userSessions.size is 2');
  assert(sim.evaluate('userSessions.has("session-1")'), 'userSessions contains session-1');
  assert(!sim.evaluate('userSessions.has("session-2")'), 'userSessions does not contain session-2');
  assert(sim.evaluate('userSessions.get("session-1").role') === 'admin', 'Nested value in Map restored');

  // Mutate restored Map
  sim.evaluate('userSessions.set("session-new", { uid: "u999", role: "editor" })');
  assert(sim.evaluate('userSessions.size') === 3, 'Can set entries on restored Map');
  await sim.flush();
  await sim.restart(bundle);
  assert(sim.evaluate('userSessions.get("session-new").uid') === 'u999', 'New entries persist across second restart');
}

console.log('\n=== 5. Proxy Strategy: Set Deep Mutations & Lifecycle ===');
async function testSetMutations() {
  const source = `
let uniqueIds = new Set();

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'ADD_IDS') {
    uniqueIds.add('id-alpha');
    uniqueIds.add('id-beta');
    uniqueIds.add('id-gamma');
    uniqueIds.add('id-alpha'); // duplicate
    return { size: uniqueIds.size };
  }
  if (msg.type === 'REMOVE_ID') {
    const deleted = uniqueIds.delete(msg.id);
    return { deleted, size: uniqueIds.size };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  const res1 = await sim.dispatchMessage({ type: 'ADD_IDS' });
  assert(res1.size === 3, 'Set deduplicated entries with size 3');

  const res2 = await sim.dispatchMessage({ type: 'REMOVE_ID', id: 'id-beta' });
  assert(res2.deleted === true && res2.size === 2, 'Set deleted entry');

  // Flush and Cold Restart
  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('uniqueIds instanceof Set'), 'uniqueIds restored as instanceof Set');
  assert(sim.evaluate('uniqueIds.size') === 2, 'uniqueIds restored with size 2');
  assert(sim.evaluate('uniqueIds.has("id-alpha")'), 'Set has id-alpha');
  assert(!sim.evaluate('uniqueIds.has("id-beta")'), 'Set does not have id-beta');
  assert(sim.evaluate('uniqueIds.has("id-gamma")'), 'Set has id-gamma');

  // Verify Set methods after restart
  sim.evaluate('uniqueIds.add("id-delta")');
  assert(sim.evaluate('uniqueIds.has("id-delta")'), 'add works on restored Set');
}

console.log('\n=== 6. Proxy Strategy: Date Deep Mutations & Lifecycle ===');
async function testDateMutations() {
  const source = `
let lastSyncTime = new Date('2026-01-01T00:00:00.000Z');

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'SET_TIME') {
    lastSyncTime.setTime(msg.timestamp);
    return { time: lastSyncTime.getTime() };
  }
  if (msg.type === 'SET_YEAR') {
    lastSyncTime.setUTCFullYear(msg.year);
    return { iso: lastSyncTime.toISOString() };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  const targetTs = Date.parse('2026-10-27T12:00:00.000Z');
  const res1 = await sim.dispatchMessage({ type: 'SET_TIME', timestamp: targetTs });
  assert(res1.time === targetTs, 'setTime mutated Date timestamp');

  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('lastSyncTime instanceof Date'), 'lastSyncTime restored as instanceof Date');
  assert(sim.evaluate('lastSyncTime.getTime()') === targetTs, 'Restored Date timestamp matches');
  assert(
    sim.evaluate('lastSyncTime.toISOString()') === '2026-10-27T12:00:00.000Z',
    'Restored Date ISO string matches',
  );

  // Mutate restored Date with setUTCFullYear
  await sim.dispatchMessage({ type: 'SET_YEAR', year: 2028 });
  assert(sim.evaluate('lastSyncTime.getUTCFullYear()') === 2028, 'Date method works on restored instance');

  await sim.flush();
  await sim.restart(bundle);
  assert(sim.evaluate('lastSyncTime.getUTCFullYear()') === 2028, 'Updated Date year preserved across second restart');
}

console.log('\n=== 7. Proxy Strategy: Nested Object Mutations & Proxy Stripping ===');
async function testNestedObjectMutations() {
  const source = `
let appConfig = {
  version: '1.0.0',
  features: {
    darkMode: true,
    notifications: {
      sound: true,
      badge: false,
    },
  },
  nestedList: [
    { id: 1, label: 'first' },
    { id: 2, label: 'second' },
  ],
};

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'MUTATE_NESTED') {
    appConfig.features.notifications.badge = true;
    appConfig.features.notifications.sound = false;
    delete appConfig.version;
    appConfig.nestedList[1].label = 'second-modified';
    appConfig.nestedList.push({ id: 3, label: 'third' });
    return { ok: true };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  await sim.dispatchMessage({ type: 'MUTATE_NESTED' });

  // Flush and Cold Restart
  await sim.flush();
  await sim.restart(bundle);

  // Assert deeply modified object
  assert(sim.evaluate('appConfig.features.notifications.badge === true'), 'Nested property badge is true');
  assert(sim.evaluate('appConfig.features.notifications.sound === false'), 'Nested property sound is false');
  assert(sim.evaluate('appConfig.version === undefined'), 'Deleted property version is undefined');
  assert(
    sim.evaluate('appConfig.nestedList[1].label === "second-modified"'),
    'Nested array object label modified',
  );
  assert(sim.evaluate('appConfig.nestedList.length === 3'), 'Pushed item to nested array exists');
  assert(sim.evaluate('appConfig.nestedList[2].label === "third"'), 'Pushed item content matches');
}

console.log('\n=== 8. Memory Isolation & Zero Reference Sharing Across Restarts ===');
async function testMemoryIsolation() {
  const source = `
let sharedState = { profile: { name: 'Worker1' }, count: 10 };

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'GET') {
    return sharedState;
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Grab handle from isolate 1
  const isolate1Obj = sim.evaluate('sharedState');
  assert(isolate1Obj.profile.name === 'Worker1', 'Isolate 1 has Worker1');

  // Kill and restart into isolate 2
  await sim.flush();
  await sim.restart(bundle);

  // Mutate old object from worker 1
  isolate1Obj.profile.name = 'HackedByIsolate1';
  isolate1Obj.count = 9999;

  // Verify worker 2 is unaffected
  assert(sim.evaluate('sharedState.profile.name') === 'Worker1', 'Worker 2 isolated from Worker 1 mutation');
  assert(sim.evaluate('sharedState.count') === 10, 'Worker 2 count isolated from Worker 1 count');

  // Verify object identity distinction
  const isolate2Obj = sim.evaluate('sharedState');
  assert(isolate1Obj !== isolate2Obj, 'Worker 1 and Worker 2 have completely distinct object references');
}

async function runAll() {
  await testStaticStrategy();
  await testArrayMutations();
  await testMapMutations();
  await testSetMutations();
  await testDateMutations();
  await testNestedObjectMutations();
  await testMemoryIsolation();

  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runAll().catch((err) => {
  console.error('Unhandled failure in state-strategies.test.ts:', err);
  process.exit(1);
});
