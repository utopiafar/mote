import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../../src/app.js';
import type {ConfigDocument} from '../../src/config-service.js';
import {defaultProcessingSettings} from '../../src/scope/processing-schema.js';

export async function keepFixture(t:TestContext,setup?:(node:Awaited<ReturnType<typeof buildApp>>)=>void,instanceDocument?:ConfigDocument){
 const directory=mkdtempSync(join(tmpdir(),'mote-keep-controls-'));
 const config={dataDir:directory,...(instanceDocument?{configuration:{document:instanceDocument}}:{})};
 let node=await buildApp(config);
 setup?.(node);
 await node.accounts!.initialize('generated-admin','Generated-only-password-2026');
 let origin='';
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 origin=await node.app.listen({host:'127.0.0.1',port:0});
 const request=async(token:string|undefined,path:string,method='GET',body?:unknown)=>{
  const response=await fetch(origin+path,{method,headers:{'x-mote-protocol-version':'2','x-mote-ingress-version':'3',...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'})},...(body===undefined?{}:{body:Buffer.isBuffer(body)?new Uint8Array(body):JSON.stringify(body)})});
  const bytes=Buffer.from(await response.arrayBuffer());return {status:response.status,bytes,text:bytes.toString(),json:()=>JSON.parse(bytes.toString())};
 };
 const login=async(username:string)=>{const r=await request(undefined,'/api/auth/login','POST',{username,password:'Generated-only-password-2026',mode:'client'});assert.equal(r.status,200,r.text);return r.json();};
 const admin=await login('generated-admin'),users=[];
 for(const username of ['generated-a','generated-b']){const r=await request(admin.token,'/api/admin/accounts','POST',{username,password:'Generated-only-password-2026'});assert.equal(r.status,200,r.text);users.push(await login(username));}
 const [a,b]=users;
 for(const user of [a,b]){
  const view=await request(user.token,'/api/configuration');assert.equal(view.status,200,view.text);
  const saved=await request(user.token,'/api/configuration/processing','PUT',{revision:view.json().revision,value:{...defaultProcessingSettings(),enabled:false,automatic:false}});assert.equal(saved.status,200,saved.text);
 }
 return {directory,get origin(){return origin;},get node(){return node;},request,login,admin,a,b,restart:async()=>{await node.app.close();node=await buildApp(config);origin=await node.app.listen({host:'127.0.0.1',port:0});}};
}
