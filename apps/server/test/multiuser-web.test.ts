import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildApp} from '../src/app.js';
import {defaultModelSettings,defaultModelDomain} from '../src/model-settings.js';
import {createApi,type WebConnection} from '../../web/src/api.js';
import {submitWebNote} from '../../web/src/web-notes.js';
import {uploadNoteAttachment} from '../../web/src/note-attachments.js';

const password='Generated-M13-HTTP-password-01',protocol={'x-mote-protocol-version':'2'};
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-m13-http-')),host=await buildApp({dataDir:directory});
 t.after(async()=>{await host.app.close();rmSync(directory,{recursive:true,force:true});});
 await host.accounts!.initialize('generated-admin',password);
 const login=async(username:string,mode='web')=>{const r=await host.app.inject({method:'POST',url:'/api/auth/login',headers:protocol,payload:{username,password,mode}});assert.equal(r.statusCode,200,r.body);return {r,...r.json()};};
 const admin=await login('generated-admin','client');
 for(const username of ['generated-a','generated-b']){const r=await host.app.inject({method:'POST',url:'/api/admin/accounts',headers:{...protocol,authorization:'Bearer '+admin.token},payload:{username,password}});assert.equal(r.statusCode,200,r.body);}
 const a=await login('generated-a'),b=await login('generated-b');let cookie=String(a.r.headers['set-cookie']).split(';')[0];
 const info=async(grant:any):Promise<WebConnection>=>{
  const r=await host.app.inject({url:'/api/auth/self',headers:{...protocol,cookie:String(grant.r.headers['set-cookie']).split(';')[0]}});assert.equal(r.statusCode,200,r.body);
  return {...r.json(),mode:'web',origin:'http://localhost',viewScope:grant.credentialId};
 };
 t.mock.method(globalThis,'fetch',async(path:unknown,init?:RequestInit)=>{
  const headers=Object.fromEntries(new Headers(init?.headers));headers.cookie=cookie;
  const r=await host.app.inject({method:(init?.method??'GET') as any,url:String(path),headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
  return new Response(r.rawPayload,{status:r.statusCode,headers:r.headers as Record<string,string>});
 });
 const ai=await info(a),bi=await info(b);
 return {directory,host,admin,a,b,ai,bi,login,api:()=>createApi(ai),cookie:(owner:'a'|'b')=>{cookie=String((owner==='a'?a:b).r.headers['set-cookie']).split(';')[0];}};
}

test('actual Web Api and production Cookie resolver keep equal note IDs private and stale tab mutations fail before changing B',async t=>{
 const f=await fixture(t),id='6d477b3e-fb43-4657-818d-c143ad76430f',note={id,deviceId:'same-device',deviceName:'Generated web',platform:'import' as const,client:'web' as const,capturedAt:'2026-10-16T12:00:00Z',text:'GENERATED_A_WEB_NOTE'};
 const a=f.api();await submitWebNote(a,note);
 assert.match(JSON.stringify(await a.request('/api/captures?kind=note')),/GENERATED_A_WEB_NOTE/);
 f.cookie('b');const b=createApi(f.bi);await submitWebNote(b,{...note,text:'GENERATED_B_WEB_NOTE'});
 const bBefore=JSON.stringify(await b.request('/api/captures?kind=note'));
 assert.match(bBefore,/GENERATED_B_WEB_NOTE/);assert.doesNotMatch(bBefore,/GENERATED_A_WEB_NOTE/);
 await assert.rejects(a.request('/api/captures/'+id,{method:'DELETE'}),error=>(error as any).code==='session_changed');
 assert.equal(JSON.stringify(await b.request('/api/captures?kind=note')),bBefore);
 f.cookie('a');assert.doesNotMatch(JSON.stringify(await a.request('/api/captures?kind=note')),/GENERATED_B_WEB_NOTE/);
});

test('actual personal and administrator configuration view edits preserve owned secrets, CAS, list identity and B state',async t=>{
 const f=await fixture(t),a=f.api(),settings={...defaultModelSettings(),provider:'custom',protocol:'openai-completions',baseUrl:'https://synthetic.invalid/v1',model:'generated-model',apiKey:'GENERATED_A_PRIVATE_KEY'};
 let view=await a.request<any>('/api/configuration');
 view=await a.request('/api/configuration/models',{method:'PUT',body:JSON.stringify({revision:view.revision,value:{profiles:[{id:'same-profile',name:'Generated A',settings}],selections:{chat:{kind:'personal',id:'same-profile'}}}})});
 const value=structuredClone(view.domains.find((domain:any)=>domain.id==='models').saved);assert.equal(value.profiles[0].settings.apiKey,true);value.profiles[0].name='Edited A';
 await a.request('/api/configuration/models',{method:'PUT',body:JSON.stringify({revision:view.revision,value,preserveRedactedSecrets:true})});
 const file=join(f.directory,'configuration','users',f.a.userId,'mote.yaml');assert.match(readFileSync(file,'utf8'),/GENERATED_A_PRIVATE_KEY/);
 await assert.rejects(a.request('/api/configuration/models',{method:'PUT',body:JSON.stringify({revision:view.revision,value,preserveRedactedSecrets:true})}),error=>(error as any).status===409);
 f.cookie('b');const b=createApi(f.bi),bBefore=JSON.stringify(await b.request('/api/configuration'));assert.doesNotMatch(bBefore,/GENERATED_A_PRIVATE_KEY|Edited A/);
 await assert.rejects(b.request('/api/admin/configuration/models'),error=>(error as any).status===403);
 const adminHeaders={...protocol,authorization:'Bearer '+f.admin.token};
 let shared=await f.host.app.inject({url:'/api/admin/configuration/models',headers:adminHeaders});
 const sharedValue={...defaultModelDomain(),deployment:{...settings,apiKey:'GENERATED_SHARED_KEY'}};
 shared=await f.host.app.inject({method:'PUT',url:'/api/admin/configuration/models',headers:adminHeaders,payload:{revision:shared.json().revision,value:sharedValue}});assert.equal(shared.statusCode,200,shared.body);
 const redacted=shared.json().domains[0].saved;redacted.deployment.model='edited-shared-model';
 shared=await f.host.app.inject({method:'PUT',url:'/api/admin/configuration/models',headers:adminHeaders,payload:{revision:shared.json().revision,value:redacted,preserveRedactedSecrets:true}});assert.equal(shared.statusCode,200,shared.body);assert.doesNotMatch(shared.body,/GENERATED_SHARED_KEY/);
 assert.equal(JSON.stringify(await b.request('/api/configuration')),bBefore);
});

test('a held successful production response cannot publish after Web account retirement while a new credential stays usable',async t=>{
 const f=await fixture(t);let current=true,entered!:()=>void,release!:()=>void;
 const seen=new Promise<void>(done=>{entered=done;}),gate=new Promise<void>(done=>{release=done;}),transport=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(...args:Parameters<typeof fetch>)=>{const response=await transport(...args);entered();await gate;return response;});
 const api=createApi(f.ai,undefined,()=>current),pending=api.request('/api/configuration'),rejected=assert.rejects(pending,/登录会话/);await seen;current=false;release();await rejected;
 f.cookie('b');const b=createApi(f.bi);assert.ok(await b.request('/api/configuration'));
});

test('Web feature metadata describes real routes and Library keeps owned canonical material/source paging',async t=>{
 const f=await fixture(t),a=f.api();
 const inventory=await a.request<any>('/api/features');
 assert.equal(inventory.schemaVersion,1);const ids=inventory.capabilities.map((item:any)=>item.id);
 for(const id of ['http:GET:/api/materials','http:GET:/api/library/catalog','http:GET:/api/features'])assert.ok(ids.includes(id),id);
 assert.ok(ids.includes('http:GET:/api/imports'),'advertise the real owner-scoped Imports runtime');
 const note={id:'6d477b3e-fb43-4657-818d-c143ad76430f',deviceId:'same-device',deviceName:'Generated web',platform:'import' as const,client:'web' as const,capturedAt:'2026-10-16T12:00:00Z',text:'GENERATED_A_LIBRARY_NOTE'};
 await submitWebNote(a,note);f.cookie('b');const b=createApi(f.bi);await submitWebNote(b,{...note,text:'GENERATED_B_LIBRARY_NOTE'});f.cookie('a');
 const end=Date.now()+20000;let page:any;
 do{page=await a.request('/api/library/catalog?limit=1');if(page.items.length)break;await new Promise(done=>setTimeout(done,25));}while(Date.now()<end);
 assert.equal(page.items.length,1,'actual formal note producer reached canonical Material');
 const selected=page.items[0];assert.match(selected.ref,/^material:mat_/);assert.ok(page.sources.some((source:any)=>source.count>0));
 assert.match(JSON.stringify(await a.request('/api/materials/'+selected.id+'/read?revision='+selected.revision)),/GENERATED_A_LIBRARY_NOTE/);
 assert.doesNotMatch(JSON.stringify(page),/GENERATED_B_LIBRARY_NOTE/);
 f.cookie('b');assert.doesNotMatch(JSON.stringify(await b.request('/api/library/catalog?limit=1')),/GENERATED_A_LIBRARY_NOTE/);
 await assert.rejects(a.request('/api/library/catalog'),error=>(error as any).code==='session_changed');
});

test('Web attachment transport commits actual owned bytes and retries the same receipt without borrowing B authority',async t=>{
 const f=await fixture(t),a=f.api(),file=new File(['GENERATED_AUDIO_BYTES_ONLY'],'generated.wav',{type:'audio/wav',lastModified:0});
 const id=await uploadNoteAttachment(a,file,'same-device');assert.match(id,/^[a-f0-9-]{36}$/);
 assert.equal(await uploadNoteAttachment(a,file,'same-device'),id);
 const originals=await a.request<any>('/api/ingress/sources/notes-same-device/originals');assert.equal(originals.items.length,1);
 const original=originals.items[0],ticket=await a.request<any>('/api/ingress/originals/'+original.ref.slice(9)+'/tickets',{method:'POST',body:'{}'});
 assert.equal(await (await a.raw('/api/ingress/originals/'+original.ref.slice(9)+'/content?ticket='+encodeURIComponent(ticket.ticket))).text(),'GENERATED_AUDIO_BYTES_ONLY');
 f.cookie('b');const b=createApi(f.bi);await assert.rejects(b.request('/api/captures/'+id),error=>(error as any).status===404);
 await assert.rejects(uploadNoteAttachment(a,file,'same-device'),error=>(error as any).code==='session_changed');
 assert.equal((await b.request<any>('/api/captures')).items.length,0);
});

test('Web reference form transport retains metadata and retries one owned Ingress batch without fetching its URI',async t=>{
 const {saveWebReference}=await import('../../web/src/web-reference.js'),f=await fixture(t),a=f.api(),uri='nas://generated/reference-only.txt';
 await saveWebReference(a,'GENERATED_A_REFERENCE',uri);await saveWebReference(a,'GENERATED_A_REFERENCE',uri);
 const history=await a.request<any>('/api/sources/manual-references/history?externalId='+encodeURIComponent(uri));assert.equal(history.items.length,1);assert.equal(history.items[0].layer,'reference');assert.equal(history.items[0].uri,uri);assert.equal(history.items[0].text,'');
 f.cookie('b');const b=createApi(f.bi);await saveWebReference(b,'GENERATED_B_REFERENCE',uri);
 assert.doesNotMatch(JSON.stringify(await b.request('/api/source-items')),/GENERATED_A_REFERENCE/);
 await assert.rejects(saveWebReference(a,'STALE_A_REFERENCE',uri),error=>(error as any).code==='session_changed');
});

test('Web source-item consumers reject identity-corrupted actual M03 acknowledgements',async t=>{
 const {saveWebReference}=await import('../../web/src/web-reference.js'),f=await fixture(t),a=f.api();
 const file=new File(['GENERATED_IDENTITY_BYTES'],'identity.wav',{type:'audio/wav',lastModified:0});
 const good=await uploadNoteAttachment(a,file,'same-device'),uri='nas://generated/identity.txt';
 await saveWebReference(a,'Generated identity',uri);
 const transport=globalThis.fetch;let corrupt:((receipt:any)=>void)|undefined;
 t.mock.method(globalThis,'fetch',async(...args:Parameters<typeof fetch>)=>{
  const response=await transport(...args),url=String(args[0]);
  if(!corrupt||!url.startsWith('/api/ingress/')||!/(?:\/uploads|\/commit|\/items)$/.test(url))return response;
  const body=await response.json(),receipt=body.receipt??body;
  if(!receipt.captures)return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  corrupt(receipt);return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
 });
 const mutations:Record<string,(receipt:any)=>void>={
  capture:receipt=>{receipt.captures[0].id='b20a6edc-90ef-43c6-9d88-df798fd20c09';if(receipt.captures[0].original)receipt.captures[0].original.captureId=receipt.captures[0].id;},
  source:receipt=>{receipt.captures[0].sourceId='other-generated-source';},
  external:receipt=>{receipt.captures[0].externalId='other-generated-item';},
  revision:receipt=>{receipt.captures[0].revision='other-generated-revision';},
 };
 for(const [name,mutation]of Object.entries(mutations))for(const consumer of ['attachment','reference'])await t.test(consumer+' '+name,async()=>{
  corrupt=mutation;
  await assert.rejects(consumer==='attachment'?uploadNoteAttachment(a,file,'same-device'):saveWebReference(a,'Generated identity',uri),/acknowledgement does not match/);
 });
 await t.test('original source binding',async()=>{
  corrupt=receipt=>{receipt.captures[0].original.sourceId='other-generated-source';};
  await assert.rejects(uploadNoteAttachment(a,file,'same-device'),/acknowledgement does not match/);
 });
 corrupt=undefined;assert.equal(await uploadNoteAttachment(a,file,'same-device'),good);
 f.cookie('b');const b=createApi(f.bi);assert.equal(await uploadNoteAttachment(b,file,'same-device'),good,'equal logical IDs are valid in their independent accounts');
 await saveWebReference(b,'Generated B identity',uri);assert.doesNotMatch(JSON.stringify(await b.request('/api/source-items')),/Generated identity/);
});

test('Web Ask model availability treats an actual empty account selection as normal configuration state',async t=>{
 const {askModelSelectionPath}=await import('../../web/src/ask-model-selection.js'),f=await fixture(t),a=f.api();
 const empty=await a.request<any>('/api/models');assert.equal(askModelSelectionPath(empty),null);
 const settings={...defaultModelSettings(),provider:'custom',protocol:'openai-completions',baseUrl:'https://synthetic.invalid/v1',model:'generated-model',apiKey:'GENERATED_A_MODEL_KEY'};
 const view=await a.request<any>('/api/configuration');await a.request('/api/configuration/models',{method:'PUT',body:JSON.stringify({revision:view.revision,value:{profiles:[{id:'generated',name:'Generated',settings}],selections:{chat:{kind:'personal',id:'generated'}}}})});
 const selected=await a.request<any>('/api/models'),path=askModelSelectionPath(selected);assert.equal(path,'/api/models/selection/chat');assert.equal((await a.request<any>(path!)).model,'generated-model');
 f.cookie('b');assert.equal(askModelSelectionPath(await createApi(f.bi).request<any>('/api/models')),null);
});

test('Web insight progress receives its actual persisted scope on admission, list, cancellation and refresh',async t=>{
 const f=await fixture(t),a=f.api(),settings={...defaultModelSettings(),provider:'custom',protocol:'openai-completions',baseUrl:'https://synthetic.invalid/v1',model:'generated-model',apiKey:'GENERATED_A_MODEL_KEY'};
 const view=await a.request<any>('/api/configuration');await a.request('/api/configuration/models',{method:'PUT',body:JSON.stringify({revision:view.revision,value:{profiles:[{id:'generated',name:'Generated',settings}],selections:{insight:{kind:'personal',id:'generated'}}}})});
 const scope={after:'2026-01-01T00:00:00Z',before:'2026-01-02T00:00:00Z',timeZone:'UTC'},id=crypto.randomUUID();
 const run=await a.request<any>('/api/insight-runs',{method:'POST',body:JSON.stringify({requestId:id,prompt:'Generated bounded review',...scope})});
 assert.deepEqual(run.scope,scope);assert.equal(run.snapshot.id,id);assert.deepEqual(run.snapshot.scope,scope);
 assert.deepEqual((await a.request<any>('/api/insight-runs')).items[0].scope,scope);
 await a.request('/api/insight-runs/'+id+'/cancel',{method:'POST',body:'{}'});
 assert.deepEqual((await a.request<any>('/api/insight-runs/'+id)).scope,scope);
 f.cookie('b');const b=createApi(f.bi);assert.equal((await b.request<any>('/api/insight-runs')).items.length,0);
 await assert.rejects(b.request('/api/insight-runs/'+id),error=>(error as any).status===404);
});

test('Web conversation list includes actual owned turn counts for equal conversation IDs',async t=>{
 const f=await fixture(t),a=f.api(),id=crypto.randomUUID();
 await a.request('/api/conversations',{method:'POST',body:JSON.stringify({id,title:'Generated A conversation'})});
 assert.equal((await a.request<any>('/api/conversations')).items[0].turnCount,0);
 f.cookie('b');const b=createApi(f.bi);await b.request('/api/conversations',{method:'POST',body:JSON.stringify({id,title:'Generated B conversation'})});
 const page=await b.request<any>('/api/conversations');assert.equal(page.items[0].turnCount,0);assert.doesNotMatch(JSON.stringify(page),/Generated A conversation/);
});

test('Web outbound MCP preparation uses owned Ingress sources and original user configuration CAS without exposing saved tokens',async t=>{
 const {prepareWebMcpConnection}=await import('../../web/src/web-mcp.js'),f=await fixture(t),a=f.api(),baseline=await a.request<any>('/api/configuration');
 const input={id:'generated-mcp',sourceId:'generated-mcp-source',name:'Generated MCP source',url:'https://synthetic.invalid/mcp',token:'GENERATED_A_MCP_SECRET'};
 const next=await prepareWebMcpConnection(a,baseline,input),connections=next.domains.find((domain:any)=>domain.id==='mcpConnections').saved.connections;
 assert.equal(connections[0].id,input.id);assert.equal(connections[0].token,true);assert.deepEqual(connections[0].sourceIds,[input.sourceId]);
 assert.equal((await a.request<any>('/api/sources')).items.find((item:any)=>item.id===input.sourceId).kind,'mcp');
 await assert.rejects(prepareWebMcpConnection(a,baseline,{...input,id:'generated-stale'}),error=>(error as any).status===409);
 f.cookie('b');const b=createApi(f.bi);assert.doesNotMatch(JSON.stringify(await b.request('/api/configuration')),/GENERATED_A_MCP_SECRET|generated-mcp/);
 await assert.rejects(prepareWebMcpConnection(a,next,{...input,id:'generated-borrow'}),error=>(error as any).code==='session_changed');
 assert.equal((await b.request<any>('/api/sources')).items.length,0);
});

test('Web insight skills metadata comes from the actual bundled agent catalog behind the ordinary account boundary',async t=>{
 const f=await fixture(t),{skillCatalog}=await import('@mote/agent'),a=f.api();
 assert.deepEqual(await a.request('/api/skills'),{items:skillCatalog()});
 assert((await a.request<any>('/api/features')).capabilities.some((capability:any)=>capability.id==='http:GET:/api/skills'));
 f.cookie('b');assert.deepEqual(await createApi(f.bi).request('/api/skills'),{items:skillCatalog()});
 const anonymous=await f.host.app.inject({url:'/api/skills',headers:protocol});assert.equal(anonymous.statusCode,401);
});
