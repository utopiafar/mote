import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadEnvironment} from '../dist/environment.js';
test('explicit environments cannot inherit a legacy file and resolve data beside selected config',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-env-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'dev'));writeFileSync(join(root,'.env'),'MOTE_TOKEN=legacy-secret\nMOTE_MODEL=legacy-model');
 const file=join(root,'dev','mote.env');writeFileSync(file,'MOTE_DATA_DIR=./vault\nMOTE_TOKEN=dev-only\nMOTE_PORT=47842');
 const inherited={MOTE_ENV_FILE:file,MOTE_PORT:'47942'};
 const result=loadEnvironment(root,{env:inherited});
 assert.equal(result.baseDir,join(root,'dev'));assert.equal(result.env.MOTE_TOKEN,'dev-only');assert.equal(result.env.MOTE_PORT,'47942');
 assert.equal(result.env.MOTE_MODEL,undefined);assert.deepEqual(inherited,{MOTE_ENV_FILE:file,MOTE_PORT:'47942'});
 assert.throws(()=>loadEnvironment(root,{env:{MOTE_ENV_FILE:join(root,'missing')}}),/does not exist/);
 assert.throws(()=>loadEnvironment(root,{env:{MOTE_ENV_FILE:''}}),/must name/);
 assert.equal(loadEnvironment(root,{env:{}}).env.MOTE_MODEL,'legacy-model');
});
test('two profile files keep credentials and values separate without process environment mutation',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-env-two-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const profile of ['dev','test'])writeFileSync(join(root,profile+'.env'),`MOTE_TOKEN=${profile}-only\nMOTE_PROFILE=${profile}`);
 const a=loadEnvironment(root,{env:{MOTE_ENV_FILE:join(root,'dev.env')}}),b=loadEnvironment(root,{env:{MOTE_ENV_FILE:join(root,'test.env')}});
 assert.equal(a.env.MOTE_PROFILE,'dev');assert.equal(b.env.MOTE_PROFILE,'test');assert.notEqual(a.env.MOTE_TOKEN,b.env.MOTE_TOKEN);
});
