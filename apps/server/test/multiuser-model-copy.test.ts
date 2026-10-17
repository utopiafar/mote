import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {modelFixture} from './fixtures/scoped-actions.js';
import {waitForState} from './fixtures/scoped-query-accounts.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';

test('copying a personal model keeps or explicitly omits its own credentials without inheriting shared or another user settings',async t=>{
 const f=await modelFixture(t),models=(view:any)=>view.domains.find((domain:any)=>domain.id==='models').saved;
 for(const owner of ['A','B'])f.scripts.set(owner,(_body,_raw,res)=>writeMessagesResponse(res,{stage:1,text:JSON.stringify({answer:'GENERATED_COPY_'+owner,citationIds:[]})}));
 let view=await f.ok(f.a.token,'/api/configuration'),value=models(view);value.profiles[0].settings.headers={'x-generated-private':'GENERATED_A_HEADER'};value.profiles[0].settings.extraBody={temperature:0.37};await f.ok(f.a.token,'/api/configuration/models','PUT',{revision:view.revision,value,preserveRedactedSecrets:true});
 const bPath=join(f.directory,'configuration','users',f.b.userId,'mote.yaml'),bBefore=readFileSync(bPath,'utf8');view=await f.ok(f.a.token,'/api/configuration');
 const input={revision:view.revision,id:'generated-copy',name:'Generated private copy',includeCredentials:true},copied=await f.request(f.a.token,'/api/models/profiles/same-model/copy','POST',input);assert.equal(copied.statusCode,200,copied.body);const copyView=copied.json(),profile=models(copyView).profiles.find((profile:any)=>profile.id===input.id);assert.equal(profile.settings.apiKey,true);assert.equal(profile.settings.headers,true);assert.equal(profile.settings.extraBody,true);assert.doesNotMatch(copied.body,/GENERATED_A_KEY|GENERATED_A_HEADER|GENERATED_B_KEY/);assert.equal(readFileSync(bPath,'utf8'),bBefore);
 const runId=randomUUID();await f.ok(f.a.token,'/api/query-runs','POST',{id:runId,input:{question:'GENERATED_COPY_CHECK',modelReference:{kind:'personal',id:input.id}}});const run=await waitForState(()=>f.ok(f.a.token,'/api/query-runs/'+runId),value=>value.status!=='running','genuine copied-model request');assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(f.requests.at(-1)!.owner,'A');assert.equal(f.requests.at(-1)!.body.temperature,0.37);
 assert.equal((await f.request(f.a.token,'/api/models/profiles/same-model/copy','POST',{...input,id:'generated-stale-copy'})).statusCode,409,'copy uses the original whole-document CAS');
 view=await f.ok(f.a.token,'/api/configuration');const noCredentials=await f.ok(f.a.token,'/api/models/profiles/same-model/copy','POST',{revision:view.revision,id:'generated-empty-copy',name:'Generated copy without credentials',includeCredentials:false}),empty=models(noCredentials).profiles.find((profile:any)=>profile.id==='generated-empty-copy');assert.equal(empty.settings.apiKey,false);assert.equal(empty.settings.headers,false);assert.equal(empty.settings.extraBody,false);const calls=f.requests.length;assert.equal((await f.request(f.a.token,'/api/query-runs','POST',{id:randomUUID(),input:{question:'GENERATED_UNCONFIGURED',modelReference:{kind:'personal',id:empty.id}}})).statusCode,503);assert.equal(f.requests.length,calls,'an unconfigured copy never falls back to the source or shared model');
 const bView=await f.ok(f.b.token,'/api/configuration');assert.equal((await f.request(f.b.token,'/api/models/profiles/generated-copy/copy','POST',{revision:bView.revision,id:'generated-cross-copy',name:'Generated denied',includeCredentials:true})).statusCode,404);assert.equal((await f.request(f.a.token,'/api/models/profiles/__deployment__/copy','POST',{revision:noCredentials.revision,id:'generated-shared-copy',name:'Generated denied shared',includeCredentials:true})).statusCode,400,'shared inheritance is not a personal copy capability');assert.equal(readFileSync(bPath,'utf8'),bBefore);
});
