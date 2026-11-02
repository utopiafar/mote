import test from 'node:test';
import assert from 'node:assert/strict';
import {packageManifestSchema,featureManifestForPackage,PluginContractError} from '@mote/plugin-api';

const base={
  schemaVersion:1,id:'fixture.package',name:'Fixture package',version:'1.0.0',trust:'official',runtime:'worker',entry:'main.mjs',
  archive:{asset:'package.zip',sha256:'a'.repeat(64)},
  contributions:[
    {id:'fixture.source',version:'1',surface:'ingress',runtime:'worker',entry:'source.mjs',capabilities:['fixture.source']},
    {id:'fixture.processor',version:'1',surface:'processing',runtime:'worker',requires:[{kind:'service',id:'fixture.source',version:'1'}]},
    {id:'fixture.page',version:'1',surface:'page',runtime:'host',entry:'page.html'},
  ],
  capabilities:['fixture.source'],
  configuration:[{id:'endpoint',label:'Endpoint',type:'text'}],
  dependencies:[{kind:'package',id:'fixture.base',version:'1.0.0'}],
  access:['generated fixture only'],
};

test('one current Manifest parses multiple contributions, exact dependencies and trust',()=>{
  const parsed=packageManifestSchema.parse(base);
  assert.equal(parsed.schemaVersion,1);
  assert.equal(parsed.trust,'official');
  assert.equal(parsed.archive.sha256,'a'.repeat(64));
  assert.deepEqual(parsed.dependencies,[{kind:'package',id:'fixture.base',version:'1.0.0'}]);
  assert.deepEqual(parsed.contributions.map(value=>value.id),['fixture.source','fixture.processor','fixture.page']);
});

test('FeatureManifest is only a projection of package contributions',()=>{
  const manifest=packageManifestSchema.parse(base);
  const projected=featureManifestForPackage(manifest);
  assert.deepEqual(projected,{
    id:'fixture.package',version:'1.0.0',components:[
      {id:'fixture.source',version:'1',surface:'ingress'},
      {id:'fixture.processor',version:'1',surface:'processing',requires:[{id:'fixture.source',version:'1'}]},
      {id:'fixture.page',version:'1',surface:'page'},
    ],
  });
  assert.notEqual(projected.components,manifest.contributions);
});

test('the current Manifest rejects missing fixed artifacts, duplicate contributions and executable fields',()=>{
  const invalid=value=>assert.throws(()=>packageManifestSchema.parse(value),error=>error instanceof PluginContractError&&error.code==='invalid_contract');
  invalid({...base,archive:undefined});
  invalid({...base,entry:'../outside.mjs'});
  invalid({...base,contributions:[base.contributions[0],base.contributions[0]]});
  assert.throws(()=>packageManifestSchema.parse({...base,schemaVersion:2}),error=>error instanceof PluginContractError&&error.code==='unsupported_contract_version');
  invalid({...base,unknown:'field'});
  const accessor={...base};Object.defineProperty(accessor,'access',{get(){throw Error('must not execute');}});
  invalid(accessor);
  invalid({...base,dependencies:[{kind:'package',id:'fixture.base',version:'^1'}]});
});

test('action declaration payload is opaque to the host and cannot smuggle functions',()=>{
  const parsed=packageManifestSchema.parse({...base,actionCapabilities:[{id:'domain.capability',constraints:{enabled:true}}]});
  assert.deepEqual(parsed.actionCapabilities,[{id:'domain.capability',constraints:{enabled:true}}]);
  assert.throws(()=>packageManifestSchema.parse({...base,actionCapabilities:[{id:'domain.capability',run(){}}]}));
});
