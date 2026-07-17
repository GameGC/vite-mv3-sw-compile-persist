/**
 * vite-plugin-mv3-persistent  v7.1
 *
 * AST analysis: parses the user's background service worker source and
 * collects top-level variables, timer calls, event handlers, assignments,
 * and function declarations.
 */

import { parse as babelParse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type * as Babel from '@babel/types';

import type {
  ResolvedOptions,
  AnalysisResult,
  TopVarInfo,
  TimerCallInfo,
  ClearTimerInfo,
  HandlerInfo,
  AssignmentInfo,
  FunctionDeclInfo,
} from './types.js';

import { isGlobal } from './types.js';

// @babel/traverse ESM/CJS compat
const traverse = (_traverse as any).default || _traverse;

// ═══════════════════════════════════════════════════════════════════════
// § parseCode
// ═══════════════════════════════════════════════════════════════════════

export function parseCode(code: string): Babel.File {
  return babelParse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'decorators-legacy', 'jsx', 'importMeta'],
    errorRecovery: true,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// § analyze
// ═══════════════════════════════════════════════════════════════════════

export function analyze(code: string, opts: ResolvedOptions): AnalysisResult {
  const ast = parseCode(code);

  const topVars: TopVarInfo[] = [];
  const timerCalls: TimerCallInfo[] = [];
  const clearTimerCalls: ClearTimerInfo[] = [];
  const handlers: HandlerInfo[] = [];
  const assignments: AssignmentInfo[] = [];
  const functionDecls: FunctionDeclInfo[] = [];
  const topLevelBindings = new Set<string>();

  // ── Collect top-level bindings ──────────────────────────────────
  for (const node of ast.program.body) {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id.type === 'Identifier') {
          topLevelBindings.add(decl.id.name);
        }
      }
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      topLevelBindings.add(node.id.name);
    } else if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') {
          topLevelBindings.add(spec.local.name);
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          topLevelBindings.add(spec.local.name);
        } else if (spec.type === 'ImportSpecifier') {
          topLevelBindings.add(spec.local.name);
        }
      }
    }
  }

  // ── Top-level variable declarations ────────────────────────
  for (const node of ast.program.body) {
    if (node.type !== 'VariableDeclaration') continue;
    if (node.kind !== 'let' && node.kind !== 'var') continue;

    for (const decl of node.declarations) {
      if (decl.id.type !== 'Identifier') continue;
      if (!decl.init) continue;

      const name = decl.id.name;
      if (opts.excludeVars.has(name)) continue;
      if (opts.persistentVars.size > 0 && !opts.persistentVars.has(name))
        continue;

      const defaultCode = code.slice(decl.init.start!, decl.init.end!);
      const isBoolean =
        decl.init.type === 'BooleanLiteral' ||
        defaultCode.trim() === 'false' ||
        defaultCode.trim() === 'true';

      let collectionType: 'map' | 'set' | 'date' | undefined;
      if (
        decl.init.type === 'NewExpression' &&
        decl.init.callee.type === 'Identifier'
      ) {
        if (decl.init.callee.name === 'Map') collectionType = 'map';
        else if (decl.init.callee.name === 'Set') collectionType = 'set';
        else if (decl.init.callee.name === 'Date') collectionType = 'date';
      }

      const isObject =
        decl.init.type === 'ObjectExpression' ||
        decl.init.type === 'ArrayExpression' ||
        collectionType !== undefined ||
        decl.init.type === 'NewExpression' && (
          (decl.init.callee.type === 'Identifier' &&
            ['Array', 'Object'].includes(decl.init.callee.name))
        );

      topVars.push({
        name,
        defaultCode,
        isBoolean,
        isObject,
        collectionType,
        start: decl.start!,
        end: decl.end!,
      });
    }
  }

  const persistentVarNames = new Set(topVars.map((v) => v.name));

  // ── Collect all function declarations ──────────────────────
  for (const node of ast.program.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      functionDecls.push({ name: node.id.name });
    } else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id.type !== 'Identifier' || !decl.init) continue;
        const name = decl.id.name;

        if (
          decl.init.type === 'FunctionExpression' ||
          decl.init.type === 'ArrowFunctionExpression'
        ) {
          functionDecls.push({ name });
        } else if (
          decl.init.type === 'CallExpression' &&
          decl.init.callee.type === 'MemberExpression' &&
          decl.init.callee.property.type === 'Identifier' &&
          decl.init.callee.property.name === 'bind'
        ) {
          const boundCode = code.slice(decl.init.start!, decl.init.end!);
          functionDecls.push({ name, boundCode });

          const objRef = decl.init.callee.object;
          const rootName = resolveRootIdentifier(objRef);
          if (rootName && persistentVarNames.has(rootName)) {
            console.warn(
              `[vite-plugin-mv3-persistent] ⚠️ Bound method '${name}' captures persistent var '${rootName}'. ` +
              `After SW restart, the bound method will use the restored value of '${rootName}', ` +
              `which is a NEW object. Consider using __mv3_getVar('${rootName}').method.bind(...) ` +
              `or restructuring to avoid stale references.`,
            );
          }
        }
      }
    }
  }

  // ── Walk the AST for timers, handlers, assignments ─────────
  const isInsidePromiseResolver = new WeakSet<Babel.Node>();

  traverse(ast, {
    NewExpression(path) {
      if (path.node.callee.type !== 'Identifier') return;
      if (path.node.callee.name !== 'Promise') return;

      const args = path.node.arguments;
      if (args.length === 0) return;

      const executor = args[0];
      if (
        executor.type !== 'ArrowFunctionExpression' &&
        executor.type !== 'FunctionExpression'
      )
        return;

      isInsidePromiseResolver.add(executor);
    },

    CallExpression(path) {
      const callee = path.node.callee;

      // ── 1) setTimeout / setInterval ──────────────────────────────
      if (callee.type === 'Identifier') {
        if (callee.name === 'setTimeout' || callee.name === 'setInterval') {
          const prefix = code.slice(Math.max(0, callee.start! - 7), callee.start!);
          if (prefix.endsWith('__mv3_')) return;

          const args = path.node.arguments;
          if (args.length < 2) return;

          const callbackArg = args[0];
          const delayArg = args[1];

          let category: TimerCallInfo['category'] = 'complex-with-closure';
          let recoveryFnName: string | null = null;
          let innerFnName: string | null = null;

          let isPromiseResolver = false;
          let ancestorPath: any = path.getFunctionParent();
          while (ancestorPath) {
            if (isInsidePromiseResolver.has(ancestorPath.node as Babel.Node)) {
              isPromiseResolver = true;
              break;
            }
            ancestorPath = ancestorPath.parentPath?.getFunctionParent?.();
          }

          if (isPromiseResolver) {
            category = 'promise-resolver';
          } else if (callbackArg.type === 'Identifier') {
            category = 'named-ref';
            recoveryFnName = callbackArg.name;
            innerFnName = callbackArg.name;
          } else if (
            callbackArg.type === 'ArrowFunctionExpression' ||
            callbackArg.type === 'FunctionExpression'
          ) {
            const calledFns = extractCalledFunctions(callbackArg);

            const callbackPath = path.get('arguments')[0] as any;
            const hasClosureVars = detectClosureVars(
              callbackPath,
              persistentVarNames,
              topLevelBindings,
              opts.safeClosureVars,
            );

            if (calledFns.length === 1 && !hasClosureVars) {
              category = 'simple-wrapper';
              recoveryFnName = calledFns[0];
              innerFnName = calledFns[0];
            } else if (!hasClosureVars) {
              category = 'complex-no-closure';
              recoveryFnName = calledFns.length > 0 ? calledFns[calledFns.length - 1] : null;
            } else {
              category = 'complex-with-closure';
              recoveryFnName = calledFns.length > 0 ? calledFns[calledFns.length - 1] : null;
            }
          }

          let delayIsNumeric = false;
          let delayValue: number | null = null;
          if (delayArg.type === 'NumericLiteral') {
            delayIsNumeric = true;
            delayValue = delayArg.value;
          } else if (
            delayArg.type === 'BinaryExpression' &&
            delayArg.operator === '*'
          ) {
            const left = delayArg.left;
            const right = delayArg.right;
            if (left.type === 'NumericLiteral' && right.type === 'NumericLiteral') {
              delayIsNumeric = true;
              delayValue = left.value * right.value;
            }
          }

          timerCalls.push({
            type: callee.name as 'setTimeout' | 'setInterval',
            start: path.node.start!,
            end: path.node.end!,
            callbackNode: callbackArg,
            callbackStart: callbackArg.start!,
            callbackEnd: callbackArg.end!,
            delayNode: delayArg,
            category,
            recoveryFnName,
            innerFnName,
            delayIsNumeric,
            delayValue,
          });
          return;
        }

        // ── 2) clearTimeout / clearInterval ─────────────────────────
        if (callee.name === 'clearTimeout' || callee.name === 'clearInterval') {
          const prefix = code.slice(Math.max(0, callee.start! - 7), callee.start!);
          if (prefix.endsWith('__mv3_')) return;

          const arg = path.node.arguments[0];
          const argCode = arg ? code.slice(arg.start!, arg.end!) : 'undefined';

          clearTimerCalls.push({
            type: callee.name as 'clearTimeout' | 'clearInterval',
            start: path.node.start!,
            end: path.node.end!,
            argCode,
          });
          return;
        }
      }

      // ── 3) addListener handlers ──────────────────────────────────
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'addListener'
      ) {
        const callback = path.node.arguments[0];
        if (callback && (
          callback.type === 'ArrowFunctionExpression' ||
          callback.type === 'FunctionExpression'
        )) {
          const isAsync = !!callback.async;

          const body = callback.body;
          const isExpressionBody = body.type !== 'BlockStatement';
          let bodyStart: number;
          let bodyEnd: number;
          if (body.type === 'BlockStatement') {
            bodyStart = body.start! + 1;
            bodyEnd = body.end! - 1;
          } else {
            bodyStart = body.start!;
            bodyEnd = body.end!;
          }

          const asyncInsertPos = callback.start!;

          handlers.push({
            bodyStart,
            bodyEnd,
            isAsync,
            asyncInsertPos,
            isExpressionBody,
          });
        }
      }

      // ── 4) Method calls on persistent vars ───────────────────────
      if (callee.type === 'MemberExpression') {
        if (
          callee.property.type === 'Identifier' &&
          callee.property.name === 'addListener'
        ) {
          // Already handled above — not a mutation
        } else {
          const rootName = resolveRootIdentifier(callee.object);
          if (rootName && persistentVarNames.has(rootName)) {
            const stmt = path.getStatementParent();
            if (stmt) {
              const existing = assignments.find(
                (a) => a.varName === rootName && a.stmtEnd === stmt.node.end!,
              );
              if (!existing) {
                assignments.push({
                  varName: rootName,
                  stmtEnd: stmt.node.end!,
                });
              }
            }
          }
        }
      }
    },

    AssignmentExpression(path) {
      const left = path.node.left;
      const rootName = resolveRootIdentifier(left);
      if (rootName && persistentVarNames.has(rootName)) {
        const stmt = path.getStatementParent();
        if (stmt) {
          const existing = assignments.find(
            (a) => a.varName === rootName && a.stmtEnd === stmt.node.end!,
          );
          if (!existing) {
            assignments.push({
              varName: rootName,
              stmtEnd: stmt.node.end!,
            });
          }
        }
      }
    },
  });

  return {
    topVars,
    timerCalls,
    clearTimerCalls,
    handlers,
    assignments,
    functionDecls,
    topLevelBindings,
    ast,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// § Helpers
// ═══════════════════════════════════════════════════════════════════════

/** Resolve the root Identifier from a (possibly chained) MemberExpression. */
export function resolveRootIdentifier(node: Babel.Node): string | null {
  let current: Babel.Node = node;
  while (current.type === 'MemberExpression') {
    current = (current as Babel.MemberExpression).object;
  }
  if (current.type === 'Identifier') {
    return (current as Babel.Identifier).name;
  }
  return null;
}

/** Extract named function calls from a callback body. */
export function extractCalledFunctions(callbackNode: Babel.Node): string[] {
  const fns: string[] = [];

  if (
    callbackNode.type !== 'ArrowFunctionExpression' &&
    callbackNode.type !== 'FunctionExpression'
  )
    return fns;

  const body = callbackNode.body;

  if (body.type === 'CallExpression' && body.callee.type === 'Identifier') {
    fns.push(body.callee.name);
    return fns;
  }

  if (body.type === 'BlockStatement') {
    for (const stmt of body.body) {
      if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression') {
        const callee = stmt.expression.callee;
        if (callee.type === 'Identifier') {
          fns.push(callee.name);
        }
      }
    }
  }

  return fns;
}

/** Detect if a callback references closure variables. */
export function detectClosureVars(
  callbackPath: any,
  persistentVarNames: Set<string>,
  topLevelBindings: Set<string>,
  safeClosureVars: Set<string>,
): boolean {
  let hasClosure = false;
  const callbackScope = callbackPath.scope;

  callbackPath.traverse({
    Identifier(innerPath: any) {
      if (hasClosure) return;

      const name = innerPath.node.name;

      if (innerPath.isBindingIdentifier()) return;
      if (!innerPath.isReferencedIdentifier()) return;

      if (persistentVarNames.has(name)) return;
      if (topLevelBindings.has(name)) return;
      if (isGlobal(name)) return;
      if (safeClosureVars.has(name)) return;

      const binding = innerPath.scope.getBinding(name);

      if (!binding) return;

      if (binding.scope === callbackScope) return;

      const bindingScope = binding.scope;
      if (bindingScope.parent === null || bindingScope.parent === undefined) {
        return;
      }

      hasClosure = true;
    },
  });

  return hasClosure;
}
