import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './fixtures/scoped-actions.js';
import {defaultModelSettings} from '../src/model-settings.js';
import {waitForScopedState} from './fixtures/scoped-process.js';

test('retiring a saved shared Codex directory caller during initialization prevents the next physical model/list request',async t=>{
 const f=await fixture(t),entered=join(f.directory,'generated-init-entered'),release=join(f.directory,'generated-init-release'),log=join(f.directory,'generated-rpc-methods.jsonl'),executable=join(f.directory,'generated-codex-catalog.cjs');
 t.after(()=>{if(existsSync(f.directory))writeFileSync(release,'release');});
 // Only this generated stdin/stdout RPC process substitutes the external CLI.
 // It does not launch Codex, authenticate an account or access any user directory.
 writeFileSync(executable,'#!'+process.execPath+'\n'+`const fs=require('node:fs');let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:message.method})+'\\n');if(message.method==='initialize'){fs.writeFileSync(${JSON.stringify(entered)},'entered');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');}},10);}else if(message.method==='model/list')process.stdout.write(JSON.stringify({id:message.id,result:{data:[{model:'generated-codex-only'}]}})+'\\n');}});`,{mode:0o700});
 const syntax=spawnSync(process.execPath,['--check',executable],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
 const admin=await f.ok(f.admin.token,'/api/admin/configuration/models'),models=admin.domains.find((d:any)=>d.id==='models').saved;models.codex={executable,home:join(f.directory,'generated-codex-home')};models.profiles.push({id:'generated-codex',name:'Generated shared Codex',settings:{...defaultModelSettings(),provider:'codex',protocol:'codex-app-server',serviceTier:'default',baseUrl:'',apiKey:'',headers:{},extraBody:{},model:'generated-codex-only',modelRequestTimeoutMs:null,agentTimeoutMs:null}});
 await f.ok(f.admin.token,'/api/admin/configuration/models','PUT',{revision:admin.revision,value:models,preserveRedactedSecrets:true});await f.restart();const active=await f.ok(f.admin.token,'/api/admin/configuration/models');assert.equal(active.domains.find((d:any)=>d.id==='models').effective.codex.executable,executable,'fixture must activate its generated executable before any catalog request');const view=await f.ok(f.a.token,'/api/configuration');
 let early:{statusCode:number;body:string}|undefined;const pending=f.request(f.a.token,'/api/models/catalog','POST',{revision:view.revision,reference:{kind:'shared',id:'generated-codex'}});
 void pending.then(value=>early={statusCode:value.statusCode,body:value.body});await waitForScopedState(async()=>existsSync(entered)||early!==undefined,()=> 'Generated CLI never reached the real initialization await');assert.ok(existsSync(entered),'Catalog completed before generated initialization: '+JSON.stringify(early));await f.ok(f.a.token,'/api/auth/logout','POST',{});writeFileSync(release,'release');const result=await pending;assert.equal(result.statusCode,401,result.body);
 const methods=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line).method);assert.ok(methods.includes('initialize'));assert.equal(methods.includes('model/list'),false,'a retired caller must not authorize another physical RPC after the held initialize response');assert.deepEqual(methods,['initialize'],'the initialization notification is fenced as well');
 const bView=await f.ok(f.b.token,'/api/configuration'),positive=await f.ok(f.b.token,'/api/models/catalog','POST',{revision:bView.revision,reference:{kind:'shared',id:'generated-codex'}});assert.deepEqual(positive.items,[{id:'generated-codex-only',name:'generated-codex-only'}]);
});
