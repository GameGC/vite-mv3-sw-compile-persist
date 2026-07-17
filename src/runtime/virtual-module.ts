import type {
  ResolvedOptions,
  AnalysisResult,
} from '../types.js';

// --- buildVirtualRuntime ---

export function buildVirtualRuntime(
  analysis: AnalysisResult,
  opts: ResolvedOptions,
): string {
  const { topVars } = analysis;
  const storage = opts.storageArea;
  const varNames = topVars.map((v) => v.name);
  const booleanVars = topVars.filter((v) => v.isBoolean);
  const useProxy = opts.stateStrategy === 'proxy';

  // Keepalive strategy code for __mv3_setTimeout short delays (< ALARM_THRESHOLD)
  let shortDelayCode: string;
  if (opts.keepaliveStrategy === 'offscreen') {
    shortDelayCode = `
  __mv3_ensureOffscreenDocument();
  __mv3_native_timer_count++;
  const __nativeId = __native_setTimeout(() => {
    __mv3_native_timer_count--;
    callback();
  }, delay);
  return __nativeId;`;
  } else if (opts.keepaliveStrategy === 'alarm') {
    shortDelayCode = `
  const __nativeId = __native_setTimeout(() => {
    callback();
  }, delay);
  return __nativeId;`;
  } else {
    shortDelayCode = `
  const __nativeId = __native_setTimeout(() => {
    callback();
  }, delay);
  return __nativeId;`;
  }

  return `// MV3 Persistent Runtime (auto-generated)

const __mv3_ext: any = globalThis.browser || globalThis.chrome;

interface MV3RuntimeConfig {
  varNames: string[];
  booleanVarNames: string[];
  storageArea: 'session' | 'local';
  alarmThresholdMs: number;
  autoFlushMs: number;
  staleLockThresholdMs: number;
  keepaliveStrategy: 'alarm' | 'offscreen' | 'none';
  stateStrategy: 'static' | 'proxy';
  promiseResolverStrategy: 'native' | 'alarm';
}

interface MV3VarAccessors {
  getVar(name: string): any;
  setVar(name: string, value: any): void;
  getDirtyData(name: string, prefix: string): Record<string, any> | null;
}

interface MV3RuntimeAPI {
  __mv3_init: Promise<void>;
  readonly __mv3_init_done: boolean;
  __mv3_markDirty(varName: string): void;
  __mv3_setTimeout(callback: () => void, delay: number): string | number;
  __mv3_setInterval(callback: () => void, intervalMs: number): string | number;
  __mv3_setTimeoutPromise(callback: () => void, delay: number): string | number;
  __mv3_setIntervalPromise(callback: () => void, intervalMs: number): string | number;
  __mv3_clearTimeout(id: string | number | null | undefined): void;
  __mv3_clearInterval(id: string | number | null | undefined): void;
  __mv3_reactive<T extends object>(target: T, varName: string): T;
  __mv3_getVar(name: string): any;
  __mv3_bindMethod(varName: string, methodName: string): (...args: any[]) => any;
  __mv3_registerFn(name: string, fn: (...args: any[]) => any): void;
  __mv3_fn_registry: Record<string, (...args: any[]) => any>;
  __mv3_fn_names: Map<(...args: any[]) => any, string>;
  __mv3_serialize(value: any, collectionType: string): any;
  __mv3_deserialize(raw: any, collectionType: string): any;
}

export function createMV3Runtime(
  config: MV3RuntimeConfig,
  accessors: MV3VarAccessors,
): MV3RuntimeAPI {

const __native_setTimeout = globalThis.setTimeout.bind(globalThis);
const __native_setInterval = globalThis.setInterval.bind(globalThis);
const __native_clearTimeout = globalThis.clearTimeout.bind(globalThis);
const __native_clearInterval = globalThis.clearInterval.bind(globalThis);

const __mv3_prefix = '__mv3_';
const __mv3_varNames: string[] = config.varNames;
const __mv3_storage = config.storageArea === 'local'
  ? __mv3_ext.storage.local
  : __mv3_ext.storage.session;

// Restore state from storage on startup
let __mv3_init_done = false;
const __mv3_init = (async () => {
  try {
    const __mv3_stored_keys = __mv3_varNames.map(k => __mv3_prefix + k);
    const __mv3_stored = await __mv3_storage.get(__mv3_stored_keys);
    for (const v of __mv3_varNames) {
      if (__mv3_stored_keys.includes(__mv3_prefix + v)) {
        const raw = __mv3_stored[__mv3_prefix + v];
        if (raw !== undefined) {
          accessors.setVar(v, raw);
        }
      }
    }
    // Stale-lock recovery
    for (const bv of config.booleanVarNames) {
      if (accessors.getVar(bv) === true) {
        const __mv3_alarms = await __mv3_ext.alarms.getAll();
        const __mv3_hasActiveWork = __mv3_alarms.some(
          (a: any) => a.name.startsWith('__mv3_alarm_')
        );
        if (!__mv3_hasActiveWork) {
          const __mv3_lockAgeKey = __mv3_prefix + 'lockAge_' + bv;
          const __mv3_ageData = await __mv3_storage.get(__mv3_lockAgeKey);
          const __mv3_lockAge = __mv3_ageData[__mv3_lockAgeKey];
          const __mv3_staleThreshold = config.staleLockThresholdMs;
          if (!__mv3_lockAge || (Date.now() - __mv3_lockAge > __mv3_staleThreshold)) {
            accessors.setVar(bv, false);
            __mv3_storage.remove(__mv3_lockAgeKey).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
            console.log('[MV3] Cleared stale ' + bv + ' lock on restore.');
          } else {
            console.log('[MV3] ' + bv + ' lock is recent (' + (Date.now() - __mv3_lockAge) + 'ms ago). Keeping it.');
          }
        }
      }
    }
  } catch (__mv3_e: any) {
    console.error('[MV3] Failed to restore persistent state:', __mv3_e);
  }
  __mv3_init_done = true;
})();

// Flush state to storage
const __mv3_dirty = new Set<string>();

${booleanVars.length > 0 ? `const __mv3_booleanVarNames = new Set(${JSON.stringify(booleanVars.map(v => v.name))});` : ''}

function __mv3_markDirty(varName: string): void {
  __mv3_dirty.add(varName);
}

async function __mv3_flushDirty(): Promise<void> {
  if (__mv3_dirty.size === 0) return;
  const __snapshot = new Set(__mv3_dirty);
  const data: Record<string, any> = {};
  const now = Date.now();
  for (const __name of __snapshot) {
    const chunk = accessors.getDirtyData(__name, __mv3_prefix);
    if (chunk) Object.assign(data, chunk);
${booleanVars.length > 0 ? `    if (__mv3_booleanVarNames.has(__name)) {
      const __currentVal = __mv3_getVar(__name);
      if (__currentVal === true) {
        data[__mv3_prefix + 'lockAge_' + __name] = now;
      } else {
        __mv3_storage.remove(__mv3_prefix + 'lockAge_' + __name).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
      }
    }
` : ''}
  }
  if (Object.keys(data).length > 0) {
    try {
      await __mv3_storage.set(data);
      for (const __name of __snapshot) {
        __mv3_dirty.delete(__name);
      }
    } catch (__mv3_e: any) {
      console.error('[MV3] Failed to flush dirty state:', __mv3_e);
    }
  }
}

${opts.autoFlushMs > 0 ? `__native_setInterval(__mv3_flushDirty, ${opts.autoFlushMs});` : '// Auto-flush disabled'}

// Promise-resolver pending registry
const __mv3_promise_pending = new Map<string, { delay: number; created: number }>();

function __mv3_trackPromiseTimer(timerId: string | number, delay: number): void {
  const key = String(timerId);
  const entry = { delay, created: Date.now() };
  __mv3_promise_pending.set(key, entry);
  __mv3_storage.set({
    [__mv3_prefix + 'promise_' + key]: entry,
  }).catch(e => console.warn('[MV3] Storage write failed:', e));
}

function __mv3_untrackPromiseTimer(timerId: string | number): void {
  const key = String(timerId);
  __mv3_promise_pending.delete(key);
  __mv3_storage.remove(__mv3_prefix + 'promise_' + key).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
}

function __mv3_getVar(name: string): any {
  return accessors.getVar(name);
}

// Serialization for Map/Set/Date (structured clone through chrome.storage loses type info)
function __mv3_serialize(value: any, collectionType: string): any {
  if (value instanceof Map) return { __mv3_type: 'Map', entries: Array.from(value.entries()) };
  if (value instanceof Set) return { __mv3_type: 'Set', values: Array.from(value.values()) };
  if (value instanceof Date) return { __mv3_type: 'Date', iso: value.toISOString() };
  return value;
}

function __mv3_deserialize(raw: any, collectionType: string): any {
  if (raw && typeof raw === 'object' && raw.__mv3_type) {
    switch (raw.__mv3_type) {
      case 'Map': return new Map(raw.entries);
      case 'Set': return new Set(raw.values);
      case 'Date': return new Date(raw.iso);
    }
  }
  return raw;
}

function __mv3_bindMethod(varName: string, methodName: string): (...args: any[]) => any {
  return function(...args: any[]) {
    const __obj = __mv3_getVar(varName);
    if (__obj && typeof __obj[methodName] === 'function') {
      return __obj[methodName].apply(__obj, args);
    }
    throw new Error('[MV3] Cannot call ' + varName + '.' + methodName + '()');
  };
}

${useProxy ? `// Reactive tracking (stateStrategy: 'proxy')
const __mv3_PROXY_CACHE = new WeakMap<object, object>();
const __mv3_isProxy = new WeakSet<object>();

function __mv3_reactiveMap<K, V>(map: Map<K, V>, varName: string): Map<K, V> {
  const origSet = map.set.bind(map);
  const origDelete = map.delete.bind(map);
  const origClear = map.clear.bind(map);
  (map as any).set = function(key: K, value: V) {
    const result = origSet(key, value);
    __mv3_dirty.add(varName);
    return result;
  };
  (map as any).delete = function(key: K) {
    const result = origDelete(key);
    if (result) __mv3_dirty.add(varName);
    return result;
  };
  (map as any).clear = function() {
    origClear();
    __mv3_dirty.add(varName);
  };
  return map;
}

function __mv3_reactiveSet<T>(set: Set<T>, varName: string): Set<T> {
  const origAdd = set.add.bind(set);
  const origDelete = set.delete.bind(set);
  const origClear = set.clear.bind(set);
  (set as any).add = function(value: T) {
    const result = origAdd(value);
    __mv3_dirty.add(varName);
    return result;
  };
  (set as any).delete = function(value: T) {
    const result = origDelete(value);
    if (result) __mv3_dirty.add(varName);
    return result;
  };
  (set as any).clear = function() {
    origClear();
    __mv3_dirty.add(varName);
  };
  return set;
}

function __mv3_reactiveDate(date: Date, varName: string): Date {
  const mutatingMethods = [
    'setDate', 'setFullYear', 'setHours', 'setMilliseconds',
    'setMinutes', 'setMonth', 'setSeconds', 'setTime',
    'setUTCDate', 'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds',
    'setUTCMinutes', 'setUTCMonth', 'setUTCSeconds', 'setYear',
  ];
  for (const method of mutatingMethods) {
    const orig = (date as any)[method];
    if (typeof orig === 'function') {
      (date as any)[method] = function(...args: any[]) {
        const result = orig.apply(date, args);
        __mv3_dirty.add(varName);
        return result;
      };
    }
  }
  return date;
}

function __mv3_reactive<T extends object>(target: T, varName: string): T {
  if (__mv3_isProxy.has(target as object)) return target;

  if (target instanceof Map) return __mv3_reactiveMap(target as any, varName) as T;
  if (target instanceof Set) return __mv3_reactiveSet(target as any, varName) as T;
  if (target instanceof Date) return __mv3_reactiveDate(target, varName) as T;

  if (__mv3_PROXY_CACHE.has(target)) return __mv3_PROXY_CACHE.get(target) as T;

  const handler: ProxyHandler<T> = {
    set(obj: any, key: string | symbol, value: any, receiver: any): boolean {
      const ok = Reflect.set(obj, key, value, receiver);
      if (ok) {
        __mv3_dirty.add(varName);
        if (value && typeof value === 'object' && !__mv3_PROXY_CACHE.has(value)) {
          const proxied = __mv3_reactive(value, varName);
          obj[key] = proxied;
        }
      }
      return ok;
    },
    deleteProperty(obj: any, key: string | symbol): boolean {
      const ok = Reflect.deleteProperty(obj, key);
      if (ok) __mv3_dirty.add(varName);
      return ok;
    },
    get(obj: any, key: string | symbol, receiver: any): any {
      const value = Reflect.get(obj, key, receiver);
      if (value && typeof value === 'object') {
        return __mv3_reactive(value, varName);
      }
      return value;
    },
  };

  const proxy = new Proxy(target, handler) as T;
  __mv3_PROXY_CACHE.set(target, proxy);
  __mv3_isProxy.add(proxy as object);
  return proxy;
}
` : `// static mode — no reactive Proxy wrappers
function __mv3_reactive<T extends object>(target: T, _varName: string): T {
  return target;
}
`}

${opts.keepaliveStrategy === 'offscreen' ? `// Offscreen document for SW keepalive
const __mv3_offscreen_url = 'offscreen.html';
const __mv3_offscreen_reasons = ['WORKERS'] as any[];
let __mv3_offscreen_creating: Promise<void> | null = null;
let __mv3_offscreen_owned = false;

async function __mv3_ensureOffscreenDocument(): Promise<void> {
  try {
    const existingContexts = await __mv3_ext.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as any],
      documentUrls: [__mv3_ext.runtime.getURL(__mv3_offscreen_url)],
    });
    if (existingContexts.length > 0) {
      __mv3_offscreen_owned = false;
      return;
    }

    if (__mv3_offscreen_creating) {
      await __mv3_offscreen_creating;
      return;
    }

    __mv3_offscreen_creating = __mv3_ext.offscreen
      .createDocument({
        url: __mv3_offscreen_url,
        reasons: __mv3_offscreen_reasons,
        justification: 'Keep service worker alive for pending background timers',
      })
      .then(() => {
        __mv3_offscreen_creating = null;
        __mv3_offscreen_owned = true;
      })
      .catch((err: any) => {
        __mv3_offscreen_creating = null;
        if (err.message?.includes('Only a single offscreen')) {
          __mv3_offscreen_owned = false;
          return;
        }
        console.warn('[MV3] Offscreen document error:', err);
      });

    await __mv3_offscreen_creating;
  } catch (_e) { /* ignore */ }
}

async function __mv3_closeOffscreenDocument(): Promise<void> {
  if (!__mv3_offscreen_owned) return;
  try {
    await __mv3_ext.offscreen.closeDocument();
    __mv3_offscreen_owned = false;
  } catch (_e) { /* ignore */ }
}
` : ''}

// Function registry
const __mv3_fn_registry: Record<string, (...args: any[]) => any> = {};
const __mv3_fn_names = new Map<(...args: any[]) => any, string>();

function __mv3_registerFn(name: string, fn: (...args: any[]) => any): void {
  __mv3_fn_registry[name] = fn;
  __mv3_fn_names.set(fn, name);
}

// Alarm-based timer wrappers
const __mv3_ALARM_THRESHOLD = config.alarmThresholdMs;
let __mv3_alarm_counter = 0;
const __mv3_alarm_callbacks = new Map<string, () => void>();
${opts.keepaliveStrategy === 'offscreen' ? `let __mv3_native_timer_count = 0;` : ''}

function __mv3_setTimeout(callback: () => void, delay: number): string | number {
  if (delay >= __mv3_ALARM_THRESHOLD) {
    const alarmName = \`__mv3_alarm_timeout_\${__mv3_alarm_counter++}\`;
    __mv3_alarm_callbacks.set(alarmName, callback);
    const fnName = __mv3_fn_names.get(callback) || null;
    __mv3_storage.set({
      [__mv3_prefix + 'alarm_' + alarmName]: { fnName, delay, created: Date.now() }
    }).catch(e => console.warn('[MV3] Storage write failed:', e));
    __mv3_ext.alarms.create(alarmName, {
      delayInMinutes: Math.max(delay / 60000, 0.5),
    });
    return alarmName;
  }
${shortDelayCode}
}

function __mv3_setInterval(callback: () => void, intervalMs: number): string | number {
  if (intervalMs >= __mv3_ALARM_THRESHOLD) {
    const alarmName = \`__mv3_alarm_interval_\${__mv3_alarm_counter++}\`;
    __mv3_alarm_callbacks.set(alarmName, callback);
    const fnName = __mv3_fn_names.get(callback) || null;
    __mv3_storage.set({
      [__mv3_prefix + 'alarm_' + alarmName]: { fnName, intervalMs, created: Date.now() }
    }).catch(e => console.warn('[MV3] Storage write failed:', e));
    __mv3_ext.alarms.create(alarmName, {
      periodInMinutes: Math.max(intervalMs / 60000, 0.5),
    });
    return alarmName;
  }
${opts.keepaliveStrategy === 'offscreen' ? `  __mv3_ensureOffscreenDocument();
  __mv3_native_timer_count++;
  const __nativeId = __native_setInterval(callback, intervalMs);
  return __nativeId;` : `  const __nativeId = __native_setInterval(callback, intervalMs);
  return __nativeId;`}
}

function __mv3_setTimeoutPromise(callback: () => void, delay: number): string | number {
  const id = __mv3_setTimeout(() => {
    __mv3_untrackPromiseTimer(id);
    callback();
  }, delay);
  __mv3_trackPromiseTimer(id, delay);
  return id;
}

function __mv3_setIntervalPromise(callback: () => void, intervalMs: number): string | number {
  const id = __mv3_setInterval(() => {
    callback();
  }, intervalMs);
  __mv3_trackPromiseTimer(id, intervalMs);
  return id;
}

function __mv3_clearTimeout(id: string | number | null | undefined): void {
  if (id == null) return;
  if (typeof id === 'string' && id.startsWith('__mv3_alarm_')) {
    __mv3_ext.alarms.clear(id);
    __mv3_alarm_callbacks.delete(id);
    __mv3_storage.remove(__mv3_prefix + 'alarm_' + id).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
${opts.keepaliveStrategy === 'offscreen' ? `    if (__mv3_alarm_callbacks.size === 0 && __mv3_native_timer_count === 0) {
      __mv3_closeOffscreenDocument();
    }` : ''}
  } else if (typeof id === 'number') {
    __native_clearTimeout(id);
    __mv3_untrackPromiseTimer(id);
${opts.keepaliveStrategy === 'offscreen' ? `    __mv3_native_timer_count = Math.max(0, __mv3_native_timer_count - 1);
    if (__mv3_alarm_callbacks.size === 0 && __mv3_native_timer_count === 0) {
      __mv3_closeOffscreenDocument();
    }` : ''}
  }
}

function __mv3_clearInterval(id: string | number | null | undefined): void {
  if (id == null) return;
  if (typeof id === 'string' && id.startsWith('__mv3_alarm_')) {
    __mv3_ext.alarms.clear(id);
    __mv3_alarm_callbacks.delete(id);
    __mv3_storage.remove(__mv3_prefix + 'alarm_' + id).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
${opts.keepaliveStrategy === 'offscreen' ? `    if (__mv3_alarm_callbacks.size === 0 && __mv3_native_timer_count === 0) {
      __mv3_closeOffscreenDocument();
    }` : ''}
  } else if (typeof id === 'number') {
    __native_clearInterval(id);
    __mv3_untrackPromiseTimer(id);
${opts.keepaliveStrategy === 'offscreen' ? `    __mv3_native_timer_count = Math.max(0, __mv3_native_timer_count - 1);
    if (__mv3_alarm_callbacks.size === 0 && __mv3_native_timer_count === 0) {
      __mv3_closeOffscreenDocument();
    }` : ''}
  }
}

// Alarm dispatch
__mv3_ext.alarms.onAlarm.addListener(async (__mv3_alarm: any) => {
  if (__mv3_alarm.name.startsWith('__mv3_alarm_timeout_')) {
    let cb = __mv3_alarm_callbacks.get(__mv3_alarm.name);
    __mv3_alarm_callbacks.delete(__mv3_alarm.name);

    if (!cb) {
      try {
        const meta = await __mv3_storage.get(__mv3_prefix + 'alarm_' + __mv3_alarm.name);
        const info = meta[__mv3_prefix + 'alarm_' + __mv3_alarm.name];
        if (info && info.fnName && __mv3_fn_registry[info.fnName]) {
          cb = __mv3_fn_registry[info.fnName];
          console.log(\`[MV3] Recovered alarm callback: \${info.fnName}\`);
        } else if (info && info.fnName) {
          console.warn(\`[MV3] Alarm callback '\${info.fnName}' not found in registry. Add it to namedAlarmHandlers.\`);
        } else {
          console.warn(\`[MV3] Alarm '\${__mv3_alarm.name}' fired but no callback found (anonymous function).\`);
        }
      } catch (_e) { /* ignore */ }
    }

    __mv3_storage.remove(__mv3_prefix + 'alarm_' + __mv3_alarm.name).catch(e => console.warn('[MV3] Storage cleanup failed:', e));

    if (cb) {
      try { cb(); } catch (e) { console.error('[MV3] Alarm callback error:', e); }
    }
${opts.keepaliveStrategy === 'offscreen' ? `    if (__mv3_alarm_callbacks.size === 0 && __mv3_native_timer_count === 0) {
      __mv3_closeOffscreenDocument();
    }` : ''}
  } else if (__mv3_alarm.name.startsWith('__mv3_alarm_interval_')) {
    let cb = __mv3_alarm_callbacks.get(__mv3_alarm.name);

    if (!cb) {
      try {
        const meta = await __mv3_storage.get(__mv3_prefix + 'alarm_' + __mv3_alarm.name);
        const info = meta[__mv3_prefix + 'alarm_' + __mv3_alarm.name];
        if (info && info.fnName && __mv3_fn_registry[info.fnName]) {
          cb = __mv3_fn_registry[info.fnName];
          __mv3_alarm_callbacks.set(__mv3_alarm.name, cb);
          console.log(\`[MV3] Recovered interval callback: \${info.fnName}\`);
        }
      } catch (_e) { /* ignore */ }
    }

    if (cb) {
      try { cb(); } catch (e) { console.error('[MV3] Interval callback error:', e); }
    }
  }
});

// Re-register pending alarms + check unresolved promises after SW restart
(async () => {
  await __mv3_init;
  try {
    const all = await __mv3_storage.get(null);
    const now = Date.now();

    for (const [key, info] of Object.entries(all)) {
      if (key.startsWith(__mv3_prefix + 'alarm_')) {
        const alarmName = key.replace(__mv3_prefix + 'alarm_', '');
        if (!alarmName.startsWith('__mv3_alarm_')) continue;

        const alarm = await __mv3_ext.alarms.get(alarmName);
        if (alarm && (info as any).fnName && __mv3_fn_registry[(info as any).fnName]) {
          __mv3_alarm_callbacks.set(alarmName, __mv3_fn_registry[(info as any).fnName]);
          console.log(\`[MV3] Pre-registered alarm: \${alarmName} -> \${(info as any).fnName}\`);
        } else if (!alarm) {
          __mv3_storage.remove(key).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
        }
      }

      if (key.startsWith(__mv3_prefix + 'promise_')) {
        const entry = info as { delay: number; created: number };
        const elapsed = now - entry.created;
        if (elapsed > entry.delay) {
          __mv3_storage.remove(key).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
        } else {
          console.warn(
            '[MV3] Unresolved Promise from previous SW session. ' +
            'Promise(resolve => setTimeout(resolve, ' + entry.delay + ')) was pending ' +
            elapsed + 'ms ago when SW died. It will never resolve. ' +
            'Consider promiseResolverStrategy: "alarm" or keepaliveStrategy: "offscreen".',
          );
          __mv3_storage.remove(key).catch(e => console.warn('[MV3] Storage cleanup failed:', e));
        }
      }
    }
  } catch (_e) { /* ignore */ }
})();

return {
  __mv3_init,
  get __mv3_init_done() { return __mv3_init_done; },
  __mv3_markDirty,
  __mv3_setTimeout,
  __mv3_setInterval,
  __mv3_setTimeoutPromise,
  __mv3_setIntervalPromise,
  __mv3_clearTimeout,
  __mv3_clearInterval,
  __mv3_reactive,
  __mv3_getVar,
  __mv3_bindMethod,
  __mv3_registerFn,
  __mv3_fn_registry,
  __mv3_fn_names,
  __mv3_serialize,
  __mv3_deserialize,
};

} // end createMV3Runtime
`;
}
