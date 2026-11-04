import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Each entry needs its own ESM graph: an earlier Store import otherwise masks
// the initialization cycle that prevented the standalone Agent view starting.
for(const entry of ['plugins/agent-view-routes','record-context','source-context','import-attribution','material-portable']){
  test(`standalone ${entry} starts before Store and preserves portable context validation`,()=>{
    const url=(name:string)=>new URL(`../src/${name}.ts`,import.meta.url).href;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
      import assert from 'node:assert/strict';
      await import(${JSON.stringify(url(entry))});
      const {portableRecordContextSchema}=await import(${JSON.stringify(url('record-context'))});
      const {portableSourceContextSchema}=await import(${JSON.stringify(url('source-context'))});
      const {portableImportAttributionSchema}=await import(${JSON.stringify(url('import-attribution'))});
      const declaration={captureId:'11111111-1111-4111-8111-111111111111',version:1,captureFingerprint:'a'.repeat(64),description:${JSON.stringify('  Generated owner description\n')},fingerprint:'b'.repeat(64)};
      assert.deepEqual(portableRecordContextSchema.parse({declarations:[declaration]}),{declarations:[declaration]});
      assert.equal(portableRecordContextSchema.safeParse({declarations:[{...declaration,description:''}]}).success,false);
      assert.equal(portableRecordContextSchema.safeParse({declarations:[{...declaration,untrustedExtra:true}]}).success,false);
      assert.deepEqual(portableSourceContextSchema.parse({declarations:[]}),{declarations:[]});
      assert.deepEqual(portableImportAttributionSchema.parse({declarations:[],captures:[]}),{declarations:[],captures:[]});
    `],{encoding:'utf8',timeout:15000});
    assert.equal(result.error,undefined,result.error?.message);
    assert.equal(result.status,0,result.stderr||result.stdout);
  });
}
