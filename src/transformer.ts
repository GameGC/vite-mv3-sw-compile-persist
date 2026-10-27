import MagicString from 'magic-string';
import type * as Babel from '@babel/types';

import type {
  ResolvedOptions,
  AnalysisResult,
  TopVarInfo,
} from './types.js';

import { analyze, unwrapTopLevelNode, unwrapExpression } from './analyzer.js';
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
  'ExportAllDeclaration',
]);

function hasImpureTopLevelCall(node: Babel.Node): boolean {
  let impure = false;
  function walk(n: Babel.Node | null | undefined) {
    if (!n || impure) return;
    if (
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression' ||
      n.type === 'FunctionDeclaration' ||
      n.type === 'ClassExpression' ||
      n.type === 'ClassDeclaration'
    ) {
      return;
    }
    if (n.type === 'CallExpression') {
      const callee = unwrapExpression(n.callee) || n.callee;
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'bind'
      ) {
        // .bind() is pure
      } else if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.property.type === 'Identifier' &&
        ((callee.object.name === 'Object' &&
          ['create', 'assign', 'fromEntries', 'keys', 'values', 'entries', 'freeze'].includes(callee.property.name)) ||
          (callee.object.name === 'Array' && ['from', 'of', 'isArray'].includes(callee.property.name)) ||
          callee.object.name === 'Math')
      ) {
        // Pure built-in factory/math call
      } else if (
        callee.type === 'Identifier' &&
        ['Boolean', 'Number', 'String', 'Symbol', 'BigInt', 'RegExp'].includes(callee.name)
      ) {
        // Pure primitive conversion
      } else {
        impure = true;
        return;
      }
    }
    for (const key of Object.keys(n)) {
      const val = (n as any)[key];
      if (val && typeof val === 'object' && typeof val.type === 'string') {
        walk(val);
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && typeof item.type === 'string') {
            walk(item);
          }
        }
      }
    }
  }
  walk(node);
  return impure;
}

export function findInsertPosition(topVars: TopVarInfo[], ast: Babel.File): number {
  if (topVars.length === 0) return 0;

  let lastDeclEnd = 0;
  for (const rawNode of ast.program.body) {
    const node = unwrapTopLevelNode(rawNode);
    const isPureExport =
      (rawNode.type === 'ExportNamedDeclaration' && !rawNode.declaration) ||
      rawNode.type === 'ExportAllDeclaration';

    if (isPureExport) {
      if (rawNode.end! > lastDeclEnd) {
        lastDeclEnd = rawNode.end!;
      }
      continue;
    }

    if (DECL_TYPES.has(node.type)) {
      if (node.type === 'VariableDeclaration' && hasImpureTopLevelCall(node)) {
        // Stop before a VariableDeclaration whose initializer executes an impure function call
        // (e.g., const init = helper(); or const t = setTimeout(...);)
        break;
      }
      if (rawNode.end! > lastDeclEnd) {
        lastDeclEnd = rawNode.end!;
      }
    } else {
      // Stop advancing when we encounter the first top-level executable statement
      // so __mv3_* runtime bindings are initialized before any top-level code executes.
      break;
    }
  }

  if (lastDeclEnd > 0) return lastDeclEnd;

  const firstVar = topVars[0];
  return firstVar.stmtEnd ?? firstVar.end;
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

  const insertPos = findInsertPosition(analysis.topVars, analysis.ast);
  const adapterBlock = buildAdapterBlock(analysis, opts, insertPos);

  s.prepend(`import { createMV3Runtime } from 'virtual:mv3-persist-runtime';\n`);

  s.appendRight(insertPos, adapterBlock);

  // Register any non-hoisted function declarations (const fn = () => ..., const bound = x.bind(y))
  // that appear after insertPos right after their declaration to avoid TDZ ReferenceError.
  for (const fnDecl of analysis.functionDecls) {
    if (fnDecl.isHoisted === false && fnDecl.end !== undefined && fnDecl.end > insertPos) {
      const regCode = fnDecl.boundCode
        ? `__mv3_registerFn('${fnDecl.name}', ${fnDecl.boundCode});`
        : `__mv3_registerFn('${fnDecl.name}', ${fnDecl.name});`;
      s.appendRight(fnDecl.end, `\n${regCode}`);
    }
  }

  // Wrap any object persistent variables declared after insertPos in __mv3_reactive right after their declaration.
  if (opts.stateStrategy === 'proxy') {
    for (const v of analysis.topVars) {
      const varStmtEnd = v.stmtEnd ?? v.end;
      if (v.isObject && varStmtEnd > insertPos) {
        s.appendRight(varStmtEnd, `\n${v.name} = __mv3_reactive(${v.name}, '${v.name}');`);
      }
    }
  }

  // Track expression-body arrow functions that have state mutations so handler wrapping and markDirty wrapping compose cleanly.
  const arrowExprBodySpans = new Set<string>();
  for (const asgn of analysis.assignments) {
    if (asgn.isArrowExprBody) {
      arrowExprBodySpans.add(`${asgn.stmtStart}:${asgn.stmtEnd}`);
    }
  }
  const handlerExprBodySpans = new Set<string>();

  // Inject await __mv3_init + async in event handlers.
  // Handlers with return values (onMessage return-true, blocking webRequest) must NOT be made async.
  for (const handler of analysis.handlers) {
    if (handler.isAsync) {
      if (handler.isExpressionBody) {
        const spanKey = `${handler.bodyStart}:${handler.bodyEnd}`;
        handlerExprBodySpans.add(spanKey);
        if (arrowExprBodySpans.has(spanKey)) {
          s.appendLeft(handler.bodyStart, '{ await __mv3_init; ');
        } else {
          s.appendLeft(handler.bodyStart, '{ await __mv3_init; return ');
          s.appendRight(handler.bodyEnd, '; }');
        }
      } else {
        s.appendRight(handler.bodyStart, '\nawait __mv3_init;');
      }
    } else if (!handler.hasReturnValue) {
      s.appendLeft(handler.asyncInsertPos, 'async ');
      if (handler.isExpressionBody) {
        const spanKey = `${handler.bodyStart}:${handler.bodyEnd}`;
        handlerExprBodySpans.add(spanKey);
        if (arrowExprBodySpans.has(spanKey)) {
          s.appendLeft(handler.bodyStart, '{ await __mv3_init; ');
        } else {
          s.appendLeft(handler.bodyStart, '{ await __mv3_init; return ');
          s.appendRight(handler.bodyEnd, '; }');
        }
      } else {
        s.appendRight(handler.bodyStart, '\nawait __mv3_init;');
      }
    } else {
      // Sync handler with return value (e.g. onMessage return true).
      // Preserve synchronous return, but inject await __mv3_init into any inner async IIFEs.
      if (handler.asyncIIFEs && handler.asyncIIFEs.length > 0) {
        for (const iife of handler.asyncIIFEs) {
          if (iife.isExpressionBody) {
            const spanKey = `${iife.bodyStart}:${iife.bodyEnd}`;
            handlerExprBodySpans.add(spanKey);
            if (arrowExprBodySpans.has(spanKey)) {
              s.appendLeft(iife.bodyStart, '{ await __mv3_init; ');
            } else {
              s.appendLeft(iife.bodyStart, '{ await __mv3_init; return ');
              s.appendRight(iife.bodyEnd, '; }');
            }
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
    const calleeEnd = tc.calleeEnd ?? (tc.start + tc.type.length);

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
        s.overwrite(tc.start, calleeEnd, promiseWrapper);
        continue;
      }
    }

    if (tc.category === 'simple-wrapper' && tc.innerFnName) {
      const delayCode = code.slice(tc.delayNode.start!, tc.delayNode.end!);
      const newCall = `${wrapper}(${tc.innerFnName}, ${delayCode})`;
      s.overwrite(tc.start, tc.end, newCall);
    } else {
      s.overwrite(tc.start, calleeEnd, wrapper);

      if (tc.recoveryFnName && tc.category !== 'named-ref') {
        s.appendLeft(tc.delayNode.end!, `, '${tc.recoveryFnName}'`);
      }

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
  // Group by full statement identity so outer constructs and inner bare bodies sharing stmtEnd do not collide.
  const sortedAssignments = [...analysis.assignments]
    .sort((a, b) => b.stmtEnd - a.stmtEnd || b.stmtStart - a.stmtStart);

  const objectVarNames = new Set(
    analysis.topVars.filter((v) => v.isObject).map((v) => v.name),
  );

  const stmtGroups = new Map<string, typeof sortedAssignments>();
  for (const asgn of sortedAssignments) {
    const key = `${asgn.stmtStart}:${asgn.stmtEnd}:${asgn.needsBracing}:${Boolean(asgn.isReturnOrThrow)}:${Boolean(asgn.isArrowExprBody)}`;
    const group = stmtGroups.get(key) || [];
    group.push(asgn);
    stmtGroups.set(key, group);
  }

  const sortedGroups = [...stmtGroups.values()].sort(
    (a, b) => b[0].stmtEnd - a[0].stmtEnd || b[0].stmtStart - a[0].stmtStart,
  );

  for (const group of sortedGroups) {
    const firstAsgn = group[0];
    const stmtEnd = firstAsgn.stmtEnd;
    const charBefore = code[stmtEnd - 1];
    const sep = charBefore === ';' || charBefore === '}' ? '' : ';';
    const needsBracing = firstAsgn.needsBracing;

    let injection = '';
    for (const asgn of group) {
      const isProxyObject = opts.stateStrategy === 'proxy' && objectVarNames.has(asgn.varName);
      if (isProxyObject && asgn.isFullReassignment) {
        injection += ` ${asgn.varName} = __mv3_reactive(${asgn.varName}, '${asgn.varName}');`;
      }
      injection += ` __mv3_markDirty('${asgn.varName}');`;
    }

    if (firstAsgn.isArrowExprBody) {
      const spanKey = `${firstAsgn.stmtStart}:${stmtEnd}`;
      if (handlerExprBodySpans.has(spanKey)) {
        s.appendLeft(firstAsgn.stmtStart, 'try { return ');
        s.appendRight(stmtEnd, `; } finally {${injection} } }`);
      } else {
        s.appendLeft(firstAsgn.stmtStart, '{ try { return ');
        s.appendRight(stmtEnd, `; } finally {${injection} } }`);
      }
    } else if (firstAsgn.isReturnOrThrow) {
      if (needsBracing) {
        s.appendLeft(firstAsgn.stmtStart, '{ try { ');
        s.appendRight(stmtEnd, `${sep} } finally {${injection} } }`);
      } else {
        s.appendLeft(firstAsgn.stmtStart, 'try { ');
        s.appendRight(stmtEnd, `${sep} } finally {${injection} }`);
      }
    } else if (needsBracing) {
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
