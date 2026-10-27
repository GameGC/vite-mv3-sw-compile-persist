import type * as Babel from '@babel/types';

// --- Public Options ---

export interface MV3PersistentOptions {
  backgroundEntry?: string | RegExp;
  persistentVars?: string[];
  excludeVars?: string[];
  alarmThresholdMs?: number;
  storageArea?: 'session' | 'local';
  autoFlushMs?: number;
  /** Keepalive for timers below alarmThreshold: 'alarm' | 'offscreen' | 'none' */
  keepaliveStrategy?: 'alarm' | 'offscreen' | 'none';
  namedAlarmHandlers?: Record<string, string>;
  /** 'static' = AST-injected markDirty; 'proxy' = runtime Proxy traps */
  stateStrategy?: 'static' | 'proxy';
  safeClosureVars?: string[];
  staleLockThresholdMs?: number;
  /** How to handle setTimeout inside Promise executors: 'native' | 'alarm' */
  promiseResolverStrategy?: 'native' | 'alarm';
}

// --- Internal Resolved Options ---

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

// --- Analysis Result Types ---

export interface TopVarInfo {
  name: string;
  defaultCode: string;
  isBoolean: boolean;
  isObject: boolean;
  collectionType?: 'map' | 'set' | 'date' | 'array';
  start: number;
  end: number;
  stmtEnd?: number;
}

export interface TimerCallInfo {
  type: 'setTimeout' | 'setInterval';
  start: number;
  end: number;
  calleeEnd?: number;
  callbackNode: Babel.Node;
  callbackStart: number;
  callbackEnd: number;
  delayNode: Babel.Node;
  category: 'named-ref' | 'simple-wrapper' | 'complex-no-closure' | 'complex-with-closure' | 'promise-resolver';
  recoveryFnName: string | null;
  innerFnName: string | null;
  delayIsNumeric: boolean;
  delayValue: number | null;
  isAlarm?: boolean;
}

export interface ClearTimerInfo {
  type: 'clearTimeout' | 'clearInterval';
  start: number;
  end: number;
  argCode: string;
}

export interface ClearAllInfo {
  start: number;
  end: number;
}

export interface HandlerInfo {
  bodyStart: number;
  bodyEnd: number;
  isAsync: boolean;
  asyncInsertPos: number;
  isExpressionBody: boolean;
  /** True when handler returns a value — must not be made async (breaks onMessage return-true). */
  hasReturnValue: boolean;
  asyncIIFEs?: Array<{
    bodyStart: number;
    bodyEnd: number;
    isExpressionBody: boolean;
  }>;
}

export interface AssignmentInfo {
  varName: string;
  stmtEnd: number;
  stmtStart: number;
  /** Bare body of if/else/for/while without braces — needs wrapping before injecting markDirty. */
  needsBracing: boolean;
  /** obj = {...} (true) vs obj.prop = 5 / obj.push(x) (false). */
  isFullReassignment: boolean;
  /** Mutation inside return/throw statement or loop/branch header with early return/throw. */
  isReturnOrThrow?: boolean;
  /** Mutation is the direct expression body of an ArrowFunctionExpression. */
  isArrowExprBody?: boolean;
}

export interface FunctionDeclInfo {
  name: string;
  boundCode?: string;
  end?: number;
  isHoisted?: boolean;
}

export interface AnalysisResult {
  topVars: TopVarInfo[];
  timerCalls: TimerCallInfo[];
  clearTimerCalls: ClearTimerInfo[];
  clearAllCalls: ClearAllInfo[];
  handlers: HandlerInfo[];
  assignments: AssignmentInfo[];
  functionDecls: FunctionDeclInfo[];
  topLevelBindings: Set<string>;
  ast: Babel.File;
}

// --- Virtual Module ---

export const VIRTUAL_MODULE_ID = 'virtual:mv3-persist-runtime';
export const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_MODULE_ID + '.ts';

// --- Well-Known Globals ---

export const WELL_KNOWN_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'console', 'Math', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'fetch', 'Request', 'Response', 'URL',
  'globalThis', 'window', 'self', 'document', 'navigator',
  'chrome', 'browser', 'Browser',
]);

export function isGlobal(name: string): boolean {
  return WELL_KNOWN_GLOBALS.has(name);
}
