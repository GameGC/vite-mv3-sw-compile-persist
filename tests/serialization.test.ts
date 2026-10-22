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

console.log('\n=== Array serialization (fix for shift/find TypeError) ===');

{
  // Array literal — the primary user pattern: let queue: Type[] = [];
  const code = `let queue = [];`;
  const { code: out, virtualModule: vm } = transform(code, { strategy: 'proxy' });

  // __mv3_serialize should tag arrays with __mv3_type: 'Array'
  assert(vm.includes("'Array'"), '__mv3_deserialize handles Array type');
  assert(vm.includes('Array.isArray(value)'), '__mv3_serialize checks Array.isArray');
  assert(vm.includes('__mv3_toPlain'), '__mv3_toPlain helper defined in virtual module');
  assert(out.includes('__mv3_serialize(queue,'), '__mv3_serialize for Array in getDirtyData');
  assert(out.includes("'array'"), '__mv3_deserialize with array collectionType in setVar');
}

{
  // new Array() — should also be detected as array
  const code = `let items = new Array();`;
  const { code: out } = transform(code);

  assert(out.includes('__mv3_serialize(items,'), '__mv3_serialize for new Array() in getDirtyData');
  assert(out.includes("'array'"), '__mv3_deserialize with array collectionType for new Array()');
}

{
  // Proxy set trap must NOT store Proxies inside the target
  const code = `let obj = {}; let arr = [];`;
  const { virtualModule: vm } = transform(code, { strategy: 'proxy' });

  // The set trap should NOT contain "obj[key] = proxied" or "e[n] = proxied"
  // After fix, the set trap only does Reflect.set + markDirty
  const setTrapMatch = vm.match(/set\(obj.*?\{[\s\S]*?\}/);
  if (setTrapMatch) {
    const setTrap = setTrapMatch[0];
    assert(!setTrap.includes('obj[key] = proxied') && !setTrap.includes('obj[n] = proxied'),
      'Proxy set trap does NOT store Proxies in target');
    assert(setTrap.includes('__mv3_dirty.add'), 'Proxy set trap still marks dirty');
  } else {
    assert(false, 'Could not find set trap in virtual module');
  }
}

{
  // __mv3_toPlain should recursively handle arrays and objects
  const code = `let queue = [];`;
  const { virtualModule: vm } = transform(code, { strategy: 'proxy' });

  assert(vm.includes('function __mv3_toPlain('), '__mv3_toPlain function exists');
  assert(vm.includes('.map(__mv3_toPlain)'), '__mv3_toPlain handles arrays recursively');
  assert(vm.includes('Object.keys(value)'), '__mv3_toPlain handles plain objects');
}

{
  // Static mode: arrays should still be tagged (non-proxy arrays still need serialization)
  const code = `let queue = [];`;
  const { virtualModule: vm } = transform(code, { strategy: 'static' });

  assert(vm.includes("'Array'"), 'Array case in __mv3_deserialize (static mode)');
  assert(vm.includes('Array.isArray(value)'), 'Array.isArray check in __mv3_serialize (static mode)');
}

printResults();
