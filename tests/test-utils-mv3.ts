/**
 * Shared test utilities for vite-plugin-mv3-persistent tests.
 * Provides a transform() helper that captures BOTH the adapter code
 * (injected into the user's file) AND the virtual module content,
 * so that pattern-matching assertions work across the v7 architecture.
 */

import { mv3Persistent } from '../src/index.js';

let _passed = 0;
let _failed = 0;

export function resetCounters() {
  _passed = 0;
  _failed = 0;
}

export function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    _passed++;
  } else {
    console.log(`  ❌ ${label}`);
    _failed++;
  }
}

export function getResults() {
  return { passed: _passed, failed: _failed };
}

export function printResults() {
  console.log(`\n═══ Test Results: ${_passed} passed, ${_failed} failed ═══`);
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
  /** The transformed background.ts code (adapter + user code) */
  code: string;
  /** The virtual module content (runtime code) */
  virtualModule: string;
  /** Combined code + virtual module for pattern matching */
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

  const VIRTUAL_ID = '\0virtual:mv3-persistent-runtime.ts';

  // Create a proper plugin context mock
  const pluginContext = {
    error(msg: string) { throw new Error(msg); },
    warn(msg: string) { /* suppress */ },
  };

  // Call transform with proper this binding
  const result = plugin.transform!.call(pluginContext, code, '/background/index.ts');
  const transformedCode = result ? result.code : '';

  // Load the virtual module
  const loaded = plugin.load!.call(pluginContext, VIRTUAL_ID);
  const virtualModuleCode = typeof loaded === 'string' ? loaded : '';

  return {
    code: transformedCode,
    virtualModule: virtualModuleCode,
    combined: transformedCode + '\n' + virtualModuleCode,
  };
}
