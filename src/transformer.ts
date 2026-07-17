/**
 * vite-plugin-mv3-persistent  v7.1
 *
 * Code transformation: modifies the user's background service worker
 * source using MagicString — injects imports, adapter code, and
 * replaces timer calls and injects dirty-tracking.
 */

import MagicString from 'magic-string';
import type * as Babel from '@babel/types';

import type {
  ResolvedOptions,
  AnalysisResult,
  TopVarInfo,
} from './types.js';

import { analyze } from './analyzer.js';
import { buildVirtualRuntime } from './runtime/virtual-module.js';
import { buildAdapterBlock } from './runtime/adapter.js';

// ═══════════════════════════════════════════════════════════════════════
// § findInsertPosition
// ═══════════════════════════════════════════════════════════════════════

const DECL_TYPES = new Set([
  'VariableDeclaration',
  'FunctionDeclaration',
  'ImportDeclaration',
  'ClassDeclaration',
  'TSDeclareFunction',
  'TSEnumDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSModuleDeclaration',
]);

export function findInsertPosition(topVars: TopVarInfo[], ast: Babel.File): number {
  if (topVars.length === 0) return 0;

  let lastDeclEnd = 0;
  for (const node of ast.program.body) {
    if (DECL_TYPES.has(node.type)) {
      if (node.end! > lastDeclEnd) {
        lastDeclEnd = node.end!;
      }
    }
  }

  if (lastDeclEnd > 0) return lastDeclEnd;

  const lastVar = topVars[topVars.length - 1];
  return lastVar.end;
}

// ═══════════════════════════════════════════════════════════════════════
// § applyTransform
// ═══════════════════════════════════════════════════════════════════════

/**
 * Transforms the user's background.ts:
 * 1. Generates virtual runtime module content (stored via setVirtualRuntime callback)
 * 2. Generates thin adapter code injected into the user's background.ts
 */
export function applyTransform(
  code: string,
  opts: ResolvedOptions,
  setVirtualRuntime: (code: string) => void,
) {
  const analysis = analyze(code, opts);
  const s = new MagicString(code);

  // Generate virtual runtime module + adapter code
  const virtualRuntimeCode = buildVirtualRuntime(analysis, opts);
  setVirtualRuntime(virtualRuntimeCode);

  const adapterBlock = buildAdapterBlock(analysis, opts);

  // Add import at the top of the file
  s.prepend(`import { createMV3Runtime } from 'virtual:mv3-persistent-runtime';\n`);

  // Insert adapter code after all top-level declarations
  const insertPos = findInsertPosition(analysis.topVars, analysis.ast);
  s.appendRight(insertPos, adapterBlock);

  // Inject `await __mv3_init` + `async` in event handlers
  // IMPORTANT: handlers that return a value (e.g. onMessage return-true,
  // blocking webRequest) must NOT be made async — Chrome requires a
  // synchronous return value. We skip them entirely.
  for (const handler of analysis.handlers) {
    if (handler.hasReturnValue) {
      // Making this handler async would break Chrome's onMessage return-true
      // pattern or blocking webRequest listeners. Skip modification.
      continue;
    }

    if (!handler.isAsync) {
      s.appendLeft(handler.asyncInsertPos, 'async ');
    }
    if (handler.isExpressionBody) {
      const exprCode = code.slice(handler.bodyStart, handler.bodyEnd);
      s.overwrite(handler.bodyStart, handler.bodyEnd, `{ await __mv3_init; return ${exprCode}; }`);
    } else {
      s.appendRight(handler.bodyStart, '\nawait __mv3_init;');
    }
  }

  // Replace setTimeout/setInterval calls
  const sortedTimers = [...analysis.timerCalls].sort(
    (a, b) => b.start - a.start,
  );

  for (const tc of sortedTimers) {
    const wrapper =
      tc.type === 'setTimeout' ? '__mv3_setTimeout' : '__mv3_setInterval';

    if (tc.category === 'promise-resolver') {
      console.warn(
        `[vite-plugin-mv3-persistent] ⚠️ Promise-resolver timer detected at pos ${tc.start}: ` +
        `new Promise(resolve => ${tc.type}(resolve, ...)). ` +
        `If the SW dies during this timer, the Promise will never resolve. ` +
        `Current strategy: '${opts.promiseResolverStrategy}'. ` +
        (opts.promiseResolverStrategy === 'native'
          ? `Consider 'promiseResolverStrategy: "alarm"' if timing inaccuracy is acceptable, ` +
            `or use 'keepaliveStrategy: "offscreen"' to keep SW alive.`
          : `Timer will be converted to chrome.alarms (~30 s minimum delay in production).`),
      );

      if (opts.promiseResolverStrategy === 'alarm') {
        // Fall through to normal conversion logic
      } else {
        // Use the dedicated __mv3_setTimeoutPromise / __mv3_setIntervalPromise
        // wrapper that tracks the timer for SW-restart detection, so that only
        // actual promise-resolver timers produce the "Unresolved Promise" warning.
        const fullCall = code.slice(tc.start, tc.end);
        const promiseWrapper =
          tc.type === 'setTimeout' ? '__mv3_setTimeoutPromise' : '__mv3_setIntervalPromise';
        const newCall = fullCall.replace(
          new RegExp(`\\b${tc.type}\\s*\\(`),
          promiseWrapper + '(',
        );
        s.overwrite(tc.start, tc.end, newCall);
        continue;
      }
    }

    if (tc.category === 'simple-wrapper' && tc.innerFnName) {
      const delayCode = code.slice(tc.delayNode.start!, tc.delayNode.end!);
      const newCall = `${wrapper}(${tc.innerFnName}, ${delayCode})`;
      s.overwrite(tc.start, tc.end, newCall);
    } else if (tc.category === 'named-ref') {
      const fullCall = code.slice(tc.start, tc.end);
      const newCall = fullCall.replace(
        new RegExp(`\\b${tc.type}\\s*\\(`),
        wrapper + '(',
      );
      s.overwrite(tc.start, tc.end, newCall);
    } else {
      const fullCall = code.slice(tc.start, tc.end);
      const newCall = fullCall.replace(
        new RegExp(`\\b${tc.type}\\s*\\(`),
        wrapper + '(',
      );
      s.overwrite(tc.start, tc.end, newCall);

      if (tc.category === 'complex-with-closure' && tc.recoveryFnName) {
        console.warn(
          `[vite-plugin-mv3-persistent] ⚠️ Timer callback at pos ${tc.start} captures closure variables. ` +
          `Recovery action after SW restart: ${tc.recoveryFnName}(). ` +
          `The full callback logic may not be preserved. Consider using namedAlarmHandlers.`,
        );
      }
    }
  }

  // Replace clearTimeout / clearInterval
  const sortedClears = [...analysis.clearTimerCalls].sort(
    (a, b) => b.start - a.start,
  );
  for (const ct of sortedClears) {
    const fnName =
      ct.type === 'clearTimeout'
        ? '__mv3_clearTimeout'
        : '__mv3_clearInterval';
    s.overwrite(ct.start, ct.end, `${fnName}(${ct.argCode})`);
  }

  // Inject __mv3_markDirty after assignments/mutations
  // Group assignments by stmtEnd so that bracing (for bare if/else bodies)
  // is applied once per statement, and all markDirty calls are inside.
  const sortedAssignments = [...analysis.assignments]
    .sort((a, b) => b.stmtEnd - a.stmtEnd);

  const objectVarNames = new Set(
    analysis.topVars.filter((v) => v.isObject).map((v) => v.name),
  );

  // Group by stmtEnd to apply bracing once per statement
  const stmtEndGroups = new Map<number, typeof sortedAssignments>();
  for (const asgn of sortedAssignments) {
    const group = stmtEndGroups.get(asgn.stmtEnd) || [];
    group.push(asgn);
    stmtEndGroups.set(asgn.stmtEnd, group);
  }

  const sortedGroups = [...stmtEndGroups.entries()].sort((a, b) => b[0] - a[0]);

  for (const [stmtEnd, group] of sortedGroups) {
    const charBefore = code[stmtEnd - 1];
    const sep = charBefore === ';' || charBefore === '}' ? '' : ';';
    const firstAsgn = group[0];
    const needsBracing = firstAsgn.needsBracing;

    // Build all markDirty + reactive re-wrap code for this statement
    let injection = '';
    for (const asgn of group) {
      const isProxyObject = opts.stateStrategy === 'proxy' && objectVarNames.has(asgn.varName);
      if (isProxyObject && asgn.isFullReassignment) {
        // Proxy mode: only FULL reassignment (obj = {...}) needs __mv3_reactive
        // re-wrapping. Property mutations (obj.prop = 5) and method calls
        // (obj.push(x)) are already caught by the Proxy's set trap.
        injection += ` ${asgn.varName} = __mv3_reactive(${asgn.varName}, '${asgn.varName}');`;
      }
      injection += ` __mv3_markDirty('${asgn.varName}');`;
    }

    if (needsBracing) {
      // Bare statement in if/else/for/while — wrap in braces so
      // markDirty stays inside the control flow.
      // Before: if (cond) obj.x=1;
      // After:  if (cond) { obj.x=1; __mv3_markDirty('obj'); }
      s.appendLeft(firstAsgn.stmtStart, '{ ');
      s.appendRight(stmtEnd, `${sep}${injection} }`);
    } else {
      s.appendRight(stmtEnd, `${sep}${injection}`);
    }
  }

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
}
