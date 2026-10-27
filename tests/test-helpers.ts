/**
 * Shared test utilities for vite-plugin-mv3-persist.
 */

import ts from 'typescript';
import { mv3Persistent } from '../src/index.js';

let _passed = 0;
let _failed = 0;

export function resetCounters() {
  _passed = 0;
  _failed = 0;
}

export function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS ${label}`);
    _passed++;
  } else {
    console.log(`  FAIL ${label}`);
    _failed++;
  }
}

export function getResults() {
  return { passed: _passed, failed: _failed };
}

export function printResults() {
  console.log(`\nResults: ${_passed} passed, ${_failed} failed`);
  return _failed === 0;
}

interface TransformOptions {
  strategy?: 'static' | 'proxy';
  keepaliveStrategy?: 'alarm' | 'offscreen' | 'none';
  alarmThresholdMs?: number;
  storageArea?: 'session' | 'local';
  autoFlushMs?: number;
  staleLockThresholdMs?: number;
  promiseResolverStrategy?: 'native' | 'alarm';
  safeClosureVars?: string[];
  excludeVars?: string[];
  persistentVars?: string[];
  namedAlarmHandlers?: Record<string, string>;
}

export interface TransformResult {
  code: string;
  virtualModule: string;
  combined: string;
}

export function transform(code: string, options: TransformOptions = {}): TransformResult {
  const plugin = mv3Persistent({
    backgroundEntry: /.*/,
    alarmThresholdMs: options.alarmThresholdMs ?? 60_000,
    storageArea: options.storageArea ?? 'session',
    stateStrategy: options.strategy ?? 'static',
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
    error(msg: string) { throw new Error(msg); },
    warn(msg: string) { /* suppress */ },
  };

  const result = plugin.transform!.call(pluginContext, code, '/background/index.ts');
  const transformedCode = result ? result.code : '';

  const loaded = plugin.load!.call(pluginContext, VIRTUAL_ID);
  const virtualModuleCode = typeof loaded === 'string' ? loaded : '';

  return {
    code: transformedCode,
    virtualModule: virtualModuleCode,
    combined: transformedCode + '\n' + virtualModuleCode,
  };
}

export function compileTestBundle(sourceCode: string, options: TransformOptions = {}): string {
  const { code, virtualModule } = transform(sourceCode, {
    strategy: 'proxy',
    alarmThresholdMs: 60_000,
    staleLockThresholdMs: 30_000,
    autoFlushMs: 50,
    ...options,
  });

  const inlinedRuntime = virtualModule.replace(
    'export function createMV3Runtime',
    'function createMV3Runtime',
  );

  const bundle = code.replace(
    /import\s*\{\s*createMV3Runtime\s*\}\s*from\s*['"]virtual:mv3-persist-runtime['"];?/,
    inlinedRuntime,
  );

  const jsBundle = ts.transpileModule(bundle, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;

  return jsBundle;
}

