/**
 * Comprehensive E2E Testing Harness for vite-mv3-sw-compile-persist
 *
 * Provides:
 * 1. Opaque-box transformation wrapper for compiler & runtime testing
 * 2. In-memory Chrome MV3 Service Worker Environment mock (storage, alarms, runtime, tabs, notifications)
 * 3. VM Sandbox execution engine with cold restart simulation
 * 4. Programmatic Vite build helper
 * 5. Deterministic test assertion & reporting framework
 */

import * as vm from 'vm';
import ts from 'typescript';
import { mv3Persistent } from '../../src/index.js';
import type { PluginOptions } from '../../src/types.js';
import { build, type InlineConfig } from 'vite';

export interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: Error | string;
  durationMs: number;
}

export class TestHarness {
  public results: TestResult[] = [];
  private currentSuite = 'General';

  setSuite(name: string) {
    this.currentSuite = name;
    console.log(`\n=== [Suite] ${name} ===`);
  }

  async runTest(name: string, fn: () => void | Promise<void>): Promise<boolean> {
    const start = Date.now();
    try {
      await fn();
      const durationMs = Date.now() - start;
      this.results.push({
        suite: this.currentSuite,
        name,
        passed: true,
        durationMs,
      });
      console.log(`  PASS ${name} (${durationMs}ms)`);
      return true;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err : new Error(String(err));
      this.results.push({
        suite: this.currentSuite,
        name,
        passed: false,
        error,
        durationMs,
      });
      console.log(`  FAIL ${name} (${durationMs}ms)`);
      console.log(`    Error: ${error.message}`);
      if (error.stack) {
        const stackLines = error.stack.split('\n').slice(1, 4).join('\n');
        console.log(`    ${stackLines}`);
      }
      return false;
    }
  }

  getSummary() {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.passed).length;
    const failed = total - passed;
    return { total, passed, failed, results: this.results };
  }

  printSummary() {
    const { total, passed, failed } = this.getSummary();
    console.log(`\n------------------------------------------------------------`);
    console.log(`E2E Test Run Finished: ${passed}/${total} passed (${failed} failed)`);
    console.log(`------------------------------------------------------------`);
    return failed === 0;
  }
}

// ----------------------------------------------------------------------------
// Expect assertion helper
// ----------------------------------------------------------------------------
export function expect(actual: any) {
  return {
    toBe(expected: any, msg?: string) {
      if (actual !== expected) {
        throw new Error(msg || `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: any, msg?: string) {
      const actualJson = JSON.stringify(actual);
      const expectedJson = JSON.stringify(expected);
      if (actualJson !== expectedJson) {
        throw new Error(msg || `Expected deep equality:\nExpected: ${expectedJson}\nReceived: ${actualJson}`);
      }
    },
    toBeTruthy(msg?: string) {
      if (!actual) {
        throw new Error(msg || `Expected truthy value, received ${JSON.stringify(actual)}`);
      }
    },
    toBeFalsy(msg?: string) {
      if (actual) {
        throw new Error(msg || `Expected falsy value, received ${JSON.stringify(actual)}`);
      }
    },
    toContain(expectedSubstrOrItem: any, msg?: string) {
      if (typeof actual === 'string') {
        if (!actual.includes(expectedSubstrOrItem)) {
          throw new Error(msg || `Expected string to contain "${expectedSubstrOrItem}"`);
        }
      } else if (Array.isArray(actual)) {
        if (!actual.includes(expectedSubstrOrItem)) {
          throw new Error(msg || `Expected array to contain item ${JSON.stringify(expectedSubstrOrItem)}`);
        }
      } else if (actual instanceof Set || actual instanceof Map) {
        if (!actual.has(expectedSubstrOrItem)) {
          throw new Error(msg || `Expected collection to contain key ${JSON.stringify(expectedSubstrOrItem)}`);
        }
      } else {
        throw new Error(`Unsupported type for toContain: ${typeof actual}`);
      }
    },
    toNotContain(unexpectedSubstrOrItem: any, msg?: string) {
      if (typeof actual === 'string') {
        if (actual.includes(unexpectedSubstrOrItem)) {
          throw new Error(msg || `Expected string NOT to contain "${unexpectedSubstrOrItem}"`);
        }
      } else if (Array.isArray(actual)) {
        if (actual.includes(unexpectedSubstrOrItem)) {
          throw new Error(msg || `Expected array NOT to contain item ${JSON.stringify(unexpectedSubstrOrItem)}`);
        }
      }
    },
    toBeGreaterThan(expected: number, msg?: string) {
      if (typeof actual !== 'number' || actual <= expected) {
        throw new Error(msg || `Expected ${actual} > ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number, msg?: string) {
      if (typeof actual !== 'number' || actual < expected) {
        throw new Error(msg || `Expected ${actual} >= ${expected}`);
      }
    },
    toBeLessThan(expected: number, msg?: string) {
      if (typeof actual !== 'number' || actual >= expected) {
        throw new Error(msg || `Expected ${actual} < ${expected}`);
      }
    },
    toThrow(expectedSubstring?: string) {
      if (typeof actual !== 'function') {
        throw new Error(`toThrow requires a function, received ${typeof actual}`);
      }
      let threw = false;
      let thrownError: any = null;
      try {
        actual();
      } catch (err) {
        threw = true;
        thrownError = err;
      }
      if (!threw) {
        throw new Error('Expected function to throw, but it executed without error');
      }
      if (expectedSubstring && thrownError) {
        const msg = String(thrownError.message || thrownError);
        if (!msg.includes(expectedSubstring)) {
          throw new Error(`Expected error message to contain "${expectedSubstring}", received "${msg}"`);
        }
      }
    },
  };
}

// ----------------------------------------------------------------------------
// Compiler & Transform Helpers
// ----------------------------------------------------------------------------
export interface TransformOutput {
  code: string;
  virtualModule: string;
  combined: string;
}

export function compileSource(
  code: string,
  options: Partial<PluginOptions> = {},
  filename = '/src/background/index.ts',
): TransformOutput {
  const plugin = mv3Persistent({
    backgroundEntry: options.backgroundEntry ?? /.*/,
    alarmThresholdMs: options.alarmThresholdMs ?? 60_000,
    storageArea: options.storageArea ?? 'session',
    stateStrategy: options.stateStrategy ?? 'proxy',
    keepaliveStrategy: options.keepaliveStrategy ?? 'alarm',
    autoFlushMs: options.autoFlushMs ?? 2_000,
    staleLockThresholdMs: options.staleLockThresholdMs ?? 30_000,
    promiseResolverStrategy: options.promiseResolverStrategy ?? 'native',
    safeClosureVars: options.safeClosureVars ?? [],
    excludeVars: options.excludeVars ?? [],
    persistentVars: options.persistentVars ?? [],
    namedAlarmHandlers: options.namedAlarmHandlers ?? {},
  });

  const VIRTUAL_ID = '\0virtual:mv3-persist-runtime.ts';

  const pluginContext = {
    error(msg: string) {
      throw new Error(`[Plugin Error] ${msg}`);
    },
    warn(msg: string) {
      // capture or suppress
    },
  };

  const transformResult = plugin.transform!.call(pluginContext, code, filename);
  const transformedCode = transformResult ? transformResult.code : code;

  const loaded = plugin.load!.call(pluginContext, VIRTUAL_ID);
  const virtualModule = typeof loaded === 'string' ? loaded : '';

  return {
    code: transformedCode,
    virtualModule,
    combined: `${transformedCode}\n${virtualModule}`,
  };
}

// ----------------------------------------------------------------------------
// In-Memory Storage & Alarms Mock
// ----------------------------------------------------------------------------
export interface StorageAreaMock {
  get: (keys?: string | string[] | Record<string, any> | null) => Promise<Record<string, any>>;
  set: (items: Record<string, any>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
  clear: () => Promise<void>;
  _raw: Record<string, any>;
}

export function createStorageAreaMock(): StorageAreaMock {
  const store: Record<string, any> = {};

  return {
    _raw: store,
    async get(keys) {
      if (!keys) {
        return structuredClone(store);
      }
      if (typeof keys === 'string') {
        return { [keys]: store[keys] !== undefined ? structuredClone(store[keys]) : undefined };
      }
      if (Array.isArray(keys)) {
        const result: Record<string, any> = {};
        for (const k of keys) {
          if (store[k] !== undefined) result[k] = structuredClone(store[k]);
        }
        return result;
      }
      if (typeof keys === 'object') {
        const result: Record<string, any> = { ...keys };
        for (const k of Object.keys(keys)) {
          if (store[k] !== undefined) result[k] = structuredClone(store[k]);
        }
        return result;
      }
      return structuredClone(store);
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store[k] = structuredClone(v);
      }
    },
    async remove(keys) {
      const arr = typeof keys === 'string' ? [keys] : keys;
      for (const k of arr) {
        delete store[k];
      }
    },
    async clear() {
      for (const k of Object.keys(store)) {
        delete store[k];
      }
    },
  };
}

export interface AlarmItem {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export interface AlarmsMock {
  create: (name: string, alarmInfo: { when?: number; delayInMinutes?: number; periodInMinutes?: number }) => Promise<void>;
  get: (name: string) => Promise<AlarmItem | undefined>;
  getAll: () => Promise<AlarmItem[]>;
  clear: (name: string) => Promise<boolean>;
  clearAll: () => Promise<boolean>;
  onAlarm: {
    addListener: (fn: (alarm: AlarmItem) => void) => void;
    _listeners: ((alarm: AlarmItem) => void)[];
  };
  _alarms: Map<string, AlarmItem>;
}

export function createAlarmsMock(nowFn: () => number): AlarmsMock {
  const alarms = new Map<string, AlarmItem>();
  const listeners: ((alarm: AlarmItem) => void)[] = [];

  return {
    _alarms: alarms,
    async create(name, info) {
      const now = nowFn();
      let scheduledTime = now;
      if (info.when) {
        scheduledTime = info.when;
      } else if (info.delayInMinutes !== undefined) {
        scheduledTime = now + info.delayInMinutes * 60_000;
      }
      alarms.set(name, {
        name,
        scheduledTime,
        periodInMinutes: info.periodInMinutes,
      });
    },
    async get(name) {
      return alarms.get(name);
    },
    async getAll() {
      return Array.from(alarms.values());
    },
    async clear(name) {
      return alarms.delete(name);
    },
    async clearAll() {
      alarms.clear();
      return true;
    },
    onAlarm: {
      _listeners: listeners,
      addListener(fn) {
        listeners.push(fn);
      },
    },
  };
}

export interface MockChromeEnvironment {
  storage: {
    session: StorageAreaMock;
    local: StorageAreaMock;
  };
  alarms: AlarmsMock;
  runtime: {
    id: string;
    onInstalled: { addListener: (fn: Function) => void; _listeners: Function[] };
    onStartup: { addListener: (fn: Function) => void; _listeners: Function[] };
    onMessage: { addListener: (fn: Function) => void; _listeners: Function[] };
    sendMessage: (msg: any) => Promise<any>;
  };
  tabs: {
    get: (tabId: number) => Promise<any>;
    create: (props: any) => Promise<any>;
    update: (tabId: number, props: any) => Promise<any>;
    remove: (tabId: number) => Promise<void>;
    _tabs: Map<number, any>;
  };
  notifications: {
    create: (idOrOptions: any, options?: any) => Promise<string>;
    _created: any[];
  };
  currentTime: number;
  advanceTime: (ms: number) => Promise<void>;
  dispatchAlarm: (name: string) => Promise<void>;
  dispatchMessage: (msg: any) => Promise<any>;
}

export function createMockChromeEnvironment(): MockChromeEnvironment {
  let virtualClock = Date.now();
  const getVirtualTime = () => virtualClock;

  const storageSession = createStorageAreaMock();
  const storageLocal = createStorageAreaMock();
  const alarms = createAlarmsMock(getVirtualTime);

  const installedListeners: Function[] = [];
  const startupListeners: Function[] = [];
  const messageListeners: Function[] = [];
  const tabsMap = new Map<number, any>([[1, { id: 1, url: 'https://example.com', active: true }]]);
  let nextTabId = 2;
  const notificationsCreated: any[] = [];

  const env: MockChromeEnvironment = {
    currentTime: virtualClock,
    storage: {
      session: storageSession,
      local: storageLocal,
    },
    alarms,
    runtime: {
      id: 'mock-mv3-extension-id',
      onInstalled: {
        _listeners: installedListeners,
        addListener: (fn: Function) => installedListeners.push(fn),
      },
      onStartup: {
        _listeners: startupListeners,
        addListener: (fn: Function) => startupListeners.push(fn),
      },
      onMessage: {
        _listeners: messageListeners,
        addListener: (fn: Function) => messageListeners.push(fn),
      },
      async sendMessage(msg: any) {
        return env.dispatchMessage(msg);
      },
    },
    tabs: {
      _tabs: tabsMap,
      async get(id: number) {
        if (!tabsMap.has(id)) throw new Error(`Tab ${id} not found`);
        return tabsMap.get(id);
      },
      async create(props: any) {
        const id = nextTabId++;
        const tab = { id, ...props };
        tabsMap.set(id, tab);
        return tab;
      },
      async update(id: number, props: any) {
        const tab = tabsMap.get(id) || { id };
        Object.assign(tab, props);
        tabsMap.set(id, tab);
        return tab;
      },
      async remove(id: number) {
        tabsMap.delete(id);
      },
    },
    notifications: {
      _created: notificationsCreated,
      async create(idOrOptions: any, options?: any) {
        const notif = options || idOrOptions;
        notificationsCreated.push(notif);
        return 'notif-' + notificationsCreated.length;
      },
    },
    async advanceTime(ms: number) {
      virtualClock += ms;
      env.currentTime = virtualClock;

      // Check scheduled alarms
      const allAlarms = await alarms.getAll();
      for (const a of allAlarms) {
        if (a.scheduledTime <= virtualClock) {
          await env.dispatchAlarm(a.name);
          if (a.periodInMinutes) {
            a.scheduledTime = virtualClock + a.periodInMinutes * 60_000;
          } else {
            await alarms.clear(a.name);
          }
        }
      }
    },
    async dispatchAlarm(name: string) {
      const alarmObj = (await alarms.get(name)) || { name, scheduledTime: virtualClock };
      for (const listener of alarms.onAlarm._listeners) {
        await listener(alarmObj);
      }
    },
    async dispatchMessage(msg: any) {
      let finalResult: any = undefined;
      for (const listener of messageListeners) {
        const res = listener(msg, { id: 'sender' }, (response: any) => {
          finalResult = response;
        });
        if (res instanceof Promise) {
          finalResult = await res;
        } else if (res !== undefined) {
          finalResult = res;
        }
      }
      return finalResult;
    },
  };

  return env;
}

// ----------------------------------------------------------------------------
// In-Memory VM Execution Sandbox
// ----------------------------------------------------------------------------
export interface ExecutionContext {
  context: vm.Context;
  chrome: MockChromeEnvironment;
  runCode: (code: string) => any;
  destroy: () => void;
}

export function createExecutionContext(env: MockChromeEnvironment): ExecutionContext {
  const activeTimers = new Set<NodeJS.Timeout>();

  const sandbox: any = {
    chrome: {
      storage: env.storage,
      alarms: env.alarms,
      runtime: env.runtime,
      tabs: env.tabs,
      notifications: env.notifications,
    },
    browser: undefined,
    Browser: undefined,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    setTimeout: (fn: Function, ms?: number, ...args: any[]) => {
      const t = setTimeout(() => {
        activeTimers.delete(t);
        fn(...args);
      }, ms);
      activeTimers.add(t);
      return t;
    },
    clearTimeout: (id: any) => {
      clearTimeout(id);
      activeTimers.delete(id);
    },
    setInterval: (fn: Function, ms?: number, ...args: any[]) => {
      const t = setInterval(fn, ms, ...args);
      activeTimers.add(t);
      return t;
    },
    clearInterval: (id: any) => {
      clearInterval(id);
      activeTimers.delete(id);
    },
    Date: globalThis.Date,
    Map: globalThis.Map,
    Set: globalThis.Set,
    WeakMap: globalThis.WeakMap,
    WeakSet: globalThis.WeakSet,
    Promise: globalThis.Promise,
    Proxy: globalThis.Proxy,
    Reflect: globalThis.Reflect,
    Error: globalThis.Error,
    Array: globalThis.Array,
    Object: globalThis.Object,
    String: globalThis.String,
    Number: globalThis.Number,
    Boolean: globalThis.Boolean,
    Math: globalThis.Math,
    JSON: globalThis.JSON,
    structuredClone: globalThis.structuredClone,
  };

  sandbox.browser = sandbox.chrome;
  sandbox.Browser = sandbox.chrome;

  const context = vm.createContext(sandbox);
  sandbox.globalThis = context;
  sandbox.self = context;

  return {
    context,
    chrome: env,
    runCode(code: string) {
      const script = new vm.Script(code);
      return script.runInContext(context);
    },
    destroy() {
      for (const t of activeTimers) {
        clearTimeout(t);
        clearInterval(t);
      }
      activeTimers.clear();
    },
  };
}

/**
 * Builds an executable bundle string combining user code and virtual runtime
 * suitable for vm.runInContext.
 */
export function buildExecutableBundle(
  userSource: string,
  options: Partial<PluginOptions> = {},
): string {
  const { code, virtualModule } = compileSource(userSource, options);

  // In the generated transformed code, replace import { createMV3Runtime } with inlined runtime module
  const cleanedVm = virtualModule
    .replace('export function createMV3Runtime', 'function createMV3Runtime');

  let executable = code.replace(
    /import\s*\{\s*createMV3Runtime\s*\}\s*from\s*['"]virtual:mv3-persist-runtime['"];?/,
    `\n// Inlined Virtual Runtime\nconst { createMV3Runtime } = (() => {\n${cleanedVm}\nreturn { createMV3Runtime };\n})();\n`,
  );

  // Clean any ES module import/export for polyfill/utils in mock tests
  executable = executable.replace(/import\s+Browser\s+from\s+['"]webextension-polyfill['"];?/g, 'const Browser = globalThis.Browser || globalThis.chrome;');
  executable = executable.replace(/import\s+.*?from\s+['"].*?['"];?/g, '// [mocked import]');
  executable = executable.replace(/export\s+default\s+/g, '// export default ');
  executable = executable.replace(/export\s+/g, '// export ');

  const transpiled = ts.transpileModule(executable, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });

  return transpiled.outputText;
}
