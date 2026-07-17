import { transform, assert, resetCounters, printResults } from './test-utils-mv3';

resetCounters();

// ═══════════════════════════════════════════════════════════════
// Test: __mv3_serialize and __mv3_deserialize are available in adapter scope
// ═══════════════════════════════════════════════════════════════
console.log('\n=== Serialization scope fix ===');

{
  const code = `let myMap = new Map(); let mySet = new Set(); let myDate = new Date();`;
  const { code: out, virtualModule: vm } = transform(code);

  // 1. __mv3_serialize and __mv3_deserialize are destructured from createMV3Runtime
  assert(
    out.includes('__mv3_serialize,'),
    '__mv3_serialize is destructured in adapter'
  );
  assert(
    out.includes('__mv3_deserialize,'),
    '__mv3_deserialize is destructured in adapter'
  );

  // 2. __mv3_serialize is used in getDirtyData accessor
  assert(
    out.includes('__mv3_serialize(myMap,'),
    '__mv3_serialize called for Map in getDirtyData'
  );
  assert(
    out.includes('__mv3_serialize(mySet,'),
    '__mv3_serialize called for Set in getDirtyData'
  );
  assert(
    out.includes('__mv3_serialize(myDate,'),
    '__mv3_serialize called for Date in getDirtyData'
  );

  // 3. __mv3_deserialize is used in setVar accessor
  assert(
    out.includes('__mv3_deserialize(value,'),
    '__mv3_deserialize called in setVar'
  );

  // 4. The virtual module exports __mv3_serialize and __mv3_deserialize
  assert(
    vm.includes('__mv3_serialize,'),
    'Virtual module returns __mv3_serialize'
  );
  assert(
    vm.includes('__mv3_deserialize,'),
    'Virtual module returns __mv3_deserialize'
  );

  // 5. Verify the serialize/deserialize function definitions exist in the virtual module
  assert(
    vm.includes('function __mv3_serialize('),
    '__mv3_serialize function defined in virtual module'
  );
  assert(
    vm.includes('function __mv3_deserialize('),
    '__mv3_deserialize function defined in virtual module'
  );
}

printResults();
