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

// --- findInsertPosition ---

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

// --- applyTransform ---

export function applyTransform(
  code: string,
  opts: ResolvedOptions,
  setVirtualRuntime: (code: string) => void,
) {
  const analysis = analyze(code, opts);
  const s = new MagicString(code);

  const virtualRuntimeCode = buildVirtualRuntime(analysis, opts);
  setVirtualRuntime(virtualRuntimeCode);

  const adapterBlock = buildAdapterBlock(analysis, opts);

  s.prepend(`import { createMV3Runtime } from 'virtual:mv3-persist-runtime';\n`);

  const insertPos = findInsertPosition(analysis.topVars, analysis.ast);
  s.appendRight(insertPos, adapterBlock);

  // Inject await __mv3_init + async in event handlers.
  // Handlers with return values (onMessage return-true, blocking webRequest) must NOT be made async.
  for (const handler of analysis.handlers) {
    if (handler.isAsync) {
      if (handler.isExpressionBody) {
        const exprCode = code.slice(handler.bodyStart, handler.bodyEnd);
        s.overwrite(handler.bodyStart, handler.bodyEnd, `{ await __mv3_init; return ${exprCode}; }`);
      } else {
        s.appendRight(handler.bodyStart, '\nawait __mv3_init;');
      }
    } else if (!handler.hasReturnValue) {
      s.appendLeft(handler.asyncInsertPos, 'async ');
      if (handler.isExpressionBody) {
        const exprCode = code.slice(handler.bodyStart, handler.bodyEnd);
        s.overwrite(handler.bodyStart, handler.bodyEnd, `{ await __mv3_init; return ${exprCode}; }`);
      } else {
        s.appendRight(handler.bodyStart, '\nawait __mv3_init;');
      }
    } else {
      // Sync handler with return value (e.g. onMessage return true).
      // Preserve synchronous return, but inject await __mv3_init into any inner async IIFEs.
      if (handler.asyncIIFEs && handler.asyncIIFEs.length > 0) {
        for (const iife of handler.asyncIIFEs) {
          if (iife.isExpressionBody) {
            const exprCode = code.slice(iife.bodyStart, iife.bodyEnd);
            s.overwrite(iife.bodyStart, iife.bodyEnd, `{ await __mv3_init; return ${exprCode}; }`);
          } else {
            s.appendRight(iife.bodyStart, '\nawait __mv3_init;');
          }
        }
      }
    }
  }

  // Replace chrome.alarms.clearAll() / browser.alarms.clearAll() / Browser.alarms.clearAll()
  const sortedClearAlls = [...(analysis.clearAllCalls || [])].sort(
    (a, b) => b.start - a.start,
  );
  for (const ca of sortedClearAlls) {
    s.overwrite(ca.start, ca.end, '__mv3_clearAllAlarms()');
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
        `[mv3-persist] Promise-resolver timer at pos ${tc.start}: ` +
        `new Promise(resolve => ${tc.type}(resolve, ...)). ` +
        `If the SW dies, the Promise will never resolve. ` +
        `Strategy: '${opts.promiseResolverStrategy}'. ` +
        (opts.promiseResolverStrategy === 'native'
          ? `Consider promiseResolverStrategy: "alarm" or keepaliveStrategy: "offscreen".`
          : `Timer will be converted to chrome.alarms (~30s min delay in production).`),
      );

      if (opts.promiseResolverStrategy === 'alarm') {
        // fall through to normal conversion
      } else {
        const promiseWrapper =
          tc.type === 'setTimeout' ? '__mv3_setTimeoutPromise' : '__mv3_setIntervalPromise';
        s.overwrite(tc.start, tc.start + tc.type.length, promiseWrapper);
        continue;
      }
    }

    if (tc.category === 'simple-wrapper' && tc.innerFnName) {
      const delayCode = code.slice(tc.delayNode.start!, tc.delayNode.end!);
      const newCall = `${wrapper}(${tc.innerFnName}, ${delayCode})`;
      s.overwrite(tc.start, tc.end, newCall);
    } else {
      s.overwrite(tc.start, tc.start + tc.type.length, wrapper);

      if (tc.category === 'complex-with-closure' && tc.recoveryFnName) {
        console.warn(
          `[mv3-persist] Timer callback at pos ${tc.start} captures closure variables. ` +
          `Recovery action: ${tc.recoveryFnName}(). Consider namedAlarmHandlers.`,
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

  // Inject __mv3_markDirty after assignments/mutations.
  // Group by stmtEnd so bracing is applied once per statement.
  const sortedAssignments = [...analysis.assignments]
    .sort((a, b) => b.stmtEnd - a.stmtEnd);

  const objectVarNames = new Set(
    analysis.topVars.filter((v) => v.isObject).map((v) => v.name),
  );

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

    let injection = '';
    for (const asgn of group) {
      const isProxyObject = opts.stateStrategy === 'proxy' && objectVarNames.has(asgn.varName);
      if (isProxyObject && asgn.isFullReassignment) {
        injection += ` ${asgn.varName} = __mv3_reactive(${asgn.varName}, '${asgn.varName}');`;
      }
      injection += ` __mv3_markDirty('${asgn.varName}');`;
    }

    if (needsBracing) {
      // Wrap bare if/for/while body in braces so markDirty stays inside the branch.
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
