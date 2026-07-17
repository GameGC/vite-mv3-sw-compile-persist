/**
 * vite-plugin-mv3-persistent  v7.1
 *
 * Types, options, and constants for the MV3 persistent plugin.
 */

import type * as Babel from '@babel/types';

// ═══════════════════════════════════════════════════════════════════════
// § Public Options
// ═══════════════════════════════════════════════════════════════════════

export interface MV3PersistentOptions {
  /** File-path pattern that identifies the background entry. */
  backgroundEntry?: string | RegExp;
  /** Explicit list of variable names to persist. Auto-detect when empty. */
  persistentVars?: string[];
  /** Variable names to exclude from persistence. */
  excludeVars?: string[];
  /** setTimeout delay (ms) above which chrome.alarms is used (default 60 000). */
  alarmThresholdMs?: number;
  /** Storage area: 'session' (cleared on browser close) or 'local'. */
  storageArea?: 'session' | 'local';
  /** Auto-flush interval in ms (0 = disabled). Default 2 000. */
  autoFlushMs?: number;
  /**
   * Strategy for keeping the service worker alive during timers:
   * - 'alarm'    → use chrome.alarms for timers ≥ alarmThresholdMs (default 60 s).
   *                Timers below alarmThresholdMs use native setTimeout with no
   *                keepalive — the SW may die during short waits. Choose this when
   *                you only need long-delay persistence and accept short-timer loss.
   * - 'offscreen' → create an offscreen document that keeps the SW alive
   *                 via chrome.offscreen API (CWS-safe, Chrome 109+). Best
   *                 protection for short-delay timers that must not be lost.
   * - 'none'     → no keepalive, accept SW may die during any wait
   */
  keepaliveStrategy?: 'alarm' | 'offscreen' | 'none';
  /** Named alarm handlers: key = alarm name, value = JS expression for a function. */
  namedAlarmHandlers?: Record<string, string>;
  /**
   * Mutation-tracking strategy:
   * - 'static'  → AST-based: injects `__mv3_markDirty()` after assignment
   *               expressions detected at build time. Fast, zero runtime
   *               overhead, but cannot track mutations through references
   *               (e.g. `const ref = myObj; ref.prop = 2`), or mutations
   *               via Map.set(), Set.add(), Date.setHours() etc.
   * - 'proxy'   → Runtime: wraps each persistent object/array variable in a
   *               `Proxy` that intercepts `set`/`deleteProperty` traps and
   *               auto-calls `__mv3_markDirty()`. Also handles Map, Set,
   *               Date via method overriding. Covers hidden mutations via
   *               reference passing, nested objects, and array index writes.
   *               Adds ~0.1 µs overhead per write. Primitive variables
   *               (boolean, number, string) still use static tracking since
   *               Proxy traps don't fire on reassignment of the variable.
   */
  stateStrategy?: 'static' | 'proxy';
  /**
   * Variable names that should NOT be flagged as closure variables even
   * when they're captured from intermediate scopes. Use this for known
   * singletons or re-creatable resources (e.g. database connections).
   */
  safeClosureVars?: string[];
  /**
   * Time threshold (ms) for stale-lock recovery. If a boolean persistent
   * variable is `true` on SW restart but has no active alarm AND the lock
   * was set more than this many ms ago, it's considered stale and cleared.
   * Default: 30 000 (30 seconds). Set to 0 to always clear on restart.
   */
  staleLockThresholdMs?: number;
  /**
   * Strategy for handling setTimeout calls inside Promise executors
   * (e.g. `new Promise(resolve => setTimeout(resolve, delay))`).
   *
   * - 'native'  → (default) Keep using native setTimeout for precise
   *               timing. Build-time warning emitted. On SW restart,
   *               pending promise timers detected and console warning emitted.
   * - 'alarm'   → Convert promise-resolver timers to chrome.alarms.
   *               NOTE: this does NOT make the Promise survive restarts —
   *               the `resolve` callback is anonymous and cannot be persisted.
   *               The alarm fires but with no callback, it is a no-op.
   *               Primarily useful for proper alarm cleanup on restart.
   *               chrome.alarms has a minimum delay of ~30 seconds in
   *               production Chrome.
   */
  promiseResolverStrategy?: 'native' | 'alarm';
}

// ═══════════════════════════════════════════════════════════════════════
// § Internal Resolved Options
// ═══════════════════════════════════════════════════════════════════════

export interface ResolvedOptions {
  backgroundEntry: string | RegExp;
  persistentVars: Set<string>;
  excludeVars: Set<string>;
  alarmThresholdMs: number;
  storageArea: 'session' | 'local';
  autoFlushMs: number;
  keepaliveStrategy: 'alarm' | 'offscreen' | 'none';
  namedAlarmHandlers: Record<string, string>;
  stateStrategy: 'static' | 'proxy';
  safeClosureVars: Set<string>;
  staleLockThresholdMs: number;
  promiseResolverStrategy: 'native' | 'alarm';
}

export const DEFAULTS: Omit<ResolvedOptions, 'excludeVars' | 'persistentVars' | 'safeClosureVars'> = {
  backgroundEntry: /background[\\/]index\.ts$/,
  alarmThresholdMs: 60_000,
  storageArea: 'session',
  autoFlushMs: 2_000,
  keepaliveStrategy: 'alarm',
  namedAlarmHandlers: {},
  stateStrategy: 'static',
  staleLockThresholdMs: 30_000,
  promiseResolverStrategy: 'native',
};

// ═══════════════════════════════════════════════════════════════════════
// § Analysis Result Types
// ═══════════════════════════════════════════════════════════════════════

export interface TopVarInfo {
  name: string;
  defaultCode: string;
  isBoolean: boolean;
  isObject: boolean;
  collectionType?: 'map' | 'set' | 'date';
  start: number;
  end: number;
}

export interface TimerCallInfo {
  type: 'setTimeout' | 'setInterval';
  start: number;
  end: number;
  callbackNode: Babel.Node;
  callbackStart: number;
  callbackEnd: number;
  delayNode: Babel.Node;
  category: 'named-ref' | 'simple-wrapper' | 'complex-no-closure' | 'complex-with-closure' | 'promise-resolver';
  recoveryFnName: string | null;
  innerFnName: string | null;
  delayIsNumeric: boolean;
  delayValue: number | null;
}

export interface ClearTimerInfo {
  type: 'clearTimeout' | 'clearInterval';
  start: number;
  end: number;
  argCode: string;
}

export interface HandlerInfo {
  bodyStart: number;
  bodyEnd: number;
  isAsync: boolean;
  asyncInsertPos: number;
  isExpressionBody: boolean;
  /**
   * True if the handler returns a value (e.g. `return true` in onMessage
   * or `return {cancel:true}` in blocking webRequest). Making such handlers
   * async would break Chrome's message-channel and blocking-listener contracts.
   */
  hasReturnValue: boolean;
}

export interface AssignmentInfo {
  varName: string;
  stmtEnd: number;
  stmtStart: number;
  /**
   * True when the statement is a bare body of if/else/for/while/etc.
   * without braces — e.g. `if (cond) obj.x=1;`. Injecting markDirty
   * after stmtEnd would place it outside the control flow, so the
   * statement must be wrapped in braces first.
   */
  needsBracing: boolean;
  /**
   * True when the entire variable is reassigned (e.g. `obj = {...}`),
   * false for property mutations (`obj.prop = 5`) or method calls
   * (`obj.push(x)`). In proxy mode, only full reassignments need
   * `__mv3_reactive` re-wrapping — property mutations are already
   * caught by the Proxy's set trap.
   */
  isFullReassignment: boolean;
}

export interface FunctionDeclInfo {
  name: string;
  boundCode?: string;
}

export interface AnalysisResult {
  topVars: TopVarInfo[];
  timerCalls: TimerCallInfo[];
  clearTimerCalls: ClearTimerInfo[];
  handlers: HandlerInfo[];
  assignments: AssignmentInfo[];
  functionDecls: FunctionDeclInfo[];
  topLevelBindings: Set<string>;
  ast: Babel.File;
}

// ═══════════════════════════════════════════════════════════════════════
// § Virtual Module Constants
// ═══════════════════════════════════════════════════════════════════════

export const VIRTUAL_MODULE_ID = 'virtual:mv3-persistent-runtime';
export const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_MODULE_ID + '.ts';

// ═══════════════════════════════════════════════════════════════════════
// § Well-Known Globals
// ═══════════════════════════════════════════════════════════════════════

export const WELL_KNOWN_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'console', 'Math', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'fetch', 'Request', 'Response', 'URL',
  'globalThis', 'window', 'self', 'document', 'navigator',
  // Cross-browser extension APIs
  'chrome', 'browser', 'Browser',
]);

export function isGlobal(name: string): boolean {
  return WELL_KNOWN_GLOBALS.has(name);
}
