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

// --- Helpers for AST unwrapping ---

export function unwrapExpression(node: Babel.Node | null | undefined): Babel.Node | null | undefined {
  let curr = node;
  while (
    curr &&
    (curr.type === 'TSAsExpression' ||
      curr.type === 'TSSatisfiesExpression' ||
      curr.type === 'TSTypeAssertion' ||
      curr.type === 'TSNonNullExpression' ||
      curr.type === 'TSInstantiationExpression' ||
      curr.type === 'ParenthesizedExpression')
  ) {
    curr = (curr as any).expression;
  }
  return curr;
}

/**
 * Source span of an expression-bodied arrow function's body INCLUDING any wrapping
 * parentheses (Babel excludes them from body.start/end: `() => (x = 1)`).
 */
export function exprBodySpan(fn: any): { start: number; end: number } {
  const body = fn.body;
  let start: number = body.start;
  const ps = body.extra?.parenthesized ? body.extra.parenStart : undefined;
  if (typeof ps === 'number' && ps < start) start = ps;
  return { start, end: fn.end };
}

export function unwrapTopLevelNode(node: Babel.Node): Babel.Node {
  if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    return node.declaration;
  }
  if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
    return node.declaration;
  }
  return node;
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

  // Collect top-level bindings (including exported declarations)
  for (const rawNode of ast.program.body) {
    const node = unwrapTopLevelNode(rawNode);
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        const targets = extractPatternTargets(decl.id);
        for (const t of targets) {
          if (t.type === 'Identifier') {
            topLevelBindings.add(t.name);
          }
        }
      }
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      topLevelBindings.add(node.id.name);
    } else if (node.type === 'ClassDeclaration' && node.id) {
      topLevelBindings.add(node.id.name);
    } else if (node.type === 'TSEnumDeclaration' && node.id) {
      topLevelBindings.add(node.id.name);
    } else if (rawNode.type === 'ImportDeclaration') {
      for (const spec of rawNode.specifiers) {
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

  // Top-level variable declarations (including export let / export var)
  for (const rawNode of ast.program.body) {
    const node = unwrapTopLevelNode(rawNode);
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
      const initNode = unwrapExpression(decl.init)!;
      const typeAnn = (decl.id as any).typeAnnotation?.typeAnnotation;

      const isBoolean =
        initNode.type === 'BooleanLiteral' ||
        defaultCode.trim() === 'false' ||
        defaultCode.trim() === 'true' ||
        (initNode.type === 'UnaryExpression' && initNode.operator === '!') ||
        (initNode.type === 'CallExpression' &&
          initNode.callee.type === 'Identifier' &&
          initNode.callee.name === 'Boolean') ||
        typeAnn?.type === 'TSBooleanKeyword';

      let collectionType: 'map' | 'set' | 'date' | 'array' | undefined;
      if (
        initNode.type === 'NewExpression' &&
        initNode.callee.type === 'Identifier'
      ) {
        if (initNode.callee.name === 'Map') collectionType = 'map';
        else if (initNode.callee.name === 'Set') collectionType = 'set';
        else if (initNode.callee.name === 'Date') collectionType = 'date';
        else if (initNode.callee.name === 'Array') collectionType = 'array';
      } else if (initNode.type === 'ArrayExpression') {
        collectionType = 'array';
      } else if (
        initNode.type === 'CallExpression' &&
        initNode.callee.type === 'MemberExpression' &&
        initNode.callee.object.type === 'Identifier' &&
        initNode.callee.object.name === 'Array' &&
        initNode.callee.property.type === 'Identifier' &&
        ['from', 'of'].includes(initNode.callee.property.name)
      ) {
        collectionType = 'array';
      }

      if (!collectionType && typeAnn) {
        if (typeAnn.type === 'TSArrayType' || typeAnn.type === 'TSTupleType') {
          collectionType = 'array';
        } else if (
          typeAnn.type === 'TSTypeReference' &&
          typeAnn.typeName?.type === 'Identifier'
        ) {
          const refName = typeAnn.typeName.name;
          if (refName === 'Map') collectionType = 'map';
          else if (refName === 'Set') collectionType = 'set';
          else if (refName === 'Date') collectionType = 'date';
          else if (refName === 'Array') collectionType = 'array';
        }
      }

      const isObjectCall =
        initNode.type === 'CallExpression' &&
        initNode.callee.type === 'MemberExpression' &&
        initNode.callee.object.type === 'Identifier' &&
        initNode.callee.object.name === 'Object' &&
        initNode.callee.property.type === 'Identifier' &&
        ['create', 'assign', 'fromEntries'].includes(initNode.callee.property.name);

      const isObjectTypeAnn =
        typeAnn?.type === 'TSTypeLiteral' ||
        (typeAnn?.type === 'TSTypeReference' &&
          typeAnn.typeName?.type === 'Identifier' &&
          ['Record', 'Object'].includes(typeAnn.typeName.name));

      const isObject =
        initNode.type === 'ObjectExpression' ||
        initNode.type === 'ArrayExpression' ||
        collectionType !== undefined ||
        isObjectCall ||
        isObjectTypeAnn ||
        (initNode.type === 'NewExpression' &&
          initNode.callee.type === 'Identifier' &&
          ['Array', 'Object'].includes(initNode.callee.name));

      topVars.push({
        name,
        defaultCode,
        isBoolean,
        isObject,
        collectionType,
        start: decl.start!,
        end: decl.end!,
        stmtEnd: rawNode.end!,
      });
    }
  }

  const persistentVarNames = new Set(topVars.map((v) => v.name));

  // Collect function declarations (including bound methods and exported functions)
  for (const rawNode of ast.program.body) {
    const node = unwrapTopLevelNode(rawNode);
    if (node.type === 'FunctionDeclaration' && node.id) {
      functionDecls.push({ name: node.id.name, end: rawNode.end!, isHoisted: true });
    } else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id.type !== 'Identifier' || !decl.init) continue;
        const name = decl.id.name;
        const initNode = unwrapExpression(decl.init)!;

        if (
          initNode.type === 'FunctionExpression' ||
          initNode.type === 'ArrowFunctionExpression'
        ) {
          functionDecls.push({ name, end: rawNode.end!, isHoisted: false });
        } else if (
          initNode.type === 'CallExpression' &&
          initNode.callee.type === 'MemberExpression' &&
          initNode.callee.property.type === 'Identifier' &&
          initNode.callee.property.name === 'bind'
        ) {
          const boundCode = code.slice(decl.init.start!, decl.init.end!);
          functionDecls.push({ name, boundCode, end: rawNode.end!, isHoisted: false });

          const objRef = initNode.callee.object;
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
  const seenHandlerNodes = new WeakSet<Babel.Node>();

  function recordAssignment(rootName: string, path: any, isFullReassignment: boolean) {
    const info = findStatementInfo(path);
    if (!info) return;
    const existing = assignments.find(
      (a) =>
        a.varName === rootName &&
        a.stmtStart === info.stmtStart &&
        a.stmtEnd === info.stmtEnd &&
        a.needsBracing === info.needsBracing &&
        Boolean(a.isArrowExprBody) === Boolean(info.isArrowExprBody),
    );
    if (!existing) {
      assignments.push({
        varName: rootName,
        stmtEnd: info.stmtEnd,
        stmtStart: info.stmtStart,
        needsBracing: info.needsBracing,
        isFullReassignment,
        isReturnOrThrow: info.isReturnOrThrow,
        isArrowExprBody: info.isArrowExprBody,
      });
    } else {
      if (!existing.isFullReassignment && isFullReassignment) {
        existing.isFullReassignment = true;
      }
      if (!existing.isReturnOrThrow && info.isReturnOrThrow) {
        existing.isReturnOrThrow = true;
      }
    }
  }

  function registerHandlerFn(fnNode: Babel.Node) {
    if (seenHandlerNodes.has(fnNode)) return;
    if (
      fnNode.type !== 'ArrowFunctionExpression' &&
      fnNode.type !== 'FunctionExpression' &&
      fnNode.type !== 'FunctionDeclaration'
    ) {
      return;
    }
    seenHandlerNodes.add(fnNode);

    const isAsync = !!fnNode.async;
    const body = fnNode.body;
    const isExpressionBody = body.type !== 'BlockStatement';
    let bodyStart: number;
    let bodyEnd: number;
    if (body.type === 'BlockStatement') {
      bodyStart = body.start! + 1;
      bodyEnd = body.end! - 1;
    } else {
      const span = exprBodySpan(fnNode);
      bodyStart = span.start;
      bodyEnd = span.end;
    }

    const asyncInsertPos = fnNode.start!;

    // Handlers that return a value must NOT be made async.
    let hasReturnValue = false;
    if (isExpressionBody) {
      const unwrappedBody = unwrapExpression(body);
      if (unwrappedBody?.type === 'BooleanLiteral' && unwrappedBody.value === true) {
        hasReturnValue = true;
      } else if (unwrappedBody?.type === 'SequenceExpression' && unwrappedBody.expressions.length > 0) {
        const lastExpr = unwrapExpression(unwrappedBody.expressions[unwrappedBody.expressions.length - 1]);
        if (lastExpr?.type === 'BooleanLiteral' && lastExpr.value === true) {
          hasReturnValue = true;
        }
      }
    } else if (body.type === 'BlockStatement') {
      hasReturnValue = checkBlockHasReturnValue(body);
    }

    const asyncIIFEs = findAsyncIIFEs(body);

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

  traverse(ast, {
    NewExpression(path: any) {
      if (path.node.callee.type !== 'Identifier') return;
      if (path.node.callee.name !== 'Promise') return;

      const args = path.node.arguments;
      if (args.length === 0) return;

      const executor = unwrapExpression(args[0]);
      if (
        !executor ||
        (executor.type !== 'ArrowFunctionExpression' &&
          executor.type !== 'FunctionExpression')
      )
        return;

      isInsidePromiseResolver.add(executor);
    },

    CallExpression(path: any) {
      const callee = path.node.callee;

      // Resolve timer callee name (supports both setTimeout(...) and globalThis/self/window.setTimeout(...))
      let timerCalleeName: string | null = null;
      if (callee.type === 'Identifier') {
        timerCalleeName = callee.name;
      } else if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        ['globalThis', 'self', 'window'].includes(callee.object.name) &&
        callee.property.type === 'Identifier'
      ) {
        timerCalleeName = callee.property.name;
      }

      // setTimeout / setInterval
      if (timerCalleeName === 'setTimeout' || timerCalleeName === 'setInterval') {
        const prefix = code.slice(Math.max(0, callee.start! - 7), callee.start!);
        if (prefix.endsWith('__mv3_')) return;

        const args = path.node.arguments;
        if (args.length < 2) return;

        const rawCallbackArg = args[0];
        const callbackArg = unwrapExpression(rawCallbackArg) || rawCallbackArg;
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
          const singleZeroArgFn = isSingleZeroArgCall(callbackArg);

          const callbackPath = path.get('arguments')[0] as any;
          const hasClosureVars = detectClosureVars(
            callbackPath,
            persistentVarNames,
            topLevelBindings,
            opts.safeClosureVars,
          );

          if (singleZeroArgFn && !hasClosureVars) {
            category = 'simple-wrapper';
            recoveryFnName = singleZeroArgFn;
            innerFnName = singleZeroArgFn;
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
          type: timerCalleeName as 'setTimeout' | 'setInterval',
          start: path.node.start!,
          end: path.node.end!,
          calleeEnd: callee.end!,
          callbackNode: callbackArg,
          callbackStart: rawCallbackArg.start!,
          callbackEnd: rawCallbackArg.end!,
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
      if (timerCalleeName === 'clearTimeout' || timerCalleeName === 'clearInterval') {
        const prefix = code.slice(Math.max(0, callee.start! - 7), callee.start!);
        if (prefix.endsWith('__mv3_')) return;

        const arg = path.node.arguments[0];
        const argCode = arg ? code.slice(arg.start!, arg.end!) : 'undefined';

        clearTimerCalls.push({
          type: timerCalleeName as 'clearTimeout' | 'clearInterval',
          start: path.node.start!,
          end: path.node.end!,
          argCode,
        });
        return;
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

      // addListener handlers (both inline functions and top-level named function references)
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'addListener'
      ) {
        const rawCallback = path.node.arguments[0];
        const callback = unwrapExpression(rawCallback);
        if (callback) {
          if (
            callback.type === 'ArrowFunctionExpression' ||
            callback.type === 'FunctionExpression'
          ) {
            registerHandlerFn(callback);
          } else if (callback.type === 'Identifier') {
            const binding = path.scope.getBinding(callback.name);
            if (binding && binding.scope.block.type === 'Program') {
              if (binding.path.isFunctionDeclaration() && binding.path.node.body) {
                registerHandlerFn(binding.path.node);
              } else if (binding.path.isVariableDeclarator()) {
                const init = unwrapExpression(binding.path.node.init);
                if (
                  init &&
                  (init.type === 'ArrowFunctionExpression' ||
                    init.type === 'FunctionExpression')
                ) {
                  registerHandlerFn(init);
                }
              }
            }
          }
        }
      }

      // Object.assign(target, ...), Object.defineProperty(target, ...), Reflect.set(target, ...), Reflect.deleteProperty(target, ...)
      if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.property.type === 'Identifier' &&
        ((callee.object.name === 'Object' && ['assign', 'defineProperty', 'defineProperties'].includes(callee.property.name)) ||
          (callee.object.name === 'Reflect' && ['set', 'deleteProperty', 'defineProperty'].includes(callee.property.name)))
      ) {
        const firstArg = path.node.arguments[0];
        if (firstArg) {
          const rootName = resolveRootIdentifier(firstArg);
          if (rootName && persistentVarNames.has(rootName)) {
            const binding = path.scope.getBinding(rootName);
            if (binding && binding.scope.block.type === 'Program') {
              recordAssignment(rootName, path, false);
            }
          }
        }
      }

      // Method calls on persistent vars
      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
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
            recordAssignment(rootName, path, false);
          }
        }
      }
    },

    AssignmentExpression(path: any) {
      const left = path.node.left;
      const targets = extractPatternTargets(left);
      for (const target of targets) {
        const unwrappedTarget = unwrapExpression(target) || target;
        const rootName = resolveRootIdentifier(unwrappedTarget);
        if (rootName && persistentVarNames.has(rootName)) {
          const binding = path.scope.getBinding(rootName);
          if (!binding || binding.scope.block.type !== 'Program') continue;
          const isFullReassignment = unwrappedTarget.type === 'Identifier';
          recordAssignment(rootName, path, isFullReassignment);
        }
      }
    },

    UpdateExpression(path: any) {
      const arg = unwrapExpression(path.node.argument) || path.node.argument;
      const rootName = resolveRootIdentifier(arg);
      if (rootName && persistentVarNames.has(rootName)) {
        const binding = path.scope.getBinding(rootName);
        if (binding && binding.scope.block.type === 'Program') {
          const isFullReassignment = arg.type === 'Identifier';
          recordAssignment(rootName, path, isFullReassignment);
        }
      }
    },

    UnaryExpression(path: any) {
      if (path.node.operator !== 'delete') return;
      const arg = unwrapExpression(path.node.argument) || path.node.argument;
      const rootName = resolveRootIdentifier(arg);
      if (rootName && persistentVarNames.has(rootName)) {
        const binding = path.scope.getBinding(rootName);
        if (binding && binding.scope.block.type === 'Program') {
          recordAssignment(rootName, path, false);
        }
      }
    },

    ForOfStatement(path: any) {
      const left = path.node.left;
      if (left.type === 'VariableDeclaration') return;
      const targets = extractPatternTargets(left);
      for (const target of targets) {
        const unwrappedTarget = unwrapExpression(target) || target;
        const rootName = resolveRootIdentifier(unwrappedTarget);
        if (rootName && persistentVarNames.has(rootName)) {
          const binding = path.scope.getBinding(rootName);
          if (binding && binding.scope.block.type === 'Program') {
            recordAssignment(rootName, path, unwrappedTarget.type === 'Identifier');
          }
        }
      }
    },

    ForInStatement(path: any) {
      const left = path.node.left;
      if (left.type === 'VariableDeclaration') return;
      const targets = extractPatternTargets(left);
      for (const target of targets) {
        const unwrappedTarget = unwrapExpression(target) || target;
        const rootName = resolveRootIdentifier(unwrappedTarget);
        if (rootName && persistentVarNames.has(rootName)) {
          const binding = path.scope.getBinding(rootName);
          if (binding && binding.scope.block.type === 'Program') {
            recordAssignment(rootName, path, unwrappedTarget.type === 'Identifier');
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

export function resolveRootIdentifier(node: Babel.Node | null | undefined): string | null {
  let current = unwrapExpression(node);
  while (
    current &&
    (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression')
  ) {
    current = unwrapExpression((current as any).object);
  }
  if (current && current.type === 'Identifier') {
    return (current as Babel.Identifier).name;
  }
  return null;
}

function unwrapCallExpression(node: Babel.Node | null | undefined): Babel.CallExpression | null {
  let curr = unwrapExpression(node);
  while (
    curr &&
    (curr.type === 'AwaitExpression' ||
      (curr.type === 'UnaryExpression' && curr.operator === 'void'))
  ) {
    curr = unwrapExpression(curr.argument);
  }
  if (curr && curr.type === 'CallExpression') {
    return curr;
  }
  return null;
}

export function isSingleZeroArgCall(callbackNode: Babel.Node): string | null {
  if (
    callbackNode.type !== 'ArrowFunctionExpression' &&
    callbackNode.type !== 'FunctionExpression'
  ) {
    return null;
  }
  if (callbackNode.params.length > 0) return null;

  const body = callbackNode.body;
  if (body.type !== 'BlockStatement') {
    const expr = unwrapExpression(body);
    if (
      expr &&
      expr.type === 'CallExpression' &&
      expr.callee.type === 'Identifier' &&
      expr.arguments.length === 0
    ) {
      return expr.callee.name;
    }
    return null;
  }

  if (body.body.length === 1) {
    const stmt = body.body[0];
    let expr: Babel.Node | null | undefined = null;
    if (stmt.type === 'ExpressionStatement') {
      expr = unwrapExpression(stmt.expression);
    } else if (stmt.type === 'ReturnStatement' && stmt.argument) {
      expr = unwrapExpression(stmt.argument);
    }
    if (
      expr &&
      expr.type === 'CallExpression' &&
      expr.callee.type === 'Identifier' &&
      expr.arguments.length === 0
    ) {
      return expr.callee.name;
    }
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

  if (body.type !== 'BlockStatement') {
    const callExpr = unwrapCallExpression(body);
    if (callExpr && callExpr.callee.type === 'Identifier') {
      fns.push(callExpr.callee.name);
    }
    return fns;
  }

  if (body.type === 'BlockStatement') {
    for (const stmt of body.body) {
      let exprNode: Babel.Node | null | undefined = null;
      if (stmt.type === 'ExpressionStatement') {
        exprNode = stmt.expression;
      } else if (stmt.type === 'ReturnStatement' && stmt.argument) {
        exprNode = stmt.argument;
      }
      const callExpr = unwrapCallExpression(exprNode);
      if (callExpr && callExpr.callee.type === 'Identifier') {
        fns.push(callExpr.callee.name);
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

function checkBlockHasReturnOrThrow(root: Babel.Node): boolean {
  let found = false;
  function walk(node: Babel.Node): void {
    if (found) return;
    if (
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration'
    ) return;
    if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') {
      found = true;
      return;
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
  walk(root);
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
  isReturnOrThrow: boolean;
  isArrowExprBody: boolean;
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

    if (
      parentNode.type === 'ArrowFunctionExpression' &&
      parentNode.body === node &&
      node.type !== 'BlockStatement'
    ) {
      const span = exprBodySpan(parentNode);
      return {
        stmtStart: span.start,
        stmtEnd: span.end,
        needsBracing: false,
        isReturnOrThrow: false,
        isArrowExprBody: true,
      };
    }

    if (BRACING_PARENT_TYPES.has(parentNode.type) && node.type !== 'BlockStatement') {
      const isBareBody = parentNode.type === 'IfStatement'
        ? parentNode.consequent === node || parentNode.alternate === node
        : parentNode.body === node;

      if (isBareBody) {
        const isReturnOrThrow =
          node.type === 'ReturnStatement' ||
          node.type === 'ThrowStatement' ||
          (BRACING_PARENT_TYPES.has(node.type) && checkBlockHasReturnOrThrow(node));
        return {
          stmtStart: node.start,
          stmtEnd: node.end,
          needsBracing: true,
          isReturnOrThrow,
          isArrowExprBody: false,
        };
      }
    }

    if (
      parentNode.type === 'BlockStatement' ||
      parentNode.type === 'Program' ||
      parentNode.type === 'SwitchCase'
    ) {
      const stmtNode = node;
      if (stmtNode) {
        const isReturnOrThrow =
          stmtNode.type === 'ReturnStatement' ||
          stmtNode.type === 'ThrowStatement' ||
          ((BRACING_PARENT_TYPES.has(stmtNode.type) || stmtNode.type === 'SwitchStatement') &&
            checkBlockHasReturnOrThrow(stmtNode));
        return {
          stmtStart: stmtNode.start,
          stmtEnd: stmtNode.end,
          needsBracing: false,
          isReturnOrThrow,
          isArrowExprBody: false,
        };
      }
      return null;
    }

    current = parentPath;
  }

  const stmt = path.getStatementParent();
  if (stmt) {
    const isReturnOrThrow =
      stmt.node.type === 'ReturnStatement' || stmt.node.type === 'ThrowStatement';
    return {
      stmtStart: stmt.node.start,
      stmtEnd: stmt.node.end,
      needsBracing: false,
      isReturnOrThrow,
      isArrowExprBody: false,
    };
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
  rawNode: Babel.Node | null | undefined,
  scope: any,
  visited = new Set<any>(),
): number | null {
  const node = unwrapExpression(rawNode);
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

  if (node.type === 'CallExpression') {
    if (node.callee.type === 'Identifier' && node.callee.name === 'Number' && node.arguments.length === 1) {
      return evaluateNumericExpression(node.arguments[0], scope, visited);
    }
    if (
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'Math' &&
      node.callee.property.type === 'Identifier'
    ) {
      const args: number[] = [];
      for (const arg of node.arguments) {
        const v = evaluateNumericExpression(arg, scope, visited);
        if (v === null) return null;
        args.push(v);
      }
      const fn = node.callee.property.name;
      if (fn === 'floor' && args.length === 1) return Math.floor(args[0]);
      if (fn === 'ceil' && args.length === 1) return Math.ceil(args[0]);
      if (fn === 'round' && args.length === 1) return Math.round(args[0]);
      if (fn === 'abs' && args.length === 1) return Math.abs(args[0]);
      if (fn === 'max' && args.length >= 1) return Math.max(...args);
      if (fn === 'min' && args.length >= 1) return Math.min(...args);
      if (fn === 'pow' && args.length === 2) return Math.pow(args[0], args[1]);
    }
    return null;
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

export function extractPatternTargets(rawNode: Babel.Node | null | undefined): Babel.Node[] {
  const targets: Babel.Node[] = [];
  function collect(raw: Babel.Node | null | undefined) {
    const n = unwrapExpression(raw);
    if (!n) return;
    if (
      n.type === 'Identifier' ||
      n.type === 'MemberExpression' ||
      n.type === 'OptionalMemberExpression'
    ) {
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
  collect(rawNode);
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
        const span = exprBodySpan(fn);
        iifes.push({
          bodyStart: span.start,
          bodyEnd: span.end,
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
