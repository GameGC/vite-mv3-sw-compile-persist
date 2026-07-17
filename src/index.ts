/**
 * vite-plugin-mv3-persistent  v7.1
 *
 * Plugin entry: exports the main `mv3Persistent` Vite plugin function
 * with resolveId, load, and transform hooks.
 */

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

// ═══════════════════════════════════════════════════════════════════════
// § mv3Persistent
// ═══════════════════════════════════════════════════════════════════════

/**
 * AST-based Vite plugin that transforms a Chrome Extension MV3 background
 * service worker so that:
 *
 *   1. Top-level `let`/`var` variables survive service-worker restarts via
 *      chrome.storage.session (or .local) with automatic dirty-tracking.
 *   2. Long setTimeout / setInterval calls are replaced with chrome.alarms
 *      so they persist across SW termination.
 *   3. Timer callbacks are persisted through a function-registry so they
 *      survive SW restarts — no more lost anonymous closures.
 *   4. Event-handler callbacks are injected with `await __mv3_init` and
 *      made `async` when necessary, guaranteeing restored state is available.
 *   5. Assignments to persistent variables automatically trigger
 *      `__mv3_markDirty()` — no manual calls required.
 *
 * ── Usage ───────────────────────────────────────────────────────────
 * // vite.config.ts
 * import { mv3Persistent } from 'vite-plugin-mv3-persistent';
 * export default defineConfig({
 *   plugins: [
 *     mv3Persistent({
 *       backgroundEntry: /background[\\/]index\.ts$/,
 *       alarmThresholdMs: 60_000,
 *       storageArea: 'session',
 *       stateStrategy: 'proxy',
 *     }),
 *   ],
 * });
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
      `[vite-plugin-mv3-persistent] ⚠️ keepaliveStrategy is 'offscreen'. ` +
      `Make sure your manifest.json includes the 'offscreen' permission, e.g.:\n` +
      `  "permissions": ["offscreen"]\n` +
      `Chrome Web Store moderation may ask you to justify this permission. ` +
      `The plugin auto-generates the justification string 'Keep service worker ` +
      `alive for pending background timers'.\n` +
      `⚠️ Chrome allows only ONE offscreen document per extension. If your ` +
      `extension uses chrome.offscreen for other purposes (DOM parsing, audio, ` +
      `clipboard), the plugin will NOT close a document it didn't create.`,
    );
  }

  return {
    name: 'vite-plugin-mv3-persistent',
    version: '7.1',
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
        return `// mv3-persistent-runtime: not yet generated`;
      }
    },

    transform(code, id) {
      // Strip Vite's HMR query strings (?t=... / ?v=...) before matching
      const cleanId = id.replace(/\?.*$/, '');
      const isMatch =
        typeof opts.backgroundEntry === 'string'
          ? cleanId.includes(opts.backgroundEntry)
          : opts.backgroundEntry.test(cleanId);

      if (!isMatch) return null;

      try {
        return applyTransform(code, opts, (virtualCode) => {
          _virtualRuntimeCode = virtualCode;
        });
      } catch (err) {
        this.error(
          `[vite-plugin-mv3-persistent] Transform failed for ${id}: ${err}`,
        );
      }
    },
  };
}

// Re-export types for consumer convenience
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
