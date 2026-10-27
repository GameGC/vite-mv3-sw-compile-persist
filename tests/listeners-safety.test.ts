/**
 * Comprehensive Test Suite for Event Listener Safety:
 * 1. Chrome event listeners: onInstalled, onStartup, onMessage, webRequest.onBeforeRequest
 * 2. Synchronous `return true` handlers preserving Chrome's asynchronous message port
 * 3. Async handlers and async IIFEs awaiting __mv3_init safely
 * 4. Blocking webRequest handlers maintaining synchronous returns
 * 5. In-simulator execution and message dispatch
 */

import { assert, transform, compileTestBundle, resetCounters, printResults } from './test-helpers.js';
import { createSimulator } from './simulator/mv3-simulator.js';

resetCounters();

console.log('\n=== 1. AST Analysis: Synchronous return true vs Async Handlers ===');
{
  const source = `
let msgCounter = 0;

// Case A: Sync onMessage with return true (must NOT become async)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    setTimeout(() => {
      msgCounter++;
      sendResponse({ reply: 'PONG', count: msgCounter });
    }, 10);
    return true;
  }
});

// Case B: Async onMessage directly returning value (should have await __mv3_init injected)
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === 'ASYNC_PING') {
    msgCounter += 5;
    return { reply: 'ASYNC_PONG', count: msgCounter };
  }
});

// Case C: Sync onMessage returning an async IIFE (outer must stay sync, IIFE gets await __mv3_init)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'IIFE_PING') {
    return (async () => {
      msgCounter += 20;
      return { reply: 'IIFE_PONG', count: msgCounter };
    })();
  }
});

// Case D: Blocking webRequest handler (hasReturnValue=true, must NOT become async)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes('blocked.com')) {
      return { cancel: true };
    }
  },
  { urls: ['<all_urls>'] }
);

// Case E: Void sync onInstalled listener (no return value, CAN become async)
chrome.runtime.onInstalled.addListener(() => {
  msgCounter = 100;
});
`;

  const { code: out } = transform(source);

  // Case A: Verify NOT async
  assert(
    out.includes('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {') &&
      !out.includes('chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {'),
    'Sync return-true onMessage handler is NOT prepended with async',
  );

  // Case B: Verify async handler gets await __mv3_init
  assert(
    out.includes('chrome.runtime.onMessage.addListener(async (message) => {') &&
      out.includes('await __mv3_init;'),
    'Async onMessage handler receives await __mv3_init',
  );

  // Case C: Verify outer stays sync, inner IIFE gets await __mv3_init
  assert(
    out.includes('chrome.runtime.onMessage.addListener((message) => {') &&
      out.includes('return (async () => {') &&
      out.includes('await __mv3_init;'),
    'Async IIFE handler preserves sync outer wrapper and injects await __mv3_init into IIFE body',
  );

  // Case D: Blocking webRequest must NOT become async
  assert(
    out.includes('chrome.webRequest.onBeforeRequest.addListener(\n  (details) => {') ||
      out.includes('chrome.webRequest.onBeforeRequest.addListener(\n  async (details) => {') === false,
    'Blocking webRequest handler is NOT prepended with async',
  );

  // Case E: Void sync onInstalled becomes async
  assert(
    out.includes('chrome.runtime.onInstalled.addListener(async () => {'),
    'Void onInstalled handler safely converted to async',
  );
}

console.log('\n=== 2. Runtime Simulator: Sync return true with Asynchronous sendResponse ===');
async function testSyncReturnTrue() {
  const source = `
let requestLog = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ASYNC_WORK') {
    requestLog.push(msg.id);
    setTimeout(() => {
      sendResponse({ status: 'done', id: msg.id, logSize: requestLog.length });
    }, 20);
    return true; // Keep port open
  }
});
`;

  const bundle = compileTestBundle(source);
  const sim = createSimulator();

  await sim.boot(bundle);

  // Send message and await response from async sendResponse
  const response = await sim.dispatchMessage({ type: 'ASYNC_WORK', id: 'job-101' });

  assert(response !== undefined, 'Received response from async sendResponse');
  assert(response.status === 'done', 'Response status is done');
  assert(response.id === 'job-101', 'Response id is job-101');
  assert(response.logSize === 1, 'requestLog contains 1 entry');
}

console.log('\n=== 3. Runtime Simulator: Async IIFE onMessage Handler ===');
async function testAsyncIIFEHandler() {
  const source = `
let iifeCounter = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'IIFE_TEST') {
    return (async () => {
      // Async body awaiting persistence init
      iifeCounter += msg.delta;
      return { total: iifeCounter };
    })();
  }
});
`;

  const bundle = compileTestBundle(source);
  const sim = createSimulator();

  await sim.boot(bundle);

  const res1 = await sim.dispatchMessage({ type: 'IIFE_TEST', delta: 5 });
  assert(res1.total === 5, 'Async IIFE message handler resolved total: 5');

  const res2 = await sim.dispatchMessage({ type: 'IIFE_TEST', delta: 15 });
  assert(res2.total === 20, 'Async IIFE message handler resolved total: 20');

  // Verify persistence across restart
  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('iifeCounter') === 20, 'iifeCounter preserved across SW restart');
}

console.log('\n=== 4. Runtime Simulator: Direct Async onMessage Handler ===');
async function testDirectAsyncHandler() {
  const source = `
let directData = { count: 0, items: [] };

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'ADD_ITEM') {
    directData.count++;
    directData.items.push(msg.item);
    return { count: directData.count, items: directData.items };
  }
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  const res = await sim.dispatchMessage({ type: 'ADD_ITEM', item: 'alpha' });
  assert(res.count === 1, 'Direct async message handler returned count: 1');
  assert(res.items.length === 1 && res.items[0] === 'alpha', 'Item added');

  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('directData.count') === 1, 'directData.count preserved after restart');
  assert(sim.evaluate('directData.items[0]') === 'alpha', 'directData.items preserved after restart');
}

console.log('\n=== 5. Runtime Simulator: Blocking webRequest.onBeforeRequest ===');
async function testWebRequestBlocking() {
  const source = `
let blockedCount = 0;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes('/analytics/track')) {
      blockedCount++;
      return { cancel: true };
    }
    return { cancel: false };
  },
  { urls: ['<all_urls>'] }
);
`;

  const bundle = compileTestBundle(source);
  const sim = createSimulator();

  await sim.boot(bundle);

  // Dispatch simulated web requests
  const blockedRes = await sim.webRequest.onBeforeRequest.dispatch({
    url: 'https://example.com/analytics/track?uid=123',
    method: 'GET',
    tabId: 1,
  });
  assert(blockedRes.length > 0 && blockedRes[0].cancel === true, 'Analytics request blocked synchronously');
  assert(sim.evaluate('blockedCount') === 1, 'blockedCount incremented');

  const allowedRes = await sim.webRequest.onBeforeRequest.dispatch({
    url: 'https://example.com/api/data',
    method: 'GET',
    tabId: 1,
  });
  assert(allowedRes.length > 0 && allowedRes[0].cancel === false, 'Standard API request allowed');
}

console.log('\n=== 6. Runtime Simulator: onInstalled & onStartup Ordering & Init ===');
async function testLifecycleListeners() {
  const source = `
let lifecycleHistory = [];
let startupVal = 0;

chrome.runtime.onInstalled.addListener(async (details) => {
  lifecycleHistory.push('installed_' + details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  lifecycleHistory.push('startup');
  startupVal = 999;
});
`;

  const bundle = compileTestBundle(source, { strategy: 'proxy' });
  const sim = createSimulator();

  await sim.boot(bundle);

  // Dispatch onInstalled
  await sim.runtime.onInstalled.dispatch({ reason: 'install' });
  assert(sim.evaluate('lifecycleHistory[0]') === 'installed_install', 'onInstalled recorded history');

  // Dispatch onStartup
  await sim.runtime.onStartup.dispatch();
  assert(sim.evaluate('lifecycleHistory[1]') === 'startup', 'onStartup recorded history');
  assert(sim.evaluate('startupVal') === 999, 'startupVal updated in onStartup');

  await sim.flush();
  await sim.restart(bundle);

  assert(sim.evaluate('lifecycleHistory.length') === 2, 'lifecycleHistory preserved across restart');
  assert(sim.evaluate('startupVal') === 999, 'startupVal preserved across restart');
}

async function runAll() {
  await testSyncReturnTrue();
  await testAsyncIIFEHandler();
  await testDirectAsyncHandler();
  await testWebRequestBlocking();
  await testLifecycleListeners();

  const allPassed = printResults();
  process.exit(allPassed ? 0 : 1);
}

runAll().catch((err) => {
  console.error('Unhandled failure in listeners-safety.test.ts:', err);
  process.exit(1);
});
