import test from 'node:test';
import assert from 'node:assert/strict';
import {planComposition} from '@mote/plugin-host';

const manifest=(id,{version='1.0.0',runtime='worker',trust='official',contributions=[],dependencies=[]}={})=>({
  schemaVersion:1,id,name:id,version,trust,runtime,entry:'main.mjs',
  archive:{asset:'package.zip',sha256:'a'.repeat(64)},contributions,capabilities:[],
  configuration:[],dependencies,access:['generated fixture only'],
});
const source={id:'fixture.source',version:'1',surface:'ingress',runtime:'worker',entry:'source.mjs'};
const processor={id:'fixture.processor',version:'1',surface:'processing',runtime:'worker',requires:[{kind:'service',id:'fixture.reader',version:'1'}]};
const page={id:'fixture.page',version:'1',surface:'page',runtime:'host',entry:'page.html'};
const reader={id:'fixture.reader',version:'1',surface:'data',runtime:'worker',provides:[{kind:'service',id:'fixture.reader',apiVersion:'1',cardinality:'single'}]};
const invalid=result=>{assert.equal(result.ok,false);assert.equal(result.plan,undefined);return result.failures;};

test('activation plan resolves exact dependencies and a single provider without executing anything',()=>{
  const result=planComposition({revision:4,host:'central',packages:[
    manifest('fixture.package',{contributions:[source,processor,page]}),
    manifest('fixture.provider',{contributions:[reader]}),
  ]});
  assert.equal(result.ok,true);
  assert.deepEqual(result.plan.packages.map(value=>value.packageId),['fixture.package','fixture.provider']);
  assert.deepEqual(result.plan.contributions.map(value=>value.address.contributionId),['fixture.source','fixture.processor','fixture.page','fixture.reader']);
  assert.deepEqual(result.plan.bindings,[{service:{id:'fixture.reader',apiVersion:'1'},provider:{packageId:'fixture.provider',packageVersion:'1.0.0',contributionId:'fixture.reader'}}]);
});

test('a missing dependency, incompatible API or cycle fails before any activation plan exists',()=>{
  assert.deepEqual(invalid(planComposition({revision:1,host:'central',packages:[manifest('fixture.package',{contributions:[processor]})]})).map(value=>value.code),['missing_dependency']);
  assert.deepEqual(invalid(planComposition({revision:1,host:'central',packages:[
    manifest('fixture.package',{contributions:[processor]}),
    manifest('fixture.provider',{contributions:[{...reader,provides:[{kind:'service',id:'fixture.reader',apiVersion:'2',cardinality:'single'}]}]}),
  ]})).map(value=>value.code),['api_incompatible']);
  const cycle=invalid(planComposition({revision:1,host:'central',packages:[
    manifest('aaa',{dependencies:[{kind:'package',id:'bbb',version:'1.0.0'}]}),
    manifest('bbb',{dependencies:[{kind:'package',id:'aaa',version:'1.0.0'}]}),
  ]}));
  assert.equal(cycle[0].code,'dependency_cycle');
  assert.ok(cycle[0].path.length>=2);
  const mixed=invalid(planComposition({revision:1,host:'central',packages:[
    manifest('fixture.aaa',{contributions:[{id:'fixture.a',version:'1',surface:'data',runtime:'worker'}],dependencies:[{kind:'contribution',id:'fixture.b',version:'1'}]}),
    manifest('fixture.bbb',{contributions:[{id:'fixture.b',version:'1',surface:'data',runtime:'worker'}],dependencies:[{kind:'package',id:'fixture.aaa',version:'1.0.0'}]}),
  ]}));
  assert.equal(mixed[0].code,'dependency_cycle');
});

test('duplicate package identities and duplicate single providers require an explicit selection',()=>{
  assert.deepEqual(invalid(planComposition({revision:1,host:'central',packages:[manifest('same'),manifest('same')]})).map(value=>value.code),['duplicate_package']);
  assert.ok(invalid(planComposition({revision:1,host:'central',packages:[
    manifest('fixture.a',{contributions:[reader]}),manifest('fixture.b',{contributions:[reader]}),
  ]})).some(value=>value.code==='duplicate_contribution'));
  const duplicates=[manifest('fixture.a',{contributions:[{...reader,id:'fixture.reader.a'}]}),manifest('fixture.b',{contributions:[{...reader,id:'fixture.reader.b'}]})];
  assert.deepEqual(invalid(planComposition({revision:1,host:'central',packages:duplicates})).map(value=>value.code),['ambiguous_provider']);
  const explicit=planComposition({revision:1,host:'central',packages:[
    manifest('fixture.a',{contributions:[{...reader,id:'fixture.reader.a'}]}),
    manifest('fixture.b',{contributions:[{...reader,id:'fixture.reader.b'}]}),
  ],bindings:[{service:{id:'fixture.reader',apiVersion:'1'},provider:{packageId:'fixture.b',packageVersion:'1.0.0',contributionId:'fixture.reader.b'}}]});
  assert.equal(explicit.ok,true);
  assert.deepEqual(explicit.plan.bindings,[{service:{id:'fixture.reader',apiVersion:'1'},provider:{packageId:'fixture.b',packageVersion:'1.0.0',contributionId:'fixture.reader.b'}}]);
});

test('client hosts activate their own contributions even when the package entry runs centrally',()=>{
  const web=planComposition({revision:1,host:'web',packages:[manifest('fixture.client',{contributions:[page]})]});
  assert.equal(web.ok,true);
  assert.deepEqual(web.plan.contributions.map(value=>value.address.contributionId),['fixture.page']);
  const native={id:'fixture.native',version:'1',surface:'data',runtime:'native'};
  assert.equal(planComposition({revision:1,host:'mac',packages:[manifest('fixture.client',{contributions:[native]})]}).ok,true);
  assert.equal(planComposition({revision:1,host:'android',packages:[manifest('fixture.client',{contributions:[native]})]}).ok,true);
  assert.deepEqual(invalid(planComposition({revision:1,host:'web',packages:[manifest('fixture.client',{contributions:[source]})]})).map(value=>value.code),['unsupported_runtime']);
});

test('host distribution dependencies are satisfied by the running host',()=>{
  const result=planComposition({revision:1,host:'central',packages:[manifest('fixture.hosted',{dependencies:[{kind:'host',id:'mote.adapter',version:'1'}]})]});
  assert.equal(result.ok,true);
  assert.deepEqual(result.plan.packages[0].packageId,'fixture.hosted');
});
