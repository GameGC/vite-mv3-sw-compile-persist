import { assert, transform, resetCounters, printResults } from './test-helpers';

resetCounters();

// --- registerFn generation ---

console.log('\n=== registerFn generation ===');

{
  const code = `
let counter = 0;

function myHandler() { counter++; }

setTimeout(myHandler, 5000);
`;
  const { code: out } = transform(code);

  assert(
    out.includes("__mv3_registerFn('myHandler', myHandler);"),
    'registerFn call generated for function declaration'
  );

  assert(
    !out.match(/['"]\w+['"]:\s*\w+,?\s*$/m),
    'No object-literal-style registry entries'
  );
}

{
  const code = `
let counter = 0;
let myObj = { method: function() {} };

const bound = myObj.method.bind(
  myObj,
  'arg1',
  'arg2'
);

setTimeout(bound, 5000);
`;
  const { code: out } = transform(code);

  assert(
    out.includes("__mv3_registerFn('bound',"),
    'registerFn call for bound method'
  );
  assert(
    out.includes('.bind('),
    'Bound expression present in registerFn call'
  );
}

{
  const code = `let counter = 0;`;
  const { code: out } = transform(code, {
    namedAlarmHandlers: { 'myAlarm': '() => { console.log("tick"); }' }
  });

  assert(
    out.includes("__mv3_registerFn('myAlarm',"),
    'Named alarm handler registered'
  );
}

{
  const code = `
let counter = 0;

function myRecoveryFn() { counter = 0; }

setTimeout(() => { myRecoveryFn(); }, 5000);
`;
  const { code: out } = transform(code);

  assert(
    out.includes("__mv3_registerFn('myRecoveryFn', myRecoveryFn);"),
    'Recovery function registered'
  );
}

// --- Storage error logging ---

console.log('\n=== Storage error logging ===');

{
  const code = `let counter = 0; let isProcessing = false;`;
  const { code: out, virtualModule: vm } = transform(code);

  assert(
    !vm.includes('.catch(() => {})'),
    'No silent .catch(() => {}) in virtual module'
  );
  assert(
    !out.includes('.catch(() => {})'),
    'No silent .catch(() => {}) in adapter'
  );
}

{
  const code = `let flag = false;`;
  const { virtualModule: vm } = transform(code, { keepaliveStrategy: 'offscreen' });

  assert(
    !vm.includes('.catch(() => {})'),
    'No silent .catch(() => {}) in offscreen virtual module'
  );
}

{
  const code = `let counter = 0;`;
  const { virtualModule: vm } = transform(code);

  assert(
    vm.includes("console.warn('[MV3] Storage write failed:'"),
    'Storage write errors logged'
  );
  assert(
    vm.includes("console.warn('[MV3] Storage cleanup failed:'"),
    'Storage cleanup errors logged'
  );
  assert(
    vm.includes('.catch(e => console.warn('),
    '.catch() passes error parameter'
  );
}

// --- Virtual module .ts extension ---

console.log('\n=== Virtual module .ts extension ===');

{
  const { mv3Persistent } = require('../src/index');

  const plugin = mv3Persistent({
    backgroundEntry: /.*/,
  });

  const resolved = plugin.resolveId('virtual:mv3-persistent-runtime', '/src/bg.ts', {});
  assert(
    resolved === '\0virtual:mv3-persistent-runtime.ts',
    'resolveId returns ID with .ts extension'
  );

  plugin.transform!.call({
    error(msg: string) { throw new Error(msg); },
  }, 'let x = 0;', '/bg.ts');

  const loaded = plugin.load!.call({}, '\0virtual:mv3-persistent-runtime.ts');
  assert(
    typeof loaded === 'string' && loaded.includes('createMV3Runtime'),
    'load() returns content with .ts-suffixed ID'
  );

  const oldIdLoaded = plugin.load!.call({}, '\0virtual:mv3-persistent-runtime');
  assert(
    oldIdLoaded === undefined || oldIdLoaded === null,
    'load() returns nothing for old non-.ts ID'
  );
}

{
  const code = `let x = 0;`;
  const { code: out } = transform(code);
  assert(
    out.includes("from 'virtual:mv3-persistent-runtime'"),
    "User code imports from bare virtual ID"
  );
  assert(
    !out.includes("from 'virtual:mv3-persistent-runtime.ts'"),
    "User import does NOT have .ts"
  );
}

// --- End-to-end regression ---

console.log('\n=== End-to-end regression ===');

{
  const code = `
let counter = 0;
let config = { name: "test" };
let isProcessing = false;

function tick() { counter++; }

chrome.runtime.onMessage.addListener(async (msg) => {
  console.log(counter);
});

setTimeout(tick, 65000);
clearTimeout(timer);
counter = 42;
config.name = "updated";
`;
  const { code: out, virtualModule: vm } = transform(code, { strategy: 'proxy' });

  assert(out.includes('__mv3_setTimeout(tick, 65000)'), 'setTimeout replacement works');
  assert(out.includes('__mv3_clearTimeout'), 'clearTimeout replacement works');
  assert(out.includes("__mv3_markDirty('counter')"), 'markDirty injection works');
  assert(out.includes('await __mv3_init'), '__mv3_init injection works');
  assert(out.includes("__mv3_registerFn('tick', tick);"), 'registerFn for tick works');
  assert(vm.includes('export function createMV3Runtime'), 'Virtual module exports createMV3Runtime');
  assert(!vm.includes('.catch(() => {})'), 'No silent error suppression');
}

printResults();
