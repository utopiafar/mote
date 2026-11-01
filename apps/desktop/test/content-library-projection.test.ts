import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {moteText} from '@mote/shared/i18n';
import {DurableQueue,type QueueRecord} from '../src/queue';
import {LocalSourceManager} from '../src/source-manager';
import {SourceAdapterRegistry} from '../src/source-adapters';
import {DEFAULT_SOURCE_OPTIONS,type LocalSource,type ScannedItem,type SourceDefinition,type SourceRequest} from '../src/source-types';
import {SourceSync} from '../src/source-sync';
import {defaultConfig} from '../src/config';
import {DESKTOP_STORAGE_VERSION} from '../src/storage-format';
import {localContentPage,localContentDetail,type LocalContentPage} from '../src/content-library';
import {event} from './fixtures';

let directory:string,queue:DurableQueue;
const managers:LocalSourceManager[]=[];
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),'mote-projection-'));
  queue=new DurableQueue(join(directory,'queue'),defaultConfig());await queue.initialize();
});
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const manager of managers)await manager.close();managers.length=0;
  await rm(directory,{recursive:true,force:true});
});

const pad=(index:number)=>String(index).padStart(4,'0');
// Previous production list path, kept as an independent full-clone reference.
function reference(queue:DurableQueue,app:LocalSourceManager,offset=0,query?:string,sourceId?:string):LocalContentPage {
  const needle=query?.trim().toLocaleLowerCase()??'',matches=(...values:(string|undefined)[])=>!needle||values.some(value=>value?.toLocaleLowerCase().includes(needle));
  const items:LocalContentPage['items']=[
    ...(sourceId?[]:queue.contentRecords()).filter(record=>matches(record.event.appName,record.event.ocrText)).map(record=>({key:`queue:${record.event.id}`,source:record.event.source,title:record.event.source==='note'?record.event.ocrText?.split('\n')[0].slice(0,100)||moteText('随手记'):record.event.appName,observedAt:record.event.capturedAt,preview:(record.event.ocrText??'').slice(0,160),sourceName:record.event.deviceName,error:record.syncError})),
    ...app.pendingContent().filter(({source,item})=>(!sourceId||source.id===sourceId)&&matches(item.title,item.text)).map(({source,item,key})=>({key:`source:${source.id}:${key}`,source:source.kind==='local-calendar'?'calendar' as const:source.kind==='coding-agent'?'coding' as const:'file' as const,title:item.title,observedAt:item.observedAt,preview:item.text.slice(0,160),sourceName:source.name})),
  ].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.key.localeCompare(b.key));
  return {items:items.slice(offset,offset+30),total:items.length,...(offset+30<items.length?{nextOffset:offset+30}:{})};
}

async function manager(scan:(source:LocalSource)=>ScannedItem[]):Promise<LocalSourceManager>{
  // Only the external source adapter is replaced. Manager, outbox, SQLite and list consumer are real.
  const adapters=new SourceAdapterRegistry();
  for(const kind of ['local-files','local-calendar','coding-agent'])adapters.register({kind,version:1,watchesPath:false,tracksDeletions:false,allowsArchive:kind==='local-files',validateConfiguration(){},async scan({source}){
    const items=scan(source);return {version:1,scan:{items,seen:items.map(item=>item.externalId),complete:true,skipped:0}};
  }});
  const app=new LocalSourceManager(join(directory,`sources-${managers.length}`),{serverUrl:'',token:'',deviceId:defaultConfig().deviceId},'/must-not-be-invoked-helper',true,undefined,adapters);
  managers.push(app);await app.initialize();return app;
}
const file=(index:number):ScannedItem=>({externalId:`generated-file-${pad(index)}`,title:`${index%7===0?'Title needle':'Generated file'} ${pad(index)}`,text:`${index%5===0?'Body needle':'Generated body'} ${pad(index)} ${'z'.repeat(4000)}`,kind:'file',layer:'original',mimeType:'text/plain',localOriginalBase64:Buffer.from(`Generated original ${pad(index)} ${'o'.repeat(6000)}`).toString('base64')});

it('keeps every page and search identical for 1,000 queue records and 200 original-bearing source items without full clones',async()=>{
  const records:QueueRecord[]=Array.from({length:1000},(_,index)=>{
    const generated=event(randomUUID()),capturedAt=index%9===0?'2026-11-02T00:00:00.000Z':new Date(Date.UTC(2026,9,15,0,index)).toISOString();
    const common={...generated,capturedAt,appName:index%7===0?'Searchable App':'Generated notes',source:'note' as const,durationMs:0,imageMime:undefined,privacy:{excluded:false as const,redacted:false,mode:'none' as const},ocrText:(index%5===0?`Needle note ${pad(index)}\n`:'Generated note ')+`body ${pad(index)} ${'x'.repeat(3000)}`};
    const value=index%10===0?{id:generated.id,deviceId:generated.deviceId,deviceName:generated.deviceName,platform:generated.platform,capturedAt,durationMs:1000,appId:generated.appId,appName:common.appName,source:'activity' as const,privacy:{excluded:false as const,redacted:false,mode:'none' as const,collection:'activity' as const}}:common;
    return {event:value,blobBytes:0,attempts:0,nextAttemptAt:0};
  });
  expect(await queue.importArchive({format:'mote-desktop-queue',version:DESKTOP_STORAGE_VERSION,records,blobs:{}})).toBe(1000);
  await queue.blockSync(records[3].event.id,'generated retained sync failure');
  const app=await manager(source=>source.kind==='local-files'?Array.from({length:200},(_,index)=>({...file(index),syncQueue:index%2===0?'realtime':'history'})):Array.from({length:2},(_,index)=>({externalId:`${source.kind}-${index}`,title:`Generated ${source.kind} title`,text:`Needle ${source.kind} body`,kind:source.kind==='local-calendar'?'calendar':'message',layer:'snapshot'})));
  const fileId=await app.addAdapterSource({kind:'local-files',name:'Generated original files'},{...DEFAULT_SOURCE_OPTIONS,retention:'archive'});await app.sync(true);
  await app.addAdapterSource({kind:'local-calendar',name:'Generated calendar'},DEFAULT_SOURCE_OPTIONS);await app.sync(true);
  await app.addAdapterSource({kind:'coding-agent',name:'Generated coding'},DEFAULT_SOURCE_OPTIONS);await app.sync(true);
  const pending=app.pendingContent();
  expect(pending.filter(row=>row.source.id===fileId)).toHaveLength(200);
  expect(pending.filter(row=>row.item.localOriginalBase64)).toHaveLength(200);
  expect(app.status().find(row=>row.source.id===fileId)).toMatchObject({pending:200,realtimePending:100,historyPending:100});
  expect(queue.contentRecords()).toHaveLength(1000);
  const clone=vi.spyOn(globalThis,'structuredClone');
  const compareAll=(query?:string,sourceId?:string)=>{
    const seen:string[]=[];
    for(let offset=0;;){
      // Reference clones are outside the measurement. Count only the actual consumer call.
      const expected=reference(queue,app,offset,query,sourceId);clone.mockClear();
      const actual=localContentPage(queue,app,offset,query,sourceId),clones=clone.mock.calls.length;
      expect(clones,`list clones at ${offset}, ${query}, ${sourceId}`).toBe(0);
      expect(actual).toEqual(expected);seen.push(...actual.items.map(row=>row.key));
      if(actual.nextOffset===undefined){expect(seen).toHaveLength(actual.total);break;}
      offset=actual.nextOffset;
    }
    expect(new Set(seen).size).toBe(seen.length);
  };
  compareAll();compareAll('  NEEDLE  ');compareAll('searchable app');compareAll('title needle');compareAll('Body needle 0005');compareAll('absent from every record');
  compareAll(undefined,fileId);compareAll('needle',fileId);compareAll('needle','local-00000000-0000-4000-8000-000000000000');
  expect(localContentPage(queue,app,9999)).toEqual({items:[],total:1204});
},120000);

it('hands out detached scalar projections while detail readers keep originals and queue ACKs retire rows',async()=>{
  const id=randomUUID();await queue.enqueue({...event(id),source:'note',durationMs:0,imageMime:undefined,privacy:{excluded:false,redacted:false,mode:'none'},ocrText:'Generated immutable note'});
  const first=queue.contentSummaries()[0];Object.assign(first,{ocrText:'tampered body',extra:{private:true}});
  expect(queue.contentSummaries()[0].ocrText).toBe('Generated immutable note');expect(queue.recordForHistory(id)?.event.ocrText).toBe('Generated immutable note');
  expect(Object.values(queue.contentSummaries()[0]).every(value=>value===undefined||typeof value==='string')).toBe(true);
  const original=file(0);original.text='';
  const app=await manager(()=>[original]);
  const sourceId=await app.addAdapterSource({kind:'local-files',name:'Generated private source'},{...DEFAULT_SOURCE_OPTIONS,retention:'archive'});await app.sync(true);
  const row=app.pendingContentSummaries()[0],key=`source:${row.sourceId}:${row.key}`;
  expect(Object.keys(row).sort()).toEqual(['item','key','sourceId','sourceKind','sourceName']);
  expect(Object.keys(row.item).sort()).toEqual(['externalId','observedAt','revision','text','title']);
  Object.assign(row.item,{text:'tampered body'});Object.assign(row,{sourceName:'tampered source',sourceId:'tampered-id'});
  const fresh=app.pendingContentSummaries()[0];expect(fresh.item.text).toBe('');expect(fresh.sourceName).toBe('Generated private source');expect(fresh.sourceId).toBe(sourceId);
  expect(app.pendingContent()[0].item.localOriginalBase64).toBe(original.localOriginalBase64);
  const detail=await localContentDetail(queue,app,key);expect(detail.text).toBe(Buffer.from(original.localOriginalBase64!,'base64').toString());expect(detail.retainsOriginal).toBe(true);
  expect((await localContentDetail(queue,app,`queue:${id}`)).text).toBe('Generated immutable note');
  await queue.acknowledge(id);expect(localContentPage(queue,app).items.some(item=>item.key===`queue:${id}`)).toBe(false);
  await expect(localContentDetail(queue,app,`queue:${id}`)).rejects.toThrow('该记录已完成同步');
  await app.close();
  await app.changeConnection({serverUrl:'http://127.0.0.1:9999',token:'generated-other-node-token',deviceId:defaultConfig().deviceId});
  expect(app.pendingContentSummaries()).toEqual([]);expect(localContentPage(queue,app).items).toEqual([]);
});

it('projects quarantined revisions with the same keys and bodies, and policy withdrawal removes them',async()=>{
  const engine=new SourceSync(join(directory,'quarantine.json'));await engine.initialize();
  const source:SourceDefinition={id:'generated-source',name:'Generated rejected files',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'snapshot',enabled:true};
  const items:ScannedItem[]=Array.from({length:2},(_,index)=>({externalId:`generated-rejected-${index}`,title:`Generated rejected ${index}`,text:`Generated text ${index}`,kind:'file',layer:'snapshot',document:{kind:'file',fileIndex:true}}));
  await engine.stage({items,seen:items.map(item=>item.externalId),complete:true,skipped:0},false);
  const request:SourceRequest=async(path,body)=>{
    if(path==='/api/sources')return source;
    if(path==='/api/file-sync/v1/capabilities')return {manifestBatch:100};
    if(path==='/api/file-sync/v1/manifests')return {results:(body as {items:{item:{externalId:string;revision:string}}[]}).items.map(({item})=>({externalId:item.externalId,revision:item.revision,state:'rejected',status:410}))};
    throw Error(`Unexpected generated request ${path}`);
  };
  await engine.flush(source,request);expect(engine.status()).toMatchObject({pending:0,blocked:2});
  const expected=engine.pendingContent().map(({title,text,observedAt,externalId,revision})=>({title,text,observedAt,externalId,revision}));
  expect(engine.pendingSummaries()).toEqual(expected);
  Object.assign(engine.pendingSummaries()[0],{text:'tampered quarantine'});expect(engine.pendingContent()[0].text).toBe(items[0].text);
  await engine.ensurePolicy('generated-withdrawn-policy');expect(engine.pendingSummaries()).toEqual([]);
});
