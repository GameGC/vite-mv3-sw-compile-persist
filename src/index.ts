import type { Plugin } from 'vite';

import type {
  MV3PersistentOptions,
  ResolvedOptions,
} from './types.js';

import {
  DEFAULTS,
  VIRTUAL_MODULE_ID,
  RESOLVED_VIRTUAL_ID,
} from './types.js';

import { applyTransform } from './transformer.js';

/**
 * AST-based Vite plugin that transforms Chrome Extension MV3 background
 * service workers so that top-level variables survive SW restarts via
 * chrome.storage, long timers use chrome.alarms, and mutations are
 * automatically tracked.
 */
export function mv3Persistent(userOptions: MV3PersistentOptions = {}): Plugin {
  const opts: ResolvedOptions = {
    ...DEFAULTS,
    ...userOptions,
    persistentVars: new Set(userOptions.persistentVars ?? []),
    excludeVars: new Set(userOptions.excludeVars ?? []),
    safeClosureVars: new Set(userOptions.safeClosureVars ?? []),
  };

  let _virtualRuntimeCode: string | null = null;

  if (opts.keepaliveStrategy === 'offscreen') {
    console.warn(
      `[mv3-persist] keepaliveStrategy is 'offscreen'. ` +
      `Make sure your manifest.json includes the 'offscreen' permission. ` +
      `Chrome allows only one offscreen document per extension; the plugin ` +
      `will not close one it didn't create.`
    );
  }

  return {
    name: 'vite-plugin-mv3-persist',
    enforce: 'pre',

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_ID;
      }
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_ID) {
        if (_virtualRuntimeCode) {
          return _virtualRuntimeCode;
        }
        return `// mv3-persist-runtime: not yet generated`;
      }
    },

    transform(code, id) {
      const cleanId = id.split('?')[0].replace(/\\/g, '/');
      const normalizedEntry =
        typeof opts.backgroundEntry === 'string'
          ? opts.backgroundEntry.replace(/\\/g, '/')
          : opts.backgroundEntry;
      const isMatch =
        typeof normalizedEntry === 'string'
          ? cleanId.includes(normalizedEntry) || cleanId.includes(normalizedEntry.replace(/^\.\//, ''))
          : normalizedEntry.test(cleanId);

      if (!isMatch) return null;

      try {
        return applyTransform(code, opts, (virtualCode) => {
          _virtualRuntimeCode = virtualCode;
        });
      } catch (err) {
        this.error(
          `[mv3-persistent] Transform failed for ${id}: ${err}`,
        );
      }
    },
  };
}

export type {
  MV3PersistentOptions,
  ResolvedOptions,
  AnalysisResult,
  TopVarInfo,
  TimerCallInfo,
  ClearTimerInfo,
  HandlerInfo,
  AssignmentInfo,
  FunctionDeclInfo,
} from './types.js';
