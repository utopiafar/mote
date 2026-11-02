import {larkContext} from '../src/connectors/lark-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {LarkSelection} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {LarkConnector,LARK_SCOPES} from '../src/connectors/lark.js';
import type {LarkCommand,LarkRunner} from '../src/connectors/lark-cli.js';
import type {ConnectorContext} from '../src/connectors/types.js';
import {connectorReader} from './fixtures/connector-reader.js';

const selection:LarkSelection={documents:[],folders:['FolderGenerated123'],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false};
async function done(connector:LarkConnector){
  for(let n=0;n<500;n++){
    const status=connector.status();
    if(!['running','waiting'].includes(status.job?.state??''))return status;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  throw Error('Generated folder connector did not settle');
}
async function fixture(t:any,folderScope?:string){
  const directory=await mkdtemp(join(tmpdir(),'mote-lark-folder-scopes-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
  const context:ConnectorContext={evidenceReader:connectorReader(store,sources),store,sources,config:{dataDir:directory,token:'generated-folder-scope-owner-token',allowedOrigins:[]}};
  const calls:LarkCommand[]=[],state={granted:new Set([...LARK_SCOPES,...(folderScope?[folderScope]:[])]),grantRequested:false,requested:[] as string[]};
  const runner:LarkRunner=async command=>{
    calls.push(command);
    switch(command.kind){
      case 'version':return 'lark-cli version 1.0.85';
      case 'status':return JSON.stringify({appId:'cli_generated_folder_scope',identities:{user:{available:true,openId:'generated-folder-owner',scope:[...state.granted].join(' ')}}});
      case 'login':state.requested=command.scopes;return JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?fixture=folder-scopes',device_code:'generated-folder-device-code',expires_in:600});
      case 'complete':if(state.grantRequested)for(const scope of state.requested)state.granted.add(scope);return '{}';
      case 'folder-list':return JSON.stringify({data:{files:[{token:'DocumentGenerated123',type:'docx',name:'Generated folder document'}],has_more:false}});
      case 'document':return JSON.stringify({data:{document:{document_id:'DocumentGenerated123',revision_id:1,title:'Generated folder document',content:'Synthetic folder scope acceptance body.'}}});
      default:throw Error('Unexpected generated folder operation: '+command.kind);
    }
  };
  const connector=new LarkConnector(larkContext(context),runner);await connector.init();
  t.after(async()=>{await connector.close();store.close();await rm(directory,{recursive:true,force:true});});
  await connector.refresh();connector.login();assert.equal((await done(connector)).job?.state,'completed');
  await connector.select(selection);
  return {connector,sources,calls,state};
}

for(const scope of ['space:document:retrieve','drive:drive:readonly','drive:drive']){
  test(`native folder discovery accepts existing ${scope} without requesting a broader grant`,async t=>{
    const f=await fixture(t,scope);
    assert.deepEqual(f.connector.status().missingScopes,[]);
    await f.connector.refresh();assert.deepEqual(f.connector.status().missingScopes,[],'refresh must preserve equivalent scope readiness');
    f.connector.startPreview();const preview=await done(f.connector);
    assert.equal(preview.job?.state,'completed');assert.equal(preview.documentSync?.previewTotal,1);
    assert.equal(f.calls.filter(command=>command.kind==='document').length,0);assert.equal(f.sources.listItems().items.length,0);
    f.connector.startSync();const sync=await done(f.connector);
    assert.equal(sync.job?.state,'completed');assert.equal(sync.documentSync?.documents,1);
    assert.equal(f.sources.listItems({kind:'file'}).items[0]?.text,'Synthetic folder scope acceptance body.');
  });
}

test('missing every folder alternative reports the modern read-only scope and blocks discovery',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.connector.status().missingScopes,['space:document:retrieve']);
  f.connector.startPreview();assert.equal((await done(f.connector)).job?.error,'lark_permission_required');
  assert.equal(f.calls.filter(command=>command.kind==='folder-list'||command.kind==='document').length,0);
  assert.equal(f.sources.listItems().items.length,0);
});

test('folder reauthorization requests only the modern read-only alternative and unlocks native discovery',async t=>{
  const f=await fixture(t);f.state.grantRequested=true;
  f.connector.login();assert.equal((await done(f.connector)).job?.state,'completed');
  assert.deepEqual(f.state.requested,['docx:document:readonly','wiki:wiki:readonly','space:document:retrieve']);
  assert.ok(!f.state.requested.includes('drive:drive:readonly'));assert.ok(!f.state.requested.includes('drive:drive'));
  assert.deepEqual(f.connector.status().missingScopes,[]);
  f.connector.startPreview();assert.equal((await done(f.connector)).job?.state,'completed');
  f.connector.startSync();assert.equal((await done(f.connector)).documentSync?.documents,1);
});
