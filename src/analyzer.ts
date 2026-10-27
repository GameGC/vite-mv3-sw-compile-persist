import { parse as babelParse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type * as Babel from '@babel/types';

import type {
  ResolvedOptions,
  AnalysisResult,
  TopVarInfo,
  TimerCallInfo,
  ClearTimerInfo,
  ClearAllInfo,
  HandlerInfo,
  AssignmentInfo,
  FunctionDeclInfo,
} from './types.js';

import { isGlobal } from './types.js';

const traverse = (_traverse as any).default || _traverse;

// --- parseCode ---

export function parseCode(code: string): Babel.File {
  const ast = babelParse(code, {
    sourceType: 'module',
    // No 'jsx' — it breaks legacy TS type assertions <Type>value in .ts files.
    plugins: ['typescript', 'decorators-legacy', 'importMeta'],
    errorRecovery: true,
  });

  if (ast.errors && ast.errors.length > 0) {
    console.warn(
      `[mv3-persist] Parse errors in background source:\n` +
      ast.errors.map((e: any) => `  Line ${e.loc?.line}: ${e.message}`).join('\n')
    );
  }

  return ast;
}

// --- analyze ---

export function analyze(code: string, opts: ResolvedOptions): AnalysisResult {
  const ast = parseCode(code);

  const topVars: TopVarInfo[] = [];
  const timerCalls: TimerCallInfo[] = [];
  const clearTimerCalls: ClearTimerInfo[] = [];
  const clearAllCalls: ClearAllInfo[] = [];
  const handlers: HandlerInfo[] = [];
  const assignments: AssignmentInfo[] = [];
  const functionDecls: FunctionDeclInfo[] = [];
  const topLevelBindings = new Set<string>();

  // Collect top-level bindings
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

  // Top-level variable declarations
  for (const node of ast.program.body) {
    if (node.type !== 'VariableDeclaration') continue;
    if (node.kind !== 'let' && node.kind !== 'var') continue;

    for (const decl of node.declarations) {
      if (decl.id.type !== 'Identifier') {
        if (decl.id.type === 'ArrayPattern' || decl.id.type === 'ObjectPattern') {
          const patternCode = code.slice(decl.id.start!, decl.id.end!);
          console.warn(
            `[mv3-persist] Destructuring '${patternCode}' is not supported for persistence. ` +
            `Use individual 'let' declarations instead.`
          );
        }
        continue;
      }
      if (!decl.init) continue;

      const name = decl.id.name;
      if (opts.excludeVars.has(name)) continue;
      if (opts.persistentVars.size > 0 && !opts.persistentVars.has(name)) continue;

      const defaultCode = code.slice(decl.init.start!, decl.init.end!);
      const isBoolean =
        decl.init.type === 'BooleanLiteral' ||
        defaultCode.trim() === 'false' ||
        defaultCode.trim() === 'true';

      let collectionType: 'map' | 'set' | 'date' | 'array' | undefined;
      if (
        decl.init.type === 'NewExpression' &&
        decl.init.callee.type === 'Identifier'
      ) {
        if (decl.init.callee.name === 'Map') collectionType = 'map';
        else if (decl.init.callee.name === 'Set') collectionType = 'set';
        else if (decl.init.callee.name === 'Date') collectionType = 'date';
        else if (decl.init.callee.name === 'Array') collectionType = 'array';
      } else if (decl.init.type === 'ArrayExpression') {
        collectionType = 'array';
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

  // Collect function declarations (including bound methods)
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
              `[mv3-persistent] Bound method '${name}' captures persistent var '${rootName}'. ` +
              `After SW restart, the bound method will reference the restored (new) object. ` +
              `Consider __mv3_getVar('${rootName}').method.bind(...) instead.`
            );
          }
        }
      }
    }
  }

  // Walk the AST for timers, handlers, assignments
  const isInsidePromiseResolver = new WeakSet<Babel.Node>();

  traverse(ast, {
    NewExpression(path: any) {
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

    CallExpression(path: any) {
      const callee = path.node.callee;

      // setTimeout / setInterval
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

          const evaluatedDelay = evaluateNumericExpression(delayArg, path.scope);
          const delayIsNumeric = evaluatedDelay !== null;
          const delayValue = evaluatedDelay;
          const isAlarm = evaluatedDelay !== null ? evaluatedDelay >= opts.alarmThresholdMs : undefined;

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
            isAlarm,
          });
          return;
        }

        // clearTimeout / clearInterval
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

      // Intercept chrome.alarms.clearAll(), browser.alarms.clearAll(), Browser.alarms.clearAll(), alarms.clearAll()
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'clearAll'
      ) {
        const obj = callee.object;
        let isAlarmsClearAll = false;
        if (
          obj.type === 'MemberExpression' &&
          obj.property.type === 'Identifier' &&
          obj.property.name === 'alarms' &&
          obj.object.type === 'Identifier' &&
          ['chrome', 'browser', 'Browser'].includes(obj.object.name)
        ) {
          isAlarmsClearAll = true;
        } else if (
          obj.type === 'Identifier' &&
          obj.name === 'alarms'
        ) {
          isAlarmsClearAll = true;
        }

        if (isAlarmsClearAll) {
          clearAllCalls.push({
            start: path.node.start!,
            end: path.node.end!,
          });
          return;
        }
      }

      // addListener handlers
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

          // Handlers that return a value must NOT be made async.
          let hasReturnValue = false;
          if (isExpressionBody) {
            if (body.type === 'BooleanLiteral' && body.value === true) {
              hasReturnValue = true;
            }
          } else if (body.type === 'BlockStatement') {
            hasReturnValue = checkBlockHasReturnValue(body);
          }

          const asyncIIFEs = findAsyncIIFEs(callback.body);

          handlers.push({
            bodyStart,
            bodyEnd,
            isAsync,
            asyncInsertPos,
            isExpressionBody,
            hasReturnValue,
            asyncIIFEs,
          });
        }
      }

      // Method calls on persistent vars
      if (callee.type === 'MemberExpression') {
        if (
          callee.property.type === 'Identifier' &&
          callee.property.name === 'addListener'
        ) {
          // handled above
        } else {
          const rootName = resolveRootIdentifier(callee.object);
          if (rootName && persistentVarNames.has(rootName)) {
            const binding = path.scope.getBinding(rootName);
            if (!binding || binding.scope.block.type !== 'Program') return;
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
                  isFullReassignment: false,
                });
              }
            }
          }
        }
      }
    },

    AssignmentExpression(path: any) {
      const left = path.node.left;
      const targets = extractPatternTargets(left);
      for (const target of targets) {
        const rootName = resolveRootIdentifier(target);
        if (rootName && persistentVarNames.has(rootName)) {
          const binding = path.scope.getBinding(rootName);
          if (!binding || binding.scope.block.type !== 'Program') continue;
          const info = findStatementInfo(path);
          if (info) {
            const isFullReassignment = target.type === 'Identifier';
            const existing = assignments.find(
              (a) => a.varName === rootName && a.stmtEnd === info.stmtEnd,
            );
            if (!existing) {
              assignments.push({
                varName: rootName,
                stmtEnd: info.stmtEnd,
                stmtStart: info.stmtStart,
                needsBracing: info.needsBracing,
                isFullReassignment,
              });
            } else if (!existing.isFullReassignment && isFullReassignment) {
              existing.isFullReassignment = true;
            }
          }
        }
      }
    },

    UpdateExpression(path: any) {
      const arg = path.node.argument;
      const rootName = resolveRootIdentifier(arg);
      if (rootName && persistentVarNames.has(rootName)) {
        const binding = path.scope.getBinding(rootName);
        if (binding && binding.scope.block.type === 'Program') {
          const info = findStatementInfo(path);
          if (info) {
            const isFullReassignment = arg.type === 'Identifier';
            const existing = assignments.find(
              (a) => a.varName === rootName && a.stmtEnd === info.stmtEnd,
            );
            if (!existing) {
              assignments.push({
                varName: rootName,
                stmtEnd: info.stmtEnd,
                stmtStart: info.stmtStart,
                needsBracing: info.needsBracing,
                isFullReassignment,
              });
            } else if (!existing.isFullReassignment && isFullReassignment) {
              existing.isFullReassignment = true;
            }
          }
        }
      }
    },
  });

  return {
    topVars,
    timerCalls,
    clearTimerCalls,
    clearAllCalls,
    handlers,
    assignments,
    functionDecls,
    topLevelBindings,
    ast,
  };
}

// --- Helpers ---

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

function checkBlockHasReturnValue(body: Babel.BlockStatement): boolean {
  let found = false;
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
 * Walk the parent chain to find statement bounds and whether it needs bracing.
 * getStatementParent() skips bare bodies (direct IfStatement.consequent etc.),
 * so we detect those by walking the chain ourselves.
 */
interface StatementInfo {
  stmtStart: number;
  stmtEnd: number;
  needsBracing: boolean;
}

const BRACING_PARENT_TYPES = new Set([
  'IfStatement', 'ForStatement', 'WhileStatement', 'DoWhileStatement',
  'ForInStatement', 'ForOfStatement',
]);

function findStatementInfo(path: any): StatementInfo | null {
  let current: any = path;

  while (current) {
    const node = current.node;
    const parentPath = current.parentPath;
    if (!parentPath) break;

    const parentNode = parentPath.node;

    if (BRACING_PARENT_TYPES.has(parentNode.type) && node.type !== 'BlockStatement') {
      const isBareBody = parentNode.type === 'IfStatement'
        ? parentNode.consequent === node || parentNode.alternate === node
        : parentNode.body === node;

      if (isBareBody) {
        return { stmtStart: node.start, stmtEnd: node.end, needsBracing: true };
      }
    }

    if (parentNode.type === 'BlockStatement' || parentNode.type === 'Program') {
      const stmt = path.getStatementParent();
      if (stmt) {
        return { stmtStart: stmt.node.start, stmtEnd: stmt.node.end, needsBracing: false };
      }
      return null;
    }

    current = parentPath;
  }

  const stmt = path.getStatementParent();
  if (stmt) {
    return { stmtStart: stmt.node.start, stmtEnd: stmt.node.end, needsBracing: false };
  }
  return null;
}

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

export function evaluateNumericExpression(
  node: Babel.Node | null | undefined,
  scope: any,
  visited = new Set<any>(),
): number | null {
  if (!node || visited.has(node)) return null;
  visited.add(node);

  if (node.type === 'NumericLiteral') {
    return node.value;
  }

  if (node.type === 'UnaryExpression') {
    if (node.operator === '+' || node.operator === '-') {
      const val = evaluateNumericExpression(node.argument, scope, visited);
      if (val !== null) {
        return node.operator === '-' ? -val : +val;
      }
    }
    return null;
  }

  if (node.type === 'BinaryExpression') {
    const leftVal = evaluateNumericExpression(node.left, scope, visited);
    const rightVal = evaluateNumericExpression(node.right, scope, visited);
    if (leftVal === null || rightVal === null) return null;

    switch (node.operator) {
      case '+': return leftVal + rightVal;
      case '-': return leftVal - rightVal;
      case '*': return leftVal * rightVal;
      case '/': return rightVal !== 0 ? leftVal / rightVal : null;
      case '%': return rightVal !== 0 ? leftVal % rightVal : null;
      case '**': return leftVal ** rightVal;
      default: return null;
    }
  }

  if (node.type === 'Identifier') {
    const binding = scope?.getBinding?.(node.name);
    if (binding && binding.path?.isVariableDeclarator?.()) {
      const init = binding.path.node.init;
      if (init) {
        return evaluateNumericExpression(init, binding.scope, visited);
      }
    }
    return null;
  }

  return null;
}

export function extractPatternTargets(node: Babel.Node | null | undefined): Babel.Node[] {
  const targets: Babel.Node[] = [];
  function collect(n: Babel.Node | null | undefined) {
    if (!n) return;
    if (n.type === 'Identifier' || n.type === 'MemberExpression') {
      targets.push(n);
    } else if (n.type === 'ArrayPattern') {
      for (const elem of n.elements) {
        if (elem) collect(elem);
      }
    } else if (n.type === 'ObjectPattern') {
      for (const prop of n.properties) {
        if (prop.type === 'ObjectProperty') {
          collect(prop.value);
        } else if (prop.type === 'RestElement') {
          collect(prop.argument);
        }
      }
    } else if (n.type === 'AssignmentPattern') {
      collect(n.left);
    } else if (n.type === 'RestElement') {
      collect(n.argument);
    }
  }
  collect(node);
  return targets;
}

export function findAsyncIIFEs(
  node: Babel.Node,
): Array<{ bodyStart: number; bodyEnd: number; isExpressionBody: boolean }> {
  const iifes: Array<{ bodyStart: number; bodyEnd: number; isExpressionBody: boolean }> = [];
  function walk(n: Babel.Node) {
    if (!n) return;
    if (
      n.type === 'CallExpression' &&
      (n.callee.type === 'ArrowFunctionExpression' || n.callee.type === 'FunctionExpression') &&
      n.callee.async
    ) {
      const fn = n.callee;
      const fnBody = fn.body;
      if (fnBody.type === 'BlockStatement') {
        iifes.push({
          bodyStart: fnBody.start! + 1,
          bodyEnd: fnBody.end! - 1,
          isExpressionBody: false,
        });
      } else {
        iifes.push({
          bodyStart: fnBody.start!,
          bodyEnd: fnBody.end!,
          isExpressionBody: true,
        });
      }
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === 'callee' && n.type === 'CallExpression') continue;
      const val = (n as any)[key];
      if (val && typeof val === 'object' && typeof val.type === 'string') {
        if (val.type !== 'FunctionDeclaration') {
          walk(val);
        }
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && typeof item.type === 'string') {
            if (item.type !== 'FunctionDeclaration') {
              walk(item);
            }
          }
        }
      }
    }
  }
  walk(node);
  return iifes;
}
