import { transform, assert, resetCounters, printResults } from './test-helpers';

resetCounters();

console.log('\n=== Serialization scope ===');

{
  const code = `let myMap = new Map(); let mySet = new Set(); let myDate = new Date();`;
  const { code: out, virtualModule: vm } = transform(code);

  assert(out.includes('__mv3_serialize,'), '__mv3_serialize destructured in adapter');
  assert(out.includes('__mv3_deserialize,'), '__mv3_deserialize destructured in adapter');
  assert(out.includes('__mv3_serialize(myMap,'), '__mv3_serialize for Map in getDirtyData');
  assert(out.includes('__mv3_serialize(mySet,'), '__mv3_serialize for Set in getDirtyData');
  assert(out.includes('__mv3_serialize(myDate,'), '__mv3_serialize for Date in getDirtyData');
  assert(out.includes('__mv3_deserialize(value,'), '__mv3_deserialize in setVar');
  assert(vm.includes('__mv3_serialize,'), 'Virtual module returns __mv3_serialize');
  assert(vm.includes('__mv3_deserialize,'), 'Virtual module returns __mv3_deserialize');
  assert(vm.includes('function __mv3_serialize('), '__mv3_serialize defined in virtual module');
  assert(vm.includes('function __mv3_deserialize('), '__mv3_deserialize defined in virtual module');
}

printResults();
