import test from 'node:test';
import assert from 'node:assert/strict';
import {configureLocale} from '@mote/shared/i18n';
import {createIntakePlugin} from '../src/plugins/intake/index.js';
import {uploadHash} from '../src/upload-part.js';
import type {Api} from '../src/api.js';

configureLocale(()=> 'zh-CN');

const until=async(check:()=>boolean,label:string)=>{
  const end=Date.now()+5000;
  while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('Generated intake did not settle: '+label);
};
const draft=(file:File)=>({source:{kind:'files' as const,files:[file]},name:'Generated intake batch',instruction:'',sourcePackId:''});

test('deactivating intake pauses the upload queue and reactivating resumes the same operation',async t=>{
  const begins:{id:string;name:string}[]=[],creates:Record<string,unknown>[]=[];
  let first=true,uploadSignal:AbortSignal|undefined;
  const api={request:async(path:string,init:RequestInit)=>{
    if(path==='/api/import-uploads'){
      const input=JSON.parse(String(init.body));begins.push(input);
      if(first){first=false;uploadSignal=init.signal as AbortSignal;return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));}
      return {id:input.id,fileId:'archived:'+input.id,partBytes:4,parts:[]};
    }
    assert.equal(path,'/api/imports');
    const input=JSON.parse(String(init.body));creates.push(input);
    return {id:input.requestId,name:input.name,status:'completed'};
  }} as Api;
  const plugin=createIntakePlugin({api}),queue=plugin.activate(),file=new File(['Generated retained original'],'generated-original.txt');
  t.after(()=>plugin.dispose());
  const id=queue.enqueue(draft(file));
  await until(()=>queue.getSnapshot().entries[0]?.state==='uploading','first upload');
  plugin.deactivate();
  assert.equal(uploadSignal!.aborted,true,'plugin disable aborts the in-flight upload');
  await until(()=>queue.getSnapshot().entries[0]?.state==='paused','paused entry');
  assert.equal(queue.getSnapshot().entries.length,1);
  assert.equal(queue.draft(id)!.source.kind,'files');
  assert.equal((queue.draft(id)!.source as {files:File[]}).files[0],file,'the selected file stays attached while the plugin is disabled');
  assert.equal(creates.length,0);
  plugin.activate();
  await until(()=>queue.getSnapshot().entries[0]?.state==='submitted','resumed upload');
  assert.equal(begins.length,2);
  assert.equal(begins[0].id,begins[1].id,'a resumed upload keeps its operation identity');
  assert.equal(creates.length,1);
  assert.equal(creates[0].requestId,id,'one create request keeps the batch operation identity');
  assert.deepEqual(creates[0].archivedFileIds,['archived:'+begins[0].id]);
});

test('a lost upload acknowledgement retries explicitly and creates one import',async t=>{
  const begins:string[]=[],creates:Record<string,unknown>[]=[];let loseAck=true,uploadId='';
  const api={request:async(path:string,init:RequestInit)=>{
    if(path==='/api/import-uploads'){
      const input=JSON.parse(String(init.body));begins.push(input.id);uploadId=input.id;
      return {id:input.id,partBytes:4*1024*1024,parts:[]};
    }
    if(path.includes('/parts/')){
      if(loseAck){loseAck=false;throw Error('Generated lost acknowledgement');}
      const body=init.body as ArrayBuffer;
      return {part:Number(path.split('/').at(-1)),hash:await uploadHash(body),bytes:body.byteLength};
    }
    if(path.endsWith('/commit'))return {id:'archived:'+uploadId};
    assert.equal(path,'/api/imports');
    const input=JSON.parse(String(init.body));creates.push(input);
    return {id:input.requestId,name:input.name,status:'completed'};
  }} as Api;
  const plugin=createIntakePlugin({api}),queue=plugin.activate();
  t.after(()=>plugin.dispose());
  const id=queue.enqueue(draft(new File(['Generated retry original'],'generated-retry.txt')));
  await until(()=>queue.getSnapshot().entries[0]?.state==='failed','lost part acknowledgement');
  queue.retry(id);
  await until(()=>queue.getSnapshot().entries[0]?.state==='submitted','explicit retry');
  assert.deepEqual(begins,[uploadId,uploadId],'the retry resumes the same upload session');
  assert.equal(creates.length,1,'the retry does not create a second import');
  assert.equal(creates[0].requestId,id);
  assert.deepEqual(creates[0].archivedFileIds,['archived:'+uploadId]);
});
