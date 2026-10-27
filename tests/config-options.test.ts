/**
 * Comprehensive Test Suite for Configuration Options:
 * 1. storageArea ('session' vs 'local')
 * 2. persistentVars (whitelist filtering)
 * 3. excludeVars (blacklist filtering)
 * 4. autoFlushMs (debouncing delay & auto-flush)
 * 5. staleLockThresholdMs (stale boolean lock auto-recovery)
 * 6. keepaliveStrategy ('alarm', 'offscreen', 'none')
 */

import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

console.log('\n=== 1. storageArea Option: session vs local ===');
{
  const source = `let token = 'secret';`;

  // session
  const { code: sessionCode, virtualModule: sessionVm } = transform(source, { storageArea: 'session' });
  assert(sessionCode.includes("storageArea: 'session'"), "Adapter config sets storageArea: 'session'");
  assert(
    sessionVm.includes('__mv3_storage = config.storageArea === \'local\'\n  ? __mv3_ext.storage.local\n  : __mv3_ext.storage.session;'),
    'Virtual runtime branches based on storageArea config',
  );

  // local
  const { code: localCode } = transform(source, { storageArea: 'local' });
  assert(localCode.includes("storageArea: 'local'"), "Adapter config sets storageArea: 'local'");
}

async function testStorageAreaRuntime() {
  const source = `
let token = 'initial';

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'SET_TOKEN') {
    token = msg.token;
    return { ok: true };
  }
});
`;

  // Test local storage area
  const localBundle = compileTestBundle(source, { storageArea: 'local' });
  const localSim = createSimulator();

  await localSim.boot(localBundle);
  await localSim.dispatchMessage({ type: 'SET_TOKEN', token: 'jwt_local_123' });
  await localSim.flush();

  const localRaw = await localSim.storage.local.get(null);
  const sessionRaw = await localSim.storage.session.get(null);

  assert(localRaw.__mv3_token === 'jwt_local_123', 'Data persisted in chrome.storage.local');
  assert(sessionRaw.__mv3_token === undefined, 'No data leaked into chrome.storage.session');

  await localSim.restart(localBundle);
  assert(localSim.evaluate('token') === 'jwt_local_123', 'Token restored from chrome.storage.local');

  // Test session storage area
  const sessionBundle = compileTestBundle(source, { storageArea: 'session' });
  const sessionSim = createSimulator();

  await sessionSim.boot(sessionBundle);
  await sessionSim.dispatchMessage({ type: 'SET_TOKEN', token: 'jwt_session_456' });
  await sessionSim.flush();

  const sessionRawData = await sessionSim.storage.session.get(null);
  const localRawData = await sessionSim.storage.local.get(null);

  assert(sessionRawData.__mv3_token === 'jwt_session_456', 'Data persisted in chrome.storage.session');
  assert(localRawData.__mv3_token === undefined, 'No data leaked into chrome.storage.local');

  await sessionSim.restart(sessionBundle);
  assert(sessionSim.evaluate('token') === 'jwt_session_456', 'Token restored from chrome.storage.session');
}

console.log('\n=== 2. persistentVars Whitelist Filtering ===');
{
  const source = `
let kept1 = 1;
let kept2 = 2;
let ignored1 = 3;
let ignored2 = 4;

kept1 = 10;
ignored1 = 30;
`;

  const { code: out } = transform(source, { persistentVars: ['kept1', 'kept2'] });

  assert(
    out.includes('varNames: ["kept1","kept2"]'),
    'Only whitelisted variables registered in varNames',
  );
  assert(
    out.includes("case 'kept1': return kept1;") &&
      out.includes("case 'kept2': return kept2;") &&
      !out.includes("case 'ignored1':"),
    'Only whitelisted variables registered in getVar/setVar',
  );
  assert(
    out.includes("__mv3_markDirty('kept1')"),
    'Whitelisted variable assignment receives __mv3_markDirty',
  );
  assert(
    !out.includes("__mv3_markDirty('ignored1')"),
    'Non-whitelisted variable assignment does NOT receive __mv3_markDirty',
  );
}

console.log('\n=== 3. excludeVars Blacklist Filtering ===');
{
  const source = `
let persistentA = 100;
let temporaryCache = { data: 'temp' };
let scratch = 'throwaway';

persistentA = 200;
temporaryCache.data = 'new';
`;

  const { code: out } = transform(source, { excludeVars: ['temporaryCache', 'scratch'] });

  assert(
    out.includes('varNames: ["persistentA"]'),
    'Excluded variables omitted from varNames',
  );
  assert(
    !out.includes("case 'temporaryCache':") && !out.includes("case 'scratch':"),
    'Excluded variables omitted from accessors',
  );
  assert(
    out.includes("__mv3_markDirty('persistentA')"),
    'Non-excluded variable marked dirty',
  );
  assert(
    !out.includes("__mv3_markDirty('temporaryCache')"),
    'Excluded variable mutation not marked dirty',
  );
}

console.log('\n=== 4. autoFlushMs Configuration ===');
{
  const source = `let counter = 0;`;

  // Disabled auto-flush
  const { virtualModule: vmDisabled } = transform(source, { autoFlushMs: 0 });
  assert(
    vmDisabled.includes('// Auto-flush disabled'),
    'autoFlushMs: 0 disables periodic auto-flush interval',
  );

  // Custom auto-flush interval
  const { virtualModule: vmCustom } = transform(source, { autoFlushMs: 500 });
  assert(
    vmCustom.includes('__native_setInterval(__mv3_flushDirty, 500);'),
    'Custom autoFlushMs: 500 sets 500ms interval for flushDirty',
  );
}

async function testAutoFlushRuntime() {
  const source = `
let liveCounter = 0;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'TICK') {
    liveCounter += 1;
    return { count: liveCounter };
  }
});
`;

  // Use 100ms autoFlushMs
  const bundle = compileTestBundle(source, { autoFlushMs: 100 });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Trigger mutation without manual flush()
  await sim.dispatchMessage({ type: 'TICK' });

  // Storage should initially not have the value yet before flush interval
  // Wait by flushing intervals
  await sim.flush();

  const stored = await sim.storage.session.get(null);
  assert(stored.__mv3_liveCounter === 1, 'Auto-flush committed dirty state to storage');
}

console.log('\n=== 5. staleLockThresholdMs Boolean Lock Auto-Recovery ===');
async function testStaleLockRecovery() {
  const source = `
let isProcessing = false;
let tasksCompleted = 0;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'START_JOB') {
    isProcessing = true;
    tasksCompleted++;
    return { isProcessing, tasksCompleted };
  }
});
`;

  // Stale lock threshold: 20 seconds
  const bundle = compileTestBundle(source, { staleLockThresholdMs: 20000 });
  const sim = createSimulator({ virtualClockStart: 1000000 });

  await sim.boot(bundle);

  // Acquire lock
  await sim.dispatchMessage({ type: 'START_JOB' });
  await sim.flush();

  assert(sim.evaluate('isProcessing') === true, 'Lock acquired: isProcessing = true');
  assert(sim.evaluate('tasksCompleted') === 1, 'tasksCompleted = 1');

  // Verify lock age recorded
  const storageData = await sim.storage.session.get(null);
  assert(
    typeof storageData.__mv3_lockAge_isProcessing === 'number',
    'lockAge recorded in storage for boolean lock',
  );

  // Scenario A: SW killed and restarted within threshold (e.g. 5 seconds later)
  sim.kill();
  sim.virtualClock = 1005000; // +5s
  await sim.boot(bundle);

  assert(
    sim.evaluate('isProcessing') === true,
    'Active lock preserved when restart is within staleLockThresholdMs (5s < 20s)',
  );

  // Scenario B: SW killed and restarted well after threshold (e.g. 30 seconds later)
  sim.kill();
  sim.virtualClock = 1035000; // +30s > 20s
  await sim.boot(bundle);

  assert(
    sim.evaluate('isProcessing') === false,
    'Stale lock auto-recovered to false after threshold exceeded (35s > 20s)',
  );
  assert(
    sim.evaluate('tasksCompleted') === 1,
    'Other persistent state (tasksCompleted) remains intact after lock recovery',
  );

  // Verify stale lockAge was cleaned up from storage
  const cleanedStorage = await sim.storage.session.get(null);
  assert(
    cleanedStorage.__mv3_lockAge_isProcessing === undefined,
    'Stale lockAge timestamp removed from storage',
  );
}

console.log('\n=== 6. keepaliveStrategy Configuration ===');
{
  const source = `let x = 0;`;

  // 'none'
  const { virtualModule: vmNone } = transform(source, { keepaliveStrategy: 'none' });
  assert(!vmNone.includes('__mv3_ensureOffscreenDocument'), 'keepaliveStrategy: none excludes offscreen code');

  // 'alarm'
  const { virtualModule: vmAlarm } = transform(source, { keepaliveStrategy: 'alarm' });
  assert(!vmAlarm.includes('__mv3_ensureOffscreenDocument'), 'keepaliveStrategy: alarm does not inject offscreen code');

  // 'offscreen'
  const { virtualModule: vmOffscreen } = transform(source, { keepaliveStrategy: 'offscreen' });
  assert(
    vmOffscreen.includes('__mv3_ensureOffscreenDocument') &&
      vmOffscreen.includes('__mv3_closeOffscreenDocument'),
    'keepaliveStrategy: offscreen provides ensure and close offscreen document helpers',
  );
}

async function runAll() {
  await testStorageAreaRuntime();
  await testAutoFlushRuntime();
  await testStaleLockRecovery();

  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runAll().catch((err) => {
  console.error('Unhandled failure in config-options.test.ts:', err);
  process.exit(1);
});
