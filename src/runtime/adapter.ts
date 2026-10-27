import type {
  ResolvedOptions,
  AnalysisResult,
} from '../types.js';

// --- buildAdapterBlock ---

export function buildAdapterBlock(
  analysis: AnalysisResult,
  opts: ResolvedOptions,
  insertPos?: number,
): string {
  const { topVars, timerCalls, functionDecls } = analysis;
  const varNames = topVars.map((v) => v.name);
  const booleanVars = topVars.filter((v) => v.isBoolean);
  const useProxy = opts.stateStrategy === 'proxy';
  const objectVars = topVars.filter(
    (v) => v.isObject && (insertPos === undefined || (v.stmtEnd ?? v.end) <= insertPos),
  );

  const getVarCases = topVars
    .map((v) => `      case '${v.name}': return ${v.name};`)
    .join('\n');

  // setVar: uses __mv3_deserialize to restore Map/Set/Date from storage.
  const setVarCases = topVars
    .map((v) => {
      const wrapProxy = useProxy && v.isObject;
      const deserialize = `__mv3_deserialize(value, '${v.collectionType ?? ''}')`;
      if (wrapProxy) {
        return `      case '${v.name}': ${v.name} = __mv3_reactive(${deserialize}, '${v.name}'); break;`;
      }
      return `      case '${v.name}': ${v.name} = ${deserialize}; break;`;
    })
    .join('\n');

  // getDirtyData: uses __mv3_serialize for Map/Set/Date types.
  const dirtyDataCases = topVars
    .map((v) => `      case '${v.name}': return { [prefix + '${v.name}']: __mv3_serialize(${v.name}, '${v.collectionType ?? ''}') };`)
    .join('\n');

  const earlyFunctionDecls = functionDecls.filter(
    (f) => f.isHoisted !== false || insertPos === undefined || f.end === undefined || f.end <= insertPos,
  );

  const fnRegistryCalls = earlyFunctionDecls
    .map((f) => {
      if (f.boundCode) {
        return `__mv3_registerFn('${f.name}', ${f.boundCode});`;
      }
      return `__mv3_registerFn('${f.name}', ${f.name});`;
    });

  const recoveryFns = new Set<string>();
  for (const tc of timerCalls) {
    if (tc.recoveryFnName) recoveryFns.add(tc.recoveryFnName);
  }
  const recoveryCalls = [...recoveryFns]
    .filter((fn) => analysis.topLevelBindings.has(fn) && !functionDecls.some((f) => f.name === fn))
    .map((fn) => `__mv3_registerFn('${fn}', ${fn});`);

  const allRegistryCalls = [...fnRegistryCalls, ...recoveryCalls]
    .filter((s) => s.length > 0)
    .join('\n');

  const namedHandlerCalls = Object.entries(opts.namedAlarmHandlers)
    .map(([k, v]) => `__mv3_registerFn('${k}', ${v});`)
    .join('\n');

  const proxyWrapping = useProxy && objectVars.length > 0
    ? objectVars.map(v => `${v.name} = __mv3_reactive(${v.name}, '${v.name}');`).join('\n')
    : '';

  return `
// MV3 Persist State adapter (auto-generated)

const {
  __mv3_init,
  __mv3_init_done,
  __mv3_markDirty,
  __mv3_setTimeout,
  __mv3_setInterval,
  __mv3_setTimeoutPromise,
  __mv3_setIntervalPromise,
  __mv3_clearTimeout,
  __mv3_clearInterval,
  __mv3_clearAllAlarms,
  __mv3_reactive,
  __mv3_getVar,
  __mv3_bindMethod,
  __mv3_registerFn,
  __mv3_fn_registry,
  __mv3_fn_names,
  __mv3_serialize,
  __mv3_deserialize,
} = createMV3Runtime(
  {
    varNames: ${JSON.stringify(varNames)},
    booleanVarNames: ${JSON.stringify(booleanVars.map(v => v.name))},
    storageArea: '${opts.storageArea}',
    alarmThresholdMs: ${opts.alarmThresholdMs},
    autoFlushMs: ${opts.autoFlushMs},
    staleLockThresholdMs: ${opts.staleLockThresholdMs},
    keepaliveStrategy: '${opts.keepaliveStrategy}',
    stateStrategy: '${opts.stateStrategy}',
    promiseResolverStrategy: '${opts.promiseResolverStrategy}',
  },
  {
    getVar(name: string): any {
      switch (name) {
${getVarCases}
        default: return undefined;
      }
    },
    setVar(name: string, value: any): void {
      switch (name) {
${setVarCases}
      }
    },
    getDirtyData(name: string, prefix: string): Record<string, any> | null {
      switch (name) {
${dirtyDataCases}
        default: return null;
      }
    },
  }
);

${allRegistryCalls}
${namedHandlerCalls || ''}
${proxyWrapping ? `
${proxyWrapping}` : ''}
`;
}
