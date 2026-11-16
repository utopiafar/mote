import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureLocale} from '@mote/shared/i18n';
import {verifiedOriginals} from '../src/ask-original-reference';
import type {Api} from '../src/api';
configureLocale(()=>'zh-CN');

test('Memory Ask uses every saved original ID, never a displayed evidence subset or a silently truncated large scope',async()=>{
 const ids=Array.from({length:31},()=>randomUUID()),reads:string[]=[];
 const api={request:async(path:string)=>{reads.push(path);return {title:'Generated Memory',evidenceIds:ids,evidence:[{id:ids[0]}],evidenceCount:31};}} as Api;
 await assert.rejects(verifiedOriginals(api,{kind:'memory',id:randomUUID()},new AbortController().signal),/30/);assert.equal(reads.length,1);
 const seen:string[]=[],small={request:async(path:string)=>{seen.push(path);return path.startsWith('/api/memories/')?{title:'Generated Memory',evidenceIds:ids.slice(0,2),evidence:[{id:ids[0]}],evidenceCount:2}:{id:path.split('/').at(-1)};}} as Api;
 assert.deepEqual((await verifiedOriginals(small,{kind:'memory',id:randomUUID()},new AbortController().signal)).ids,ids.slice(0,2));assert.equal(seen.filter(path=>path.startsWith('/api/capture-browser/')).length,2);
 const partial={request:async()=>({title:'Incomplete projection',evidenceIds:ids.slice(0,2),evidenceCount:3})} as unknown as Api;await assert.rejects(verifiedOriginals(partial,{kind:'memory',id:randomUUID()},new AbortController().signal),/暂不可用/);
});

test('Material Ask preserves the readable exact version including partial, asset-only and more than thirty blocks',async t=>{
 const {buildApp}=await import('../../server/src/app.js'),{materialId}=await import('../../server/src/materials.js');
 const dir=mkdtempSync(join(tmpdir(),'mote-ask-originals-')),token='generated-ask-original-token-123456789';
 const node=await buildApp({dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token},ids:string[]=[];
 for(let index=0;index<31;index++){const id=randomUUID();ids.push(id);const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated',deviceName:'Generated',platform:'import',capturedAt:'2026-10-29T00:00:00Z',text:'Generated original '+index}});assert.equal(response.statusCode,201,response.body);}
 const api={request:async(path:string)=>{const response=await node.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);return response.json();}} as Api;
 const publish=(selected:string[],text='Generated original scope')=>node.materials.publish({id:materialId('generated','ask'),kind:'mote.file',schemaVersion:1,title:'Generated material',origin:{sourceId:'generated',externalId:'ask'},members:selected.map(id=>({id,kind:'capture',ref:'capture:'+id})),blocks:selected.map((id,index)=>({id:'body-'+index,kind:'text',format:'plain',text:text+' '+index,memberIds:[id]})),coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:node.materials.get(materialId('generated','ask'))?.revision});
 const first=publish(ids.slice(0,2));const supplied=await api.request<any>('/api/materials/'+first.id);assert.equal(supplied.memorySource.evidenceIds.length,2);assert.deepEqual(await verifiedOriginals(api,{kind:'material',id:first.ref},new AbortController().signal),{ids:[],title:'Generated material',materialRef:first.ref});
 const large=publish(ids);assert.equal((await verifiedOriginals(api,{kind:'material',id:large.ref},new AbortController().signal)).materialRef,large.ref);await assert.rejects(verifiedOriginals(api,{kind:'material',id:first.ref},new AbortController().signal),/暂不可用/);
 const partial=node.materials.publish({id:materialId('generated','partial'),kind:'mote.file',schemaVersion:1,title:'Generated partial',origin:{sourceId:'generated',externalId:'partial'},members:[{id:ids[0],kind:'capture',ref:'capture:'+ids[0]}],blocks:[{id:'body-0',kind:'text',format:'plain',text:'Generated readable partial',memberIds:[ids[0]]}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'},coverage:{state:'partial',reason:'processing_pending'},artifacts:[{key:'text',state:'ready',blockIds:['body-0']},{key:'remaining',state:'pending',blockIds:[]}]});assert.equal((await verifiedOriginals(api,{kind:'material',id:partial.ref},new AbortController().signal)).materialRef,partial.ref);
 const asset=node.store.assets.put(Buffer.from('Generated attachment bytes'));const image=node.materials.publish({id:materialId('generated','asset'),kind:'mote.file',schemaVersion:1,title:'Generated attachment',origin:{sourceId:'generated',externalId:'asset'},members:[],blocks:[{id:'attachment',kind:'asset',hash:asset.hash,mimeType:'application/octet-stream',memberIds:[]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});asset.release();const page=await api.request<any>(`/api/materials/${image.id}/read?revision=${image.revision}&offset=0&length=2`);assert.equal(page.spans[0].kind,'asset');assert.equal((await verifiedOriginals(api,{kind:'material',id:image.ref},new AbortController().signal)).materialRef,image.ref);
 const changed=publish(ids.slice(0,2),'Changed original scope');node.materials.retire(changed.id,{expectedRevision:changed.revision});await assert.rejects(verifiedOriginals(api,{kind:'material',id:changed.ref},new AbortController().signal));
});

test('owner read success for an attachment accepts empty text without assuming text completeness',async()=>{
 const materialRef='material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64),paths:string[]=[];const material={ref:materialRef,revision:'b'.repeat(64),title:'Generated image',coverage:{state:'partial'}};const api={request:async(path:string)=>{paths.push(path);return path.includes('/read?')?{material,text:'',spans:[{kind:'asset'}]}:material;}} as Api;
 assert.deepEqual(await verifiedOriginals(api,{kind:'material',id:materialRef},new AbortController().signal),{ids:[],title:'Generated image',materialRef});assert.equal(paths.length,2);
});

test('Discovery follow-up reads the exact immutable report and all current originals through owner HTTP',async t=>{
 const {buildApp}=await import('../../server/src/app.js'),directory=mkdtempSync(join(tmpdir(),'mote-discovery-originals-')),token='generated-discovery-original-owner-token';
 const node=await buildApp({dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const ids=[randomUUID(),randomUUID()],runId=randomUUID(),at='2026-10-29T00:00:00Z',headers={authorization:'Bearer '+token};
 for(const id of ids){const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated',deviceName:'Generated',platform:'import',capturedAt:at,text:'Generated exact Discovery original '+id}});assert.equal(response.statusCode,201,response.body);}
 node.store.saveInsight({runId,answer:'Generated finding',trace:[],citations:ids.map(id=>({id,appName:'Generated original',capturedAt:at,excerpt:'Generated exact Discovery original'}))},runId);
 const paths:string[]=[],api={request:async(path:string)=>{paths.push(path);const response=await node.app.inject({url:path,headers});if(response.statusCode!==200)throw Error('Unavailable current original or report');return response.json();}} as Api;
 assert.deepEqual(await verifiedOriginals(api,{kind:'insight',id:runId},new AbortController().signal),{ids,title:'发现'});assert.deepEqual(paths,['/api/insights/'+runId,...ids.map(id=>'/api/capture-browser/'+id)]);
 const removed=await node.app.inject({method:'DELETE',url:'/api/notes/'+ids[0],headers});assert.equal(removed.statusCode,200);paths.length=0;
 await assert.rejects(verifiedOriginals(api,{kind:'insight',id:runId},new AbortController().signal));assert.deepEqual(paths,['/api/insights/'+runId],'An invalidated report never falls back to another capture or an available evidence subset');
});

test('Discovery follow-up refuses incomplete or oversized citation references without silently narrowing them',async()=>{
 const id=randomUUID(),ids=Array.from({length:31},()=>randomUUID()),paths:string[]=[];
 const api={request:async(path:string)=>{paths.push(path);return {runId:id,citations:ids.map(id=>({id}))};}} as Api;
 await assert.rejects(verifiedOriginals(api,{kind:'insight',id},new AbortController().signal),/30/);assert.deepEqual(paths,['/api/insights/'+id]);
 for(const value of [null,{}, {runId:randomUUID(),citations:[{id:ids[0]}]}])await assert.rejects(verifiedOriginals({request:async()=>value} as Api,{kind:'insight',id},new AbortController().signal),/暂不可用/);
});
