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
  const ast = babelParse(code, {
    sourceType: 'module',
    // Note: 'jsx' omitted — it breaks legacy TS type assertions <Type>value.
    // Background service workers are .ts files, not .tsx.
    plugins: ['typescript', 'decorators-legacy', 'importMeta'],
    errorRecovery: true,
  });

  if (ast.errors && ast.errors.length > 0) {
    console.warn(
      `[vite-plugin-mv3-persistent] ⚠️ Parse errors in background source:\n` +
      ast.errors.map((e: any) => `  Line ${e.loc?.line}: ${e.message}`).join('\n')
    );
  }

  return ast;
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
      if (decl.id.type !== 'Identifier') {
        // Destructuring patterns: let [x,y]=[1,2] or let {a}=obj — not supported.
        // Emit a warning so the user knows these variables are NOT persisted.
        if (
          decl.id.type === 'ArrayPattern' ||
          decl.id.type === 'ObjectPattern'
        ) {
          const patternCode = code.slice(decl.id.start!, decl.id.end!);
          console.warn(
            `[vite-plugin-mv3-persistent] ⚠️ Destructuring pattern '${patternCode}' is not supported for persistence. ` +
            `Only simple identifier declarations (let x = ...) can be persisted. ` +
            `The destructured variables will NOT survive SW restarts. ` +
            `Use individual 'let' declarations instead.`,
          );
        }
        continue;
      }
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
            // Recursively evaluate multiplication chains like 60*60*1000
            const evalNum = (node: Babel.Node): number | null => {
              if (node.type === 'NumericLiteral') return node.value;
              if (
                node.type === 'BinaryExpression' &&
                node.operator === '*' &&
                node.left &&
                node.right
              ) {
                const l = evalNum(node.left);
                const r = evalNum(node.right);
                if (l !== null && r !== null) return l * r;
              }
              return null;
            };
            const result = evalNum(delayArg);
            if (result !== null) {
              delayIsNumeric = true;
              delayValue = result;
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

          // Detect if handler returns a value — if so, we must NOT make it
          // async, because Chrome's onMessage return-true pattern and blocking
          // webRequest listeners require synchronous return values.
          let hasReturnValue = false;
          if (isExpressionBody) {
            // Expression-body arrow functions always implicitly return.
            // Check if the expression is `true` (the onMessage keep-channel-open pattern).
            if (body.type === 'BooleanLiteral' && body.value === true) {
              hasReturnValue = true;
            }
          } else if (body.type === 'BlockStatement') {
            // Walk block body for explicit `return <value>` statements.
            hasReturnValue = checkBlockHasReturnValue(body);
          }

          handlers.push({
            bodyStart,
            bodyEnd,
            isAsync,
            asyncInsertPos,
            isExpressionBody,
            hasReturnValue,
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
            const info = findStatementInfo(path);
            if (info) {
              const existing = assignments.find(
                (a) => a.varName === rootName && a.stmtEnd === info.stmtEnd,
              );
              if (!existing) {
                assignments.push({
                  varName: rootName,
                  stmtEnd: info.stmtEnd,
                  stmtStart: info.stmtStart,
                  needsBracing: info.needsBracing,
                  isFullReassignment: false, // method call — never a full reassignment
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
        const info = findStatementInfo(path);
        if (info) {
          const existing = assignments.find(
            (a) => a.varName === rootName && a.stmtEnd === info.stmtEnd,
          );
          if (!existing) {
            // Full reassignment when left is a simple Identifier (e.g. `obj = {...}`),
            // NOT a MemberExpression (e.g. `obj.prop = 5`).
            const isFullReassignment = left.type === 'Identifier';
            assignments.push({
              varName: rootName,
              stmtEnd: info.stmtEnd,
              stmtStart: info.stmtStart,
              needsBracing: info.needsBracing,
              isFullReassignment,
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

/** Check if a BlockStatement contains `return <value>` (not bare `return;`). */
function checkBlockHasReturnValue(body: Babel.BlockStatement): boolean {
  let found = false;
  // Simple recursive walk — don't descend into nested functions
  function walk(node: Babel.Node): void {
    if (found) return;
    if (
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration'
    ) return;
    if (node.type === 'ReturnStatement') {
      if ((node as Babel.ReturnStatement).argument !== null &&
          (node as Babel.ReturnStatement).argument !== undefined) {
        found = true;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      const val = (node as any)[key];
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
  walk(body);
  return found;
}

/**
 * Walk up the parent chain from an expression path (AssignmentExpression,
 * CallExpression, etc.) to find the enclosing statement's bounds and
 * determine whether it is the bare body of an if/for/while/etc.
 *
 * WHY NOT getStatementParent()?
 * Babel's getStatementParent() only returns statements inside ARRAY containers
 * (Program.body, BlockStatement.body). When a statement is the bare
 * consequent of `if (cond) obj.x=1;`, the ExpressionStatement is a DIRECT
 * property (IfStatement.consequent), not in an array, so getStatementParent()
 * skips it and returns the IfStatement itself — giving wrong stmtStart/stmtEnd
 * and making needsBracing always false.
 */
interface StatementInfo {
  stmtStart: number;
  stmtEnd: number;
  needsBracing: boolean;
}

function findStatementInfo(path: any): StatementInfo | null {
  const BRACING_PARENT_TYPES = new Set([
    'IfStatement', 'ForStatement', 'WhileStatement', 'DoWhileStatement',
    'ForInStatement', 'ForOfStatement',
  ]);

  // Walk up from the expression path, checking each ancestor's relationship
  // to its parent. If we find that an ancestor node is the bare (non-block)
  // body of a control-flow construct, that's our bracing target.
  let current: any = path;

  while (current) {
    const node = current.node;
    const parentPath = current.parentPath;
    if (!parentPath) break;

    const parentNode = parentPath.node;

    // Check if current node is the bare body of a control-flow construct.
    // A "bare body" means the node is a direct child (consequent/alternate/body)
    // and is NOT wrapped in a BlockStatement (i.e., no braces).
    if (BRACING_PARENT_TYPES.has(parentNode.type) && node.type !== 'BlockStatement') {
      const isBareBody = parentNode.type === 'IfStatement'
        ? parentNode.consequent === node || parentNode.alternate === node
        : parentNode.body === node;

      if (isBareBody) {
        // current.node is the bare body (e.g., ExpressionStatement)
        // that needs to be wrapped in braces.
        return {
          stmtStart: node.start,
          stmtEnd: node.end,
          needsBracing: true,
        };
      }
    }

    // If we hit a BlockStatement or Program, the assignment is inside a
    // properly braced block. Use getStatementParent() which works correctly
    // here (the statement IS in an array container).
    if (parentNode.type === 'BlockStatement' || parentNode.type === 'Program') {
      const stmt = path.getStatementParent();
      if (stmt) {
        return {
          stmtStart: stmt.node.start,
          stmtEnd: stmt.node.end,
          needsBracing: false,
        };
      }
      return null;
    }

    current = parentPath;
  }

  // Fallback: use getStatementParent() for any case we didn't handle above.
  const stmt = path.getStatementParent();
  if (stmt) {
    return {
      stmtStart: stmt.node.start,
      stmtEnd: stmt.node.end,
      needsBracing: false,
    };
  }
  return null;
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
