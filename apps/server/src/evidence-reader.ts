import {sourceContentTime,type CaptureRecord} from '@mote/shared';
import type {ContextReader} from '@mote/agent';
import {StoreError,type Store,type Range} from './store.js';
import {MemoryStore} from './memory.js';
import type {SourceStore} from './sources.js';
import type {FileStore} from './files.js';
import type {Indexer} from './indexer.js';
import type {FileEvidenceRequests} from './file-evidence.js';
import type {ServerDiagnostics} from './diagnostics.js';
import {contextIndex} from './context-index.js';
import {browseSourceCatalog} from './source-catalog.js';

/** References name immutable observations, not the current version of an item. */
export function parseEvidenceRef(ref:string):{kind:'capture'|'memory';id:string}|undefined {
  const match=/^(?:(capture|memory):)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(ref);
  return match?{kind:match[1]==='memory'?'memory':'capture',id:match[2]}:undefined;
}
export function withinEvidenceScope(record:CaptureRecord,scope:Range={}) {
  const p=record.provenance,coding=p?.document?.coding,at=sourceContentTime(record);
  if(scope.deviceId&&record.deviceId!==scope.deviceId||scope.source&&record.source!==scope.source||scope.sourceId&&p?.sourceId!==scope.sourceId)return false;
  for(const key of ['projectKey','repositoryKey','provider','sessionId'] as const)if(scope[key]&&coding?.[key]!==scope[key])return false;
  if(scope.after&&Date.parse(record.stateSeries?.samples?.at(-1)?.at??at)<Date.parse(scope.after)||scope.before&&Date.parse(at)>=Date.parse(scope.before))return false;
  if(scope.appId!==undefined&&(record.source==='media'?!record.metadata?.media?.sessions.some(s=>s.appId===scope.appId):record.appId!==scope.appId))return false;
  if(scope.collection==='activity'&&record.privacy.collection!=='activity'||scope.collection==='content'&&(record.source==='activity'||record.privacy.collection==='activity'))return false;
  return !scope.ocrStatus||record.ocr?.status===scope.ocrStatus;
}

/** Long-lived read-only service. Never stores credentials or a previous request's scope. */
export class EvidenceReader {
  readonly memories:MemoryStore;
  constructor(readonly store:Store,readonly sources:SourceStore,readonly files?:FileStore,private readonly indexer?:Indexer,private readonly fileEvidence?:FileEvidenceRequests){
    this.memories=new MemoryStore(store,ids=>this.evidence(ids),id=>Boolean(files?.isCurrentEvidence(id)||store.isCurrentEvidence(id)));
  }
  evidence(refs:string[],scope:Range={}){
    const ids=[...new Set(refs.map(parseEvidenceRef).filter(ref=>ref?.kind==='capture').map(ref=>ref!.id))];
    return [...this.store.evidence(ids),...(this.files?.evidence(ids)??[])].filter(record=>withinEvidenceScope(record,scope));
  }
  memory(ref:string,scope:Range={}){
    const parsed=parseEvidenceRef(ref);if(parsed?.kind!=='memory')return;
    const value=this.memories.page({...scope,id:parsed.id,includeStale:true,level:'detail',limit:1}).items[0];
    if(!value)return;
    // Every dependency must remain in scope, including scopes not indexed by MemoryStore.
    if(['deviceId','source','sourceId','appId','collection','projectKey','repositoryKey','provider','sessionId','after','before','ocrStatus'].some(key=>scope[key as keyof Range]!==undefined)){
      const records=this.evidence(value.evidenceIds,scope);
      if(!records.length||records.length!==new Set(value.evidenceIds).size)return;
    }
    return value;
  }
  context(records:CaptureRecord[]){return records.map(record=>{
    const nativeFile=this.files&&this.store.db.prepare('SELECT capture_id FROM file_versions WHERE capture_id=? UNION SELECT capture_id FROM file_chunks WHERE id=? LIMIT 1').get(record.id,record.id);
    const current=nativeFile?this.files!.isCurrentEvidence(record.id)||Boolean(this.store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(record.id)):record.provenance&&this.sources.getItem(record.provenance.sourceId,record.provenance.externalId)?.captureId===record.id;
    return {...record,sourceType:record.source,...(record.provenance?{revisionState:current?'current':'historical'}:{})};
  });}
  records(args:Range&{query?:string},search=false){
    const base=search&&args.query?this.store.searchPage({...args,includeTotal:false}):this.store.list({...args,includeTotal:false});
    const chunks=search&&args.query?this.files?.searchPage(args):undefined;
    const items=[...base.items,...(chunks?.items??[])].sort((a,b)=>sourceContentTime(b).localeCompare(sourceContentTime(a))||b.id.localeCompare(a.id));
    return {items,more:Boolean(base.nextCursor||chunks?.nextCursor),scanned:items.length};
  }
  search(args:Range&{query?:string}){
    if(this.indexer)return this.indexer.search(args);
    return Promise.resolve(Object.assign(this.records(args,true).items.slice(0,args.limit??50),{retrieval:{mode:'lexical',degraded:false}}));
  }
  timeline(args:Range){return this.store.list(args);}
  catalog(args:Range&{path?:string;query?:string}={}){return contextIndex(this.store,this.memories,this.sources,args);}
  fileCatalog(sourceId:string,args:Parameters<typeof browseSourceCatalog>[2]){this.sources.getSource(sourceId);return browseSourceCatalog(this.store.db,sourceId,args);}
  segments(args:Parameters<Store['archive']['page']>[0]){return this.store.archive.page(args);}
  chunks(args:Range&{id:string;offset?:number}){
    if(!this.files)return [];
    const v=this.files.version(args.id),parent=this.evidence([v.capture_id],args)[0];
    return parent?this.context(this.files.chunks(args.id,args.offset??0,30)):[];
  }
  async readFileEvidence(args:Range&{id:string;offset:number;length:number}){
    if(!this.fileEvidence||!this.evidence([args.id],args).length)return {status:'unavailable'};
    const result=await this.fileEvidence.read(args.id,args.offset,args.length);
    // Recheck after asynchronous Shadow reads; removal must not disclose a late response.
    if(!this.evidence([args.id],args).length)return {status:'unavailable'};
    return result.record?{status:'ready',record:this.context([result.record])[0]}:result;
  }
  sourceHistory(args:Range&{id:string}){
    const p=this.evidence([args.id],args)[0]?.provenance;if(!p)return [];
    return this.context(this.evidence(this.sources.history(p.sourceId,p.externalId).map(i=>i.captureId),args));
  }
  agent(options:{diagnostics:ServerDiagnostics;allowQueryImages?:()=>boolean}):ContextReader {
    const {store,sources,memories}=this,{diagnostics}=options;
    return {
      catalog:async args=>this.catalog(args),
      readImage:async ({id})=>{if(!options.allowQueryImages?.())throw new StoreError('Query image disclosure is disabled',403);const image=store.image(id);return {mimeType:image.mime,data:image.bytes.toString('base64')};},
      readFileEvidence:async args=>this.readFileEvidence(args),
      fileChunks:async args=>this.chunks(args),
      mediaActivity:async args=>diagnostics.measure('source','activity',()=>store.mediaActivity(args),result=>({count:result.observations})),
      sourceHistory:async args=>this.sourceHistory(args),
      sources:async args=>sources.listSources().filter(s=>!args.deviceId||s.deviceId===args.deviceId).map(s=>({id:s.id,name:s.name,kind:s.kind,retention:s.retention,enabled:s.enabled,status:s.status})),
      sourceItems:async args=>{const page=sources.listItems(args);return {...page,items:this.context(store.evidence(page.items.map(i=>i.captureId)))};},
      segments:async args=>store.archive.page(args) as any,
      memories:async args=>{const page=memories.page({...args,level:args.id?'detail':'overview'});return {...page,references:args.id?page.items.flatMap((m:any)=>(m.evidence??[]).map((e:any)=>({id:e.id,capturedAt:e.capturedAt,characters:e.length??0}))):[]};},
      search:async args=>diagnostics.measure('source','search',async()=>{const results=await this.search(args);return Object.assign(this.context(results),{retrieval:results.retrieval});},rows=>({count:rows.length})),timeline:async args=>diagnostics.measure('source','timeline',()=>{const page=this.timeline({...args,includeTotal:false});return {...page,items:this.context(page.items)};},page=>({count:page.items.length})),evidence:async args=>diagnostics.measure('source','evidence',()=>this.evidence(args.ids,args),rows=>({count:rows.length})),activity:async args=>diagnostics.measure('source','activity',()=>store.activity(args),result=>({count:result.captures})),devices:async()=>diagnostics.measure('source','devices',()=>store.devices(),rows=>({count:rows.length}))};
  }
}
