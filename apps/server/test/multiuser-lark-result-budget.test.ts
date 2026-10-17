import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {scopedCaptureFixture} from './fixtures/scoped-capture-host.js';

async function fixture(t:TestContext){
 const state={calendarCount:20},calls:{user:string;kind:string}[]=[];
 const f=await scopedCaptureFixture(t,{connectorTransports:{lark:scope=>async command=>{
  calls.push({user:scope.userId,kind:command.kind});
  if(command.kind==='version')return 'lark-cli 1.0.85';
  if(command.kind==='status')return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'same-open-id',scope:'docx:document:readonly wiki:wiki:readonly search:docs:read space:document:retrieve calendar:calendar:readonly'}}});
  if(command.kind==='login')return JSON.stringify({verification_url:'https://accounts.feishu.cn/generated',device_code:'GENERATED_CODE',expires_in:600});
  if(command.kind==='complete')return '{}';
  if(command.kind==='documents-search')return JSON.stringify({results:Array.from({length:20},(_,i)=>({title:'GENERATED_'+i+'_'+'汉'.repeat(600),result_meta:{token:'GeneratedDocument'+i}})),has_more:false});
  if(command.kind==='calendars')return JSON.stringify({data:{calendar_list:Array.from({length:state.calendarCount},(_,i)=>({calendar_id:'same-calendar-'+i,summary:'GENERATED_'+scope.userId+'_'+i+'_'+'历'.repeat(600),role:'owner'})),has_more:false}});
  throw Error('Unexpected generated CLI I/O '+command.kind);
 }}});
 const checked=async(token:string,path:string,method:any='GET',body?:unknown)=>{const r=await f.request(token,path,method,body);assert.equal(r.statusCode,200,r.body);return r.json();};
 await checked(f.admin.token,'/api/admin/connectors/lark/install','POST',{expectedRevision:f.host.plugins!.catalog.revision(),operationId:randomUUID()});
 const operation=async(token:string,operation:string,payload:unknown={})=>{
  const admitted=await checked(token,'/api/connectors/same-lark/operations','POST',{operationId:randomUUID(),operation,payload});
  await f.host.execution!.engine.drain([admitted.id]);return checked(token,'/api/tasks/'+admitted.id);
 };
 for(const account of [f.a,f.b]){
  const view=await checked(account.token,'/api/connectors');await checked(account.token,'/api/connectors/same-lark','PUT',{expectedRevision:view.revision,connection:{provider:'lark',autoSync:false}});
  const plugins=await checked(account.token,'/api/plugins');await checked(account.token,'/api/connectors/same-lark/enable','POST',{expectedRevision:plugins.revision});
  assert.equal((await operation(account.token,'check')).state,'succeeded');
  assert.equal((await operation(account.token,'login')).state,'succeeded');
  assert.equal((await operation(account.token,'select',{documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'UTC',autoSync:false,documentDiscovery:{created:false,edited:true,opened:false,firstSyncDays:30}})).state,'succeeded');
 }
 return {f,state,calls,operation,checked};
}

test('actual Lark UTF8 metadata preview keeps all legal titles while its M05 receipt remains bounded',async t=>{
 const {f,operation,checked,calls}=await fixture(t),task=await operation(f.a.token,'preview');
 const status=await checked(f.a.token,'/api/connectors/same-lark');
 assert.equal(status.documentSync.preview.length,20);assert.ok(JSON.stringify(status).length<24000);assert.ok(Buffer.byteLength(JSON.stringify(status))>32768);
 assert.equal(task.state,'succeeded','legal multibyte metadata must not fail the actual M05 result budget');
 assert.equal(task.result.statusInConnection,true);assert.equal(task.result.documentSync,undefined);assert.ok(Buffer.byteLength(JSON.stringify(task.result))<=24000);
 assert.ok(status.documentSync.preview[19].title.endsWith('汉'.repeat(600)));assert.equal(calls.some(c=>c.kind==='document'),false,'preview cannot fetch a document body');
 assert.equal((await checked(f.b.token,'/api/connectors/same-lark')).documentSync?.preview?.length??0,0);
});

test('actual large Lark calendar discovery retains an exact owner/task inventory and the small-result contract',async t=>{
 const {f,state,operation,checked}=await fixture(t),task=await operation(f.a.token,'calendars');
 assert.equal(task.state,'succeeded','all calendar labels must survive the actual M05 result budget');assert.deepEqual(task.result,{calendarInventory:task.id,count:20});
 const status=await checked(f.a.token,'/api/connectors/same-lark');assert.equal(status.calendarInventory.taskId,task.id);assert.equal(status.calendarInventory.items.length,20);assert.ok(status.calendarInventory.items[19].name.endsWith('历'.repeat(600)));
 assert.equal((await checked(f.b.token,'/api/connectors/same-lark')).calendarInventory,undefined,'same connection and external IDs do not disclose A inventory to B');
 state.calendarCount=1;const small=await operation(f.b.token,'calendars');assert.equal(small.state,'succeeded');assert.equal(small.result.calendars.length,1);assert.equal(small.result.calendarInventory,undefined);
});
