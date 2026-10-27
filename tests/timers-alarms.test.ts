/**
 * Comprehensive Test Suite for Timers & Alarms:
 * 1. Short timers (< alarmThresholdMs) vs Long timers (>= alarmThresholdMs)
 * 2. Dynamic threshold testing & delay constant evaluation
 * 3. clearTimeout and clearInterval (universal handling)
 * 4. promiseResolverStrategy ('native' vs 'alarm')
 * 5. namedAlarmHandlers registration & dispatch
 * 6. User alarms.clearAll() protection of persistence alarms
 * 7. Service worker cold restart recovery of alarm timers
 */

import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

console.log('\n=== 1. AST Analysis: Short vs Long Timers & Constant Delays ===');
{
  const source = `
const ONE_MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
let counter = 0;

function handleShort() { counter++; }
function handleLong() { counter += 10; }
function handleConst() { counter += 20; }

setTimeout(handleShort, 5000);
setTimeout(handleLong, 120000);
setTimeout(handleConst, FIVE_MINUTES);
setInterval(handleLong, 300000);
`;

  const { code: out } = transform(source, { alarmThresholdMs: 60000 });

  assert(
    out.includes('__mv3_setTimeout(handleShort, 5000)'),
    'Short setTimeout rewritten with direct function reference',
  );
  assert(
    out.includes('__mv3_setTimeout(handleLong, 120000)'),
    'Long setTimeout rewritten to __mv3_setTimeout',
  );
  assert(
    out.includes('__mv3_setTimeout(handleConst, FIVE_MINUTES)'),
    'Constant identifier delay rewritten properly',
  );
  assert(
    out.includes('__mv3_setInterval(handleLong, 300000)'),
    'Long setInterval rewritten to __mv3_setInterval',
  );
  assert(
    out.includes("__mv3_registerFn('handleShort', handleShort);") &&
      out.includes("__mv3_registerFn('handleLong', handleLong);") &&
      out.includes("__mv3_registerFn('handleConst', handleConst);"),
    'All timer handler functions registered in function registry',
  );
}

console.log('\n=== 2. Dynamic alarmThresholdMs Threshold Testing ===');
{
  const source = `
function tick() {}
setTimeout(tick, 20000); // 20s
`;

  // Threshold 15s -> 20s is long
  const { code: code15 } = transform(source, { alarmThresholdMs: 15000 });
  assert(code15.includes('__mv3_setTimeout(tick, 20000)'), '20s timer transformed with 15s threshold');

  // Threshold 30s -> 20s is short
  const { code: code30 } = transform(source, { alarmThresholdMs: 30000 });
  assert(code30.includes('__mv3_setTimeout(tick, 20000)'), '20s timer transformed with 30s threshold');
}

console.log('\n=== 3. promiseResolverStrategy: native vs alarm ===');
{
  const source = `
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
`;

  // Strategy 'native'
  const { code: nativeCode } = transform(source, { promiseResolverStrategy: 'native' });
  assert(
    nativeCode.includes('__mv3_setTimeoutPromise(resolve, ms)'),
    'promiseResolverStrategy: native rewrites setTimeout inside Promise to __mv3_setTimeoutPromise',
  );

  // Strategy 'alarm'
  const { code: alarmCode } = transform(source, { promiseResolverStrategy: 'alarm' });
  assert(
    alarmCode.includes('__mv3_setTimeout(resolve, ms)'),
    'promiseResolverStrategy: alarm routes Promise timer to standard __mv3_setTimeout',
  );
}

console.log('\n=== 4. namedAlarmHandlers Registration & Runtime Dispatch ===');
async function testNamedAlarmHandlers() {
  const source = `
let cleanupCount = 0;
let healthCheckCount = 0;

function cleanupTempFiles() {
  cleanupCount++;
}

function runHealthCheck() {
  healthCheckCount += 5;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'nightly-cleanup') {
    cleanupTempFiles();
  } else if (alarm.name === 'system-health') {
    runHealthCheck();
  }
});
`;

  const { code: transformedCode } = transform(source, {
    namedAlarmHandlers: {
      'nightly-cleanup': 'cleanupTempFiles',
      'system-health': 'runHealthCheck',
    },
  });

  assert(
    transformedCode.includes("__mv3_registerFn('nightly-cleanup', cleanupTempFiles);"),
    'namedAlarmHandlers registered in adapter via __mv3_registerFn',
  );
  assert(
    transformedCode.includes("__mv3_registerFn('system-health', runHealthCheck);"),
    'second namedAlarmHandler registered in adapter',
  );

  const bundle = compileTestBundle(source, {
    namedAlarmHandlers: {
      'nightly-cleanup': 'cleanupTempFiles',
      'system-health': 'runHealthCheck',
    },
  });

  const sim = createSimulator();
  await sim.boot(bundle);

  // Directly dispatch named alarm through alarms mock
  await sim.dispatchAlarm('nightly-cleanup');
  assert(sim.evaluate('cleanupCount') === 1, 'nightly-cleanup alarm triggered cleanupTempFiles');

  await sim.dispatchAlarm('system-health');
  assert(sim.evaluate('healthCheckCount') === 5, 'system-health alarm triggered runHealthCheck');

  // Trigger again
  await sim.dispatchAlarm('nightly-cleanup');
  assert(sim.evaluate('cleanupCount') === 2, 'nightly-cleanup second invocation incremented count');

  // Also verify registry contains the functions directly
  const hasInRegistry = sim.evaluate('typeof __mv3_fn_registry["nightly-cleanup"] === "function"');
  assert(hasInRegistry, '__mv3_fn_registry contains nightly-cleanup');
}

console.log('\n=== 5. Runtime Simulator: Short Native Timers vs Long Alarm Timers ===');
async function testShortVsLongRuntime() {
  const source = `
let shortFired = false;
let longFired = false;
let intervalTicks = 0;

function onShort() { shortFired = true; }
function onLong() { longFired = true; }
function onInterval() { intervalTicks++; }

// Schedule short (1000ms < 60000ms)
setTimeout(onShort, 1000);

// Schedule long (120000ms >= 60000ms)
setTimeout(onLong, 120000);

// Schedule long periodic interval (300000ms >= 60000ms)
setInterval(onInterval, 300000);
`;

  const bundle = compileTestBundle(source, { alarmThresholdMs: 60000 });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Verify long timer created an alarm in simulator alarms engine
  const allAlarms = await sim.alarms.getAll();
  const timeoutAlarm = allAlarms.find((a) => a.name.startsWith('__mv3_alarm_timeout_'));
  const intervalAlarm = allAlarms.find((a) => a.name.startsWith('__mv3_alarm_interval_'));

  assert(Boolean(timeoutAlarm), 'Long setTimeout scheduled as chrome alarm');
  assert(Boolean(intervalAlarm), 'Long setInterval scheduled as chrome alarm');
  assert(intervalAlarm?.periodInMinutes === 5, 'Long setInterval has periodInMinutes: 5');

  // Advance time by 2000ms -> short timer fires, long does not
  await sim.advanceTime(2000);
  assert(sim.evaluate('shortFired') === true, 'Short native timer fired after 2s');
  assert(sim.evaluate('longFired') === false, 'Long timer has not fired yet after 2s');

  // Advance time past 120s -> long timer fires
  await sim.advanceTime(120000);
  assert(sim.evaluate('longFired') === true, 'Long alarm timer fired after virtual clock elapsed');

  // Advance time past 300s -> periodic interval fires
  await sim.advanceTime(300000);
  assert(sim.evaluate('intervalTicks') >= 1, 'Periodic interval alarm fired tick');
}

console.log('\n=== 6. Runtime Simulator: clearTimeout & clearInterval Cancellation ===');
async function testTimerCancellation() {
  const source = `
let cancelledTimeoutFired = false;
let cancelledAlarmFired = false;
let t1 = null;
let a1 = null;

function onTimeout() { cancelledTimeoutFired = true; }
function onAlarm() { cancelledAlarmFired = true; }

// Schedule short
t1 = setTimeout(onTimeout, 500);

// Schedule long alarm
a1 = setTimeout(onAlarm, 180000);

// Cancel both immediately
clearTimeout(t1);
clearTimeout(a1);

// Edge cases
clearTimeout(null);
clearTimeout(undefined);
clearTimeout(0);
clearInterval(null);
`;

  const bundle = compileTestBundle(source, { alarmThresholdMs: 60000 });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Check that the long alarm was cleared from alarms engine
  const allAlarms = await sim.alarms.getAll();
  assert(
    !allAlarms.some((a) => a.name.startsWith('__mv3_alarm_timeout_')),
    'clearTimeout removed long alarm from chrome.alarms engine',
  );

  // Advance time by 200s
  await sim.advanceTime(200000);
  assert(sim.evaluate('cancelledTimeoutFired') === false, 'Cancelled short timeout never fired');
  assert(sim.evaluate('cancelledAlarmFired') === false, 'Cancelled long alarm never fired');
}

console.log('\n=== 7. Runtime Simulator: alarms.clearAll Protection ===');
async function testClearAllProtection() {
  const source = `
let userAlarmCount = 0;
let systemAlarmCount = 0;

function systemHandler() {
  systemAlarmCount++;
}

// Long timer (creates internal __mv3_alarm_timeout_0)
setTimeout(systemHandler, 120000);

// Register user alarm via chrome.alarms.create
chrome.alarms.create('user-poll-alarm', { delayInMinutes: 2 });
chrome.alarms.create('user-cleanup-alarm', { delayInMinutes: 5 });

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'CLEAR_USER_ALARMS') {
    // User code calls clearAll()
    await chrome.alarms.clearAll();
    return { ok: true };
  }
});
`;

  const bundle = compileTestBundle(source, { alarmThresholdMs: 60000 });
  const sim = createSimulator();

  await sim.boot(bundle);

  let initialAlarms = await sim.alarms.getAll();
  assert(initialAlarms.length === 3, '3 alarms scheduled (1 internal + 2 user)');

  // Call clearAll via message
  const res = await sim.dispatchMessage({ type: 'CLEAR_USER_ALARMS' });
  assert(res.ok === true, 'CLEAR_USER_ALARMS executed');

  // Verify internal alarm survived, user alarms were wiped
  const remainingAlarms = await sim.alarms.getAll();
  assert(
    remainingAlarms.some((a) => a.name.startsWith('__mv3_alarm_timeout_')),
    'Internal persistence timer alarm preserved after clearAll()',
  );
  assert(
    !remainingAlarms.some((a) => a.name === 'user-poll-alarm'),
    'user-poll-alarm cleared by clearAll()',
  );
  assert(
    !remainingAlarms.some((a) => a.name === 'user-cleanup-alarm'),
    'user-cleanup-alarm cleared by clearAll()',
  );

  // Advance time and verify internal alarm still executes properly
  await sim.advanceTime(130000);
  assert(sim.evaluate('systemAlarmCount') === 1, 'Preserved internal alarm executed successfully');
}

console.log('\n=== 8. Cold Restart Long-Timer Recovery & Callback Execution ===');
async function testColdRestartAlarmRecovery() {
  const source = `
let taskResults = [];

function processBackgroundTask() {
  taskResults.push('task_completed_at_' + Date.now());
}

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'START_BACKGROUND_TIMER') {
    setTimeout(processBackgroundTask, 120000); // 2 minutes
    return { ok: true };
  }
});
`;

  const bundle = compileTestBundle(source, { alarmThresholdMs: 60000 });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Start background timer
  await sim.dispatchMessage({ type: 'START_BACKGROUND_TIMER' });

  const alarmsBefore = await sim.alarms.getAll();
  const scheduledAlarm = alarmsBefore.find((a) => a.name.startsWith('__mv3_alarm_timeout_'));
  assert(Boolean(scheduledAlarm), 'Long alarm scheduled in worker 1');

  // Cold Kill Worker 1
  await sim.flush();
  sim.kill();
  assert(!sim.isRunning, 'Worker 1 killed');

  // Alarm still exists in persistent browser engine
  const persistedAlarms = await sim.alarms.getAll();
  assert(persistedAlarms.length > 0, 'Alarms engine preserves alarm across SW kill');

  // Restart Worker 2 from bundle
  await sim.boot(bundle);

  // Advance virtual time past due
  await sim.advanceTime(130000);

  // Callback must have executed in recovered worker!
  const results = sim.evaluate('taskResults');
  assert(results.length === 1, 'processBackgroundTask executed after SW cold restart');
  assert(results[0].startsWith('task_completed_at_'), 'Task payload recorded properly');
}

async function runAll() {
  await testNamedAlarmHandlers();
  await testShortVsLongRuntime();
  await testTimerCancellation();
  await testClearAllProtection();
  await testColdRestartAlarmRecovery();

  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runAll().catch((err) => {
  console.error('Unhandled failure in timers-alarms.test.ts:', err);
  process.exit(1);
});
