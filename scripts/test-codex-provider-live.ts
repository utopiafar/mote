/** Opt-in live Codex validation. Creates only generated evidence in a temporary Mote archive. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';
import type {ModelSettingsView} from '@mote/shared/models';

const directory=await mkdtemp(join(tmpdir(),'mote-codex-live-'));
const token=randomBytes(32).toString('hex'),headers={authorization:`Bearer ${token}`};
const config:Config={dataKey:'',dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME};
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
try{
  node=await buildApp(config);
  const catalog=await node.app.inject({url:'/api/model-settings/codex-models',headers});
  assert.equal(catalog.statusCode,200,catalog.body);
  const items=catalog.json<{items:{id:string;reasoningEfforts?:string[]}[]}>().items;
  assert.ok(items.length,'local Codex must return an account model catalog');
  const model=process.env.MOTE_TEST_CODEX_MODEL??items[0].id;
  assert.ok(items.some(m=>m.id===model),'test model must be available in the local Codex catalog');
  console.log(JSON.stringify({stage:'catalog',model,availableModels:items.length}));
  let view=(await node.app.inject({url:'/api/model-settings',headers})).json<ModelSettingsView>();
  const settings={provider:'codex',protocol:'codex-app-server',baseUrl:'',model,reasoningEffort:items.find(m=>m.id===model)?.reasoningEfforts?.includes('low')?'low':'auto',maxTokens:8192,timeoutMs:120000,allowUnauthenticatedLocal:false,apiKey:null,headers:null,extraBody:null};
  const saved=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/local-codex',headers,payload:{revision:view.revision,name:'Generated live Codex preset',settings}});
  assert.equal(saved.statusCode,200,saved.body);view=saved.json();
  const probe=await node.app.inject({method:'POST',url:'/api/model-settings/profiles/local-codex/test',headers,payload:{revision:view.revision,settings}});
  assert.equal(probe.statusCode,200,probe.body);assert.equal(probe.json().ok,true,probe.body);
  console.log(JSON.stringify({stage:'probe',...probe.json()}));
  const copied=await node.app.inject({method:'POST',url:'/api/model-settings/profiles/local-codex/copy',headers,payload:{revision:view.revision,id:'codex-copy',name:'Generated copy',includeCredentials:true}});
  assert.equal(copied.statusCode,200,copied.body);view=copied.json();
  // A deliberately unused preset default proves the module override is dispatched.
  const changed=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/codex-copy',headers,payload:{revision:view.revision,name:'Generated copy',settings:{...settings,model:'synthetic-unused-default'}}});
  assert.equal(changed.statusCode,200,changed.body);view=changed.json();
  const assigned=await node.app.inject({method:'PUT',url:'/api/model-settings/defaults',headers,payload:{revision:view.revision,defaults:{...view.defaults,chat:'codex-copy'},defaultModels:{chat:model}}});
  assert.equal(assigned.statusCode,200,assigned.body);
  const evidenceId=randomUUID();
  const note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:evidenceId,deviceId:'generated-codex-test',deviceName:'Generated fixture',platform:'import',capturedAt:new Date().toISOString(),text:'Generated Mote provider validation: the synthetic observatory opens on Wednesday at 14:30. This is test data, not a personal record.'}});
  assert.equal(note.statusCode,201,note.body);
  const started=Date.now();
  const answer=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'This is a synthetic integration test. Find the synthetic observatory in the archive using the available retrieval tools, then call evidence to read the matching record. What day and time does it open? Cite the source record.'}});
  assert.equal(answer.statusCode,200,answer.body);
  const result=answer.json();
  assert.equal(result.modelSelection.profileId,'codex-copy');assert.equal(result.modelSelection.model,model);
  console.log(JSON.stringify({stage:'query-result',modelSelection:result.modelSelection,tools:result.trace.map((t:{tool:string})=>t.tool),citations:result.citations.length}));
  assert.ok(result.trace.some((t:{tool:string})=>t.tool==='evidence'));
  assert.ok(result.citations.some((c:{id:string})=>c.id===evidenceId));assert.match(result.answer,/14:30/);
  console.log(JSON.stringify({ok:true,stage:'module-query',modelSelection:result.modelSelection,tools:result.trace.map((t:{tool:string})=>t.tool),citations:result.citations.length,durationMs:Date.now()-started,answer:result.answer,personalDataUsed:false}));
}finally{await node?.app.close();await rm(directory,{recursive:true,force:true});}
