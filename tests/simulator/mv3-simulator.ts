/**
 * Node.js MV3 Service Worker Lifecycle Simulator
 * 
 * Provides an in-memory, context-isolated execution environment for Chrome Manifest V3
 * Service Workers. Faithfully simulates:
 * - chrome.storage.session & chrome.storage.local (with deep structured cloning)
 * - chrome.alarms (virtual clock, alarm scheduling, advanceTime stepping)
 * - webextension-polyfill bridge (browser.* and Browser.*)
 * - chrome.runtime (lifecycle events, onMessage sync/async dispatch, getURL, getContexts)
 * - chrome.tabs, notifications, offscreen, webRequest, contextMenus
 * - SW Lifecycle: boot(), flush(), kill(), restart(), advanceTime(), dispatchMessage()
 */

import * as vm from 'node:vm';

export function deepClone<T>(val: T): T {
  if (val === undefined || val === null) return val;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(val);
    } catch {
      // Fallback for non-cloneable objects
      return JSON.parse(JSON.stringify(val));
    }
  }
  return JSON.parse(JSON.stringify(val));
}

// ============================================================================
// 1. Storage Mock
// ============================================================================

export class StorageAreaMock {
  private data = new Map<string, any>();

  constructor(initialData: Record<string, any> = {}) {
    for (const [key, val] of Object.entries(initialData)) {
      this.data.set(key, deepClone(val));
    }
  }

  async get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>> {
    const result: Record<string, any> = {};

    if (keys === null || keys === undefined) {
      for (const [k, v] of this.data.entries()) {
        result[k] = deepClone(v);
      }
      return result;
    }

    if (typeof keys === 'string') {
      if (this.data.has(keys)) {
        result[keys] = deepClone(this.data.get(keys));
      }
      return result;
    }

    if (Array.isArray(keys)) {
      for (const k of keys) {
        if (this.data.has(k)) {
          result[k] = deepClone(this.data.get(k));
        }
      }
      return result;
    }

    if (typeof keys === 'object') {
      for (const [k, defaultVal] of Object.entries(keys)) {
        if (this.data.has(k)) {
          result[k] = deepClone(this.data.get(k));
        } else {
          result[k] = deepClone(defaultVal);
        }
      }
      return result;
    }

    return result;
  }

  async set(items: Record<string, any>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.data.set(k, deepClone(v));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) {
      this.data.delete(k);
    }
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  getRawData(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of this.data.entries()) {
      out[k] = deepClone(v);
    }
    return out;
  }
}

// ============================================================================
// 2. Alarms Mock
// ============================================================================

export interface ScheduledAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export interface AlarmCreateInfo {
  delayInMinutes?: number;
  periodInMinutes?: number;
  when?: number;
}

export type AlarmListener = (alarm: ScheduledAlarm) => void | Promise<void>;

export class AlarmsMock {
  private scheduledAlarms = new Map<string, ScheduledAlarm>();
  private listeners = new Set<AlarmListener>();

  constructor(private getNow: () => number) {}

  async create(nameOrInfo: string | AlarmCreateInfo, maybeInfo?: AlarmCreateInfo): Promise<void> {
    let name: string;
    let alarmInfo: AlarmCreateInfo;

    if (typeof nameOrInfo === 'object' && nameOrInfo !== null) {
      name = '';
      alarmInfo = nameOrInfo;
    } else {
      name = typeof nameOrInfo === 'string' ? nameOrInfo : '';
      alarmInfo = maybeInfo || {};
    }

    let scheduledTime: number;
    const now = this.getNow();

    if (alarmInfo.when !== undefined) {
      scheduledTime = alarmInfo.when;
    } else if (alarmInfo.delayInMinutes !== undefined) {
      scheduledTime = now + alarmInfo.delayInMinutes * 60 * 1000;
    } else if (alarmInfo.periodInMinutes !== undefined) {
      scheduledTime = now + alarmInfo.periodInMinutes * 60 * 1000;
    } else {
      scheduledTime = now;
    }

    const alarm: ScheduledAlarm = {
      name,
      scheduledTime,
      periodInMinutes: alarmInfo.periodInMinutes,
    };

    this.scheduledAlarms.set(name, alarm);
  }

  async get(name: string): Promise<ScheduledAlarm | undefined> {
    const alarm = this.scheduledAlarms.get(name);
    return alarm ? deepClone(alarm) : undefined;
  }

  async getAll(): Promise<ScheduledAlarm[]> {
    return Array.from(this.scheduledAlarms.values()).map((a) => deepClone(a));
  }

  async clear(name: string): Promise<boolean> {
    return this.scheduledAlarms.delete(name);
  }

  async clearAll(): Promise<boolean> {
    this.scheduledAlarms.clear();
    return true;
  }

  onAlarm = {
    addListener: (cb: AlarmListener) => {
      this.listeners.add(cb);
    },
    removeListener: (cb: AlarmListener) => {
      this.listeners.delete(cb);
    },
    hasListener: (cb: AlarmListener) => {
      return this.listeners.has(cb);
    },
  };

  clearListeners(): void {
    this.listeners.clear();
  }

  async dispatch(alarm: ScheduledAlarm): Promise<void> {
    const list = Array.from(this.listeners);
    for (const listener of list) {
      try {
        await listener(deepClone(alarm));
      } catch (err) {
        console.error(`[AlarmsMock] Error in alarm listener for '${alarm.name}':`, err);
      }
    }
  }

  extractDueAlarms(currentTime: number): ScheduledAlarm[] {
    const due: ScheduledAlarm[] = [];
    for (const [name, alarm] of this.scheduledAlarms.entries()) {
      if (alarm.scheduledTime <= currentTime) {
        due.push(deepClone(alarm));
        if (alarm.periodInMinutes && alarm.periodInMinutes > 0) {
          const intervalMs = alarm.periodInMinutes * 60 * 1000;
          let nextTime = alarm.scheduledTime + intervalMs;
          while (nextTime <= currentTime) {
            nextTime += intervalMs;
          }
          alarm.scheduledTime = nextTime;
        } else {
          this.scheduledAlarms.delete(name);
        }
      }
    }
    due.sort((a, b) => a.scheduledTime - b.scheduledTime);
    return due;
  }
}

// ============================================================================
// 3. Events & Messaging Mocks
// ============================================================================

export class EventMock<T extends (...args: any[]) => any> {
  private listeners = new Set<T>();

  addListener(cb: T): void {
    this.listeners.add(cb);
  }

  removeListener(cb: T): void {
    this.listeners.delete(cb);
  }

  hasListener(cb: T): boolean {
    return this.listeners.has(cb);
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  async dispatch(...args: Parameters<T>): Promise<any[]> {
    const results: any[] = [];
    const list = Array.from(this.listeners);
    for (const fn of list) {
      try {
        const res = await fn(...args);
        results.push(res);
      } catch (err) {
        console.error('[EventMock] Error in listener:', err);
      }
    }
    return results;
  }

  get count(): number {
    return this.listeners.size;
  }
}

export type MessageListener = (
  message: any,
  sender: any,
  sendResponse: (response?: any) => void
) => boolean | Promise<any> | void;

export class MessageEventMock {
  private listeners = new Set<MessageListener>();

  addListener(cb: MessageListener): void {
    this.listeners.add(cb);
  }

  removeListener(cb: MessageListener): void {
    this.listeners.delete(cb);
  }

  hasListener(cb: MessageListener): boolean {
    return this.listeners.has(cb);
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  get count(): number {
    return this.listeners.size;
  }

  async dispatchMessage(message: any, sender: any = {}): Promise<any> {
    const list = Array.from(this.listeners);
    let resolvedValue: any = undefined;

    for (const listener of list) {
      let sendResponseCalled = false;
      let sendResponseVal: any = undefined;
      let resolvePromise: (val: any) => void;
      let rejectPromise: (err: any) => void;

      const responsePromise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      const sendResponse = (res: any) => {
        sendResponseCalled = true;
        sendResponseVal = res;
        resolvePromise(res);
      };

      let ret: any;
      try {
        ret = listener(deepClone(message), deepClone(sender), sendResponse);
      } catch (err) {
        rejectPromise!(err);
        throw err;
      }

      if (ret === true) {
        resolvedValue = await responsePromise;
      } else if (ret && typeof ret.then === 'function') {
        resolvedValue = await ret;
      } else if (sendResponseCalled) {
        resolvedValue = sendResponseVal;
      } else if (ret !== undefined) {
        resolvedValue = ret;
      }
    }

    return deepClone(resolvedValue);
  }
}

// ============================================================================
// 4. Runtime & Standard Browser API Mocks
// ============================================================================

export class RuntimeMock {
  id = 'mv3-simulator-ext-id';
  onInstalled = new EventMock<(details?: { reason: string }) => void>();
  onStartup = new EventMock<() => void>();
  onMessage = new MessageEventMock();

  constructor(private getOffscreenStatus: () => boolean) {}

  getURL(path: string): string {
    const clean = path.startsWith('/') ? path.slice(1) : path;
    return `chrome-extension://${this.id}/${clean}`;
  }

  async getContexts(query: any = {}): Promise<any[]> {
    const contexts: any[] = [];
    if (this.getOffscreenStatus()) {
      if (!query.contextTypes || query.contextTypes.includes('OFFSCREEN_DOCUMENT')) {
        contexts.push({
          contextType: 'OFFSCREEN_DOCUMENT',
          documentUrl: this.getURL('offscreen.html'),
        });
      }
    }
    return contexts;
  }
}

export class TabsMock {
  private tabs = new Map<number, any>();
  private nextId = 1;

  async get(tabId: number): Promise<any> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found`);
    return deepClone(tab);
  }

  async create(createProperties: any = {}): Promise<any> {
    const id = this.nextId++;
    const tab = {
      id,
      url: createProperties.url || 'about:blank',
      active: createProperties.active ?? true,
      status: 'complete',
      ...createProperties,
    };
    this.tabs.set(id, tab);
    return deepClone(tab);
  }

  async update(tabId: number, updateProperties: any = {}): Promise<any> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found`);
    Object.assign(tab, updateProperties);
    return deepClone(tab);
  }

  async remove(tabId: number | number[]): Promise<void> {
    const ids = Array.isArray(tabId) ? tabId : [tabId];
    for (const id of ids) {
      this.tabs.delete(id);
    }
  }

  async query(queryInfo: any = {}): Promise<any[]> {
    return Array.from(this.tabs.values()).map((t) => deepClone(t));
  }

  clear(): void {
    this.tabs.clear();
  }
}

export class NotificationsMock {
  private notifications = new Map<string, any>();
  private nextId = 1;
  onClicked = new EventMock<(notificationId: string) => void>();

  async create(idOrOptions: any, optionsMaybe?: any): Promise<string> {
    let id: string;
    let options: any;
    if (typeof idOrOptions === 'string') {
      id = idOrOptions;
      options = optionsMaybe;
    } else {
      id = `notif_${this.nextId++}`;
      options = idOrOptions;
    }
    this.notifications.set(id, deepClone(options));
    return id;
  }

  async clear(notificationId: string): Promise<boolean> {
    return this.notifications.delete(notificationId);
  }

  getAll(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of this.notifications.entries()) {
      out[k] = deepClone(v);
    }
    return out;
  }
}

export class OffscreenMock {
  private hasDoc = false;

  async createDocument(opts: any): Promise<void> {
    if (this.hasDoc) {
      throw new Error('Only a single offscreen document may be created.');
    }
    this.hasDoc = true;
  }

  async closeDocument(): Promise<void> {
    this.hasDoc = false;
  }

  hasDocument(): boolean {
    return this.hasDoc;
  }
}

export class WebRequestMock {
  onBeforeRequest = new EventMock<(details: any) => any>();
}

export class ContextMenusMock {
  private menus = new Map<string, any>();
  onClicked = new EventMock<(info: any, tab?: any) => void>();

  create(createProperties: any, callback?: () => void): string {
    const id = createProperties.id || `menu_${Date.now()}`;
    this.menus.set(id, deepClone(createProperties));
    if (callback) callback();
    return id;
  }

  removeAll(callback?: () => void): void {
    this.menus.clear();
    if (callback) callback();
  }
}

// ============================================================================
// 5. Simulator Options & Simulator Class
// ============================================================================

export interface SimulatorOptions {
  virtualClockStart?: number;
  initialStorage?: {
    session?: Record<string, any>;
    local?: Record<string, any>;
  };
}

interface ActiveTimer {
  id: number;
  type: 'timeout' | 'interval';
  fn: Function;
  args: any[];
  delayMs: number;
  nativeHandle: any;
  virtualDueTime: number;
}

export class MV3LifecycleSimulator {
  virtualClock: number;

  storage: {
    session: StorageAreaMock;
    local: StorageAreaMock;
  };

  alarms: AlarmsMock;
  runtime: RuntimeMock;
  tabs: TabsMock;
  notifications: NotificationsMock;
  offscreen: OffscreenMock;
  webRequest: WebRequestMock;
  contextMenus: ContextMenusMock;
  action: {
    onClicked: EventMock<(tab?: any) => void>;
  };

  private context: vm.Context | null = null;
  private activeBundle: string | null = null;
  private activeTimers = new Map<number, ActiveTimer>();
  private nextTimerId = 1;

  constructor(options: SimulatorOptions = {}) {
    this.virtualClock = options.virtualClockStart ?? Date.now();

    this.storage = {
      session: new StorageAreaMock(options.initialStorage?.session ?? {}),
      local: new StorageAreaMock(options.initialStorage?.local ?? {}),
    };

    this.alarms = new AlarmsMock(() => this.virtualClock);
    this.tabs = new TabsMock();
    this.notifications = new NotificationsMock();
    this.offscreen = new OffscreenMock();
    this.webRequest = new WebRequestMock();
    this.contextMenus = new ContextMenusMock();
    this.action = {
      onClicked: new EventMock<(tab?: any) => void>(),
    };
    this.runtime = new RuntimeMock(() => this.offscreen.hasDocument());
  }

  get isRunning(): boolean {
    return this.context !== null;
  }

  get activeContext(): vm.Context | null {
    return this.context;
  }

  // --------------------------------------------------------------------------
  // Lifecycle API
  // --------------------------------------------------------------------------

  async boot(bundleCode: string): Promise<void> {
    if (this.context) {
      this.kill();
    }

    this.activeBundle = bundleCode;
    this.context = this.createWorkerContext();

    // Execute bundle inside isolated VM sandbox
    const script = new vm.Script(bundleCode, { filename: 'service-worker.js' });
    script.runInContext(this.context);

    // Drain microtasks and await __mv3_init
    await this.waitForInit();
  }

  async flush(): Promise<void> {
    if (!this.context) return;

    // Trigger all active interval timers (including __mv3_flushDirty)
    const timers = Array.from(this.activeTimers.values());
    for (const timer of timers) {
      if (timer.type === 'interval') {
        try {
          const res = timer.fn(...timer.args);
          if (res && typeof res.then === 'function') {
            await res;
          }
        } catch (err) {
          console.error('[MV3LifecycleSimulator] Error flushing interval:', err);
        }
      }
    }

    // Drain microtasks and event loop ticks
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  kill(): void {
    if (!this.context) return;

    // 1. Cancel all context-bound native timers
    for (const timer of this.activeTimers.values()) {
      if (timer.type === 'timeout') {
        clearTimeout(timer.nativeHandle);
      } else {
        clearInterval(timer.nativeHandle);
      }
    }
    this.activeTimers.clear();

    // 2. Clear context-bound event listeners
    this.alarms.clearListeners();
    this.runtime.onInstalled.clearListeners();
    this.runtime.onStartup.clearListeners();
    this.runtime.onMessage.clearListeners();
    this.notifications.onClicked.clearListeners();
    this.contextMenus.onClicked.clearListeners();
    this.action.onClicked.clearListeners();
    this.webRequest.onBeforeRequest.clearListeners();

    // 3. Destroy active VM context
    this.context = null;
  }

  async restart(bundleCode?: string): Promise<void> {
    const code = bundleCode || this.activeBundle;
    if (!code) {
      throw new Error('Cannot restart without bundle code');
    }
    this.kill();
    await this.boot(code);
  }

  async advanceTime(ms: number): Promise<void> {
    const targetTime = this.virtualClock + ms;
    this.virtualClock = targetTime;

    // 1. Advance virtual timeouts/intervals
    const dueTimers = Array.from(this.activeTimers.values())
      .filter((t) => t.virtualDueTime <= targetTime)
      .sort((a, b) => a.virtualDueTime - b.virtualDueTime);

    for (const timer of dueTimers) {
      if (timer.type === 'timeout') {
        clearTimeout(timer.nativeHandle);
        this.activeTimers.delete(timer.id);
        try {
          const res = timer.fn(...timer.args);
          if (res && typeof res.then === 'function') await res;
        } catch (err) {
          console.error('[MV3LifecycleSimulator] Error in advanceTime timer callback:', err);
        }
      } else if (timer.type === 'interval') {
        const stepMs = Math.max(1, timer.delayMs);
        let nextDue = timer.virtualDueTime;
        while (nextDue <= targetTime) {
          try {
            const res = timer.fn(...timer.args);
            if (res && typeof res.then === 'function') await res;
          } catch (err) {
            console.error('[MV3LifecycleSimulator] Error in advanceTime interval callback:', err);
          }
          nextDue += stepMs;
        }
        timer.virtualDueTime = nextDue;
      }
    }

    // 2. Dispatch due alarms
    const dueAlarms = this.alarms.extractDueAlarms(targetTime);
    for (const alarm of dueAlarms) {
      await this.alarms.dispatch(alarm);
    }

    // 3. Drain microtasks
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  async dispatchMessage(message: any, sender: any = {}): Promise<any> {
    if (!this.context) {
      throw new Error('Worker context is not active (call boot() first)');
    }
    return await this.runtime.onMessage.dispatchMessage(message, sender);
  }

  async dispatchAlarm(name: string): Promise<void> {
    if (!this.context) {
      throw new Error('Worker context is not active');
    }
    const alarm = await this.alarms.get(name);
    const alarmObj: ScheduledAlarm = alarm || {
      name,
      scheduledTime: this.virtualClock,
    };
    await this.alarms.dispatch(alarmObj);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  evaluate<T = any>(code: string): T {
    if (!this.context) {
      throw new Error('Worker context is not active');
    }
    return vm.runInContext(code, this.context);
  }

  async evaluateAsync<T = any>(code: string): Promise<T> {
    if (!this.context) {
      throw new Error('Worker context is not active');
    }
    const res = vm.runInContext(code, this.context);
    return await res;
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private async waitForInit(): Promise<void> {
    if (this.context && this.context.__mv3_init && typeof this.context.__mv3_init.then === 'function') {
      try {
        await this.context.__mv3_init;
      } catch (err) {
        console.error('[MV3LifecycleSimulator] Error awaiting __mv3_init:', err);
      }
    }

    // Check for any top-level promises in context
    if (this.context) {
      for (const key of Object.keys(this.context)) {
        try {
          const val = this.context[key];
          if (val && typeof val.then === 'function') {
            await Promise.race([
              val,
              new Promise((r) => setTimeout(r, 100)),
            ]);
          }
        } catch {
          // ignore
        }
      }
    }

    // Drain microtasks & I/O
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  private createWorkerContext(): vm.Context {
    const simulator = this;
    const realDate = Date;

    class VirtualDate extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(simulator.virtualClock);
        } else {
          super(...(args as [any]));
        }
      }

      static now(): number {
        return simulator.virtualClock;
      }

      static [Symbol.hasInstance](instance: any): boolean {
        return instance instanceof realDate;
      }
    }

    const mockChrome: any = {
      storage: {
        session: this.storage.session,
        local: this.storage.local,
      },
      alarms: {
        create: (nameOrInfo: any, info?: any) => this.alarms.create(nameOrInfo, info),
        get: (name: string) => this.alarms.get(name),
        getAll: () => this.alarms.getAll(),
        clear: (name: string) => this.alarms.clear(name),
        clearAll: () => this.alarms.clearAll(),
        onAlarm: this.alarms.onAlarm,
      },
      runtime: {
        id: this.runtime.id,
        onInstalled: this.runtime.onInstalled,
        onStartup: this.runtime.onStartup,
        onMessage: this.runtime.onMessage,
        getURL: (path: string) => this.runtime.getURL(path),
        getContexts: (q: any) => this.runtime.getContexts(q),
      },
      tabs: this.tabs,
      notifications: this.notifications,
      offscreen: this.offscreen,
      webRequest: this.webRequest,
      contextMenus: this.contextMenus,
      action: this.action,
    };

    const mockBrowser: any = {
      storage: {
        session: {
          get: (keys?: any) => this.storage.session.get(keys),
          set: (items: any) => this.storage.session.set(items),
          remove: (keys: any) => this.storage.session.remove(keys),
          clear: () => this.storage.session.clear(),
        },
        local: {
          get: (keys?: any) => this.storage.local.get(keys),
          set: (items: any) => this.storage.local.set(items),
          remove: (keys: any) => this.storage.local.remove(keys),
          clear: () => this.storage.local.clear(),
        },
      },
      alarms: {
        create: (nameOrInfo: any, info?: any) => this.alarms.create(nameOrInfo, info),
        get: (name: string) => this.alarms.get(name),
        getAll: () => this.alarms.getAll(),
        clear: (name: string) => this.alarms.clear(name),
        clearAll: () => this.alarms.clearAll(),
        onAlarm: this.alarms.onAlarm,
      },
      runtime: {
        id: this.runtime.id,
        onInstalled: this.runtime.onInstalled,
        onStartup: this.runtime.onStartup,
        onMessage: this.runtime.onMessage,
        getURL: (path: string) => this.runtime.getURL(path),
        getContexts: (q: any) => this.runtime.getContexts(q),
        sendMessage: (msg: any) => this.runtime.onMessage.dispatchMessage(msg),
      },
      tabs: {
        get: (id: number) => this.tabs.get(id),
        create: (opts: any) => this.tabs.create(opts),
        update: (id: number, opts: any) => this.tabs.update(id, opts),
        remove: (id: number | number[]) => this.tabs.remove(id),
        query: (info: any) => this.tabs.query(info),
      },
      notifications: {
        create: (idOrOpts: any, opts?: any) => this.notifications.create(idOrOpts, opts),
        clear: (id: string) => this.notifications.clear(id),
        onClicked: this.notifications.onClicked,
      },
      offscreen: {
        createDocument: (opts: any) => this.offscreen.createDocument(opts),
        closeDocument: () => this.offscreen.closeDocument(),
      },
      webRequest: {
        onBeforeRequest: this.webRequest.onBeforeRequest,
      },
      contextMenus: {
        create: (props: any) => this.contextMenus.create(props),
        removeAll: () => this.contextMenus.removeAll(),
        onClicked: this.contextMenus.onClicked,
      },
      action: this.action,
    };

    const mockSetTimeout = (fn: Function, delay: number = 0, ...args: any[]) => {
      const id = this.nextTimerId++;
      const delayMs = Math.max(0, Number(delay) || 0);
      const virtualDueTime = this.virtualClock + delayMs;

      const nativeHandle = setTimeout(() => {
        this.activeTimers.delete(id);
        try {
          fn(...args);
        } catch (err) {
          console.error('[MV3LifecycleSimulator] Error in setTimeout callback:', err);
        }
      }, delayMs);

      this.activeTimers.set(id, {
        id,
        type: 'timeout',
        fn,
        args,
        delayMs,
        nativeHandle,
        virtualDueTime,
      });

      return id;
    };

    const mockClearTimeout = (id: any) => {
      if (id == null) return;
      const numId = Number(id);
      const timer = this.activeTimers.get(numId);
      if (timer) {
        clearTimeout(timer.nativeHandle);
        this.activeTimers.delete(numId);
      }
    };

    const mockSetInterval = (fn: Function, interval: number = 0, ...args: any[]) => {
      const id = this.nextTimerId++;
      const delayMs = Math.max(0, Number(interval) || 0);
      const virtualDueTime = this.virtualClock + delayMs;

      const nativeHandle = setInterval(() => {
        const t = this.activeTimers.get(id);
        if (t) {
          t.virtualDueTime = this.virtualClock + delayMs;
        }
        try {
          fn(...args);
        } catch (err) {
          console.error('[MV3LifecycleSimulator] Error in setInterval callback:', err);
        }
      }, delayMs);

      this.activeTimers.set(id, {
        id,
        type: 'interval',
        fn,
        args,
        delayMs,
        nativeHandle,
        virtualDueTime,
      });

      return id;
    };

    const mockClearInterval = (id: any) => {
      if (id == null) return;
      const numId = Number(id);
      const timer = this.activeTimers.get(numId);
      if (timer) {
        clearInterval(timer.nativeHandle);
        this.activeTimers.delete(numId);
      }
    };

    const sandbox: any = {
      chrome: mockChrome,
      browser: mockBrowser,
      Browser: mockBrowser,
      console,
      setTimeout: mockSetTimeout,
      clearTimeout: mockClearTimeout,
      setInterval: mockSetInterval,
      clearInterval: mockClearInterval,
      Date: VirtualDate,
      Object,
      Array,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Proxy,
      Reflect,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      String,
      Number,
      Boolean,
      Symbol,
      JSON,
      Math,
      RegExp,
      queueMicrotask,
      structuredClone: (v: any) => deepClone(v),
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
    };

    const context = vm.createContext(sandbox);
    sandbox.globalThis = context;
    sandbox.self = context;
    sandbox.window = context;

    return context;
  }
}

export function createSimulator(options?: SimulatorOptions): MV3LifecycleSimulator {
  return new MV3LifecycleSimulator(options);
}
