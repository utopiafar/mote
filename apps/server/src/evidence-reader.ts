import {scopeRecord} from './evidence-scope-record.js';
import {sourceContentTime,parseEvidenceRef,evidenceRefId,formatEvidenceRef,formatArtifactRef,parseArtifactRef,type CaptureRecord} from '@mote/shared';
import type {ContextReader} from '@mote/agent';
import {StoreError,type Store,type Range} from './store.js';
import {MemoryStore} from './memory.js';
import type {SourceStore} from './sources.js';
import type {FileStore} from './files.js';
import type {Indexer} from './indexer.js';
import type {FileEvidenceRequests} from './file-evidence.js';
import type {ServerDiagnostics} from './diagnostics.js';
import type {MaterialStore,MaterialMember,MaterialRecord} from './materials.js';
import {contextIndex} from './context-index.js';
import {browseSourceCatalog} from './source-catalog.js';

export {parseEvidenceRef} from '@mote/shared';
export function withinEvidenceScope(record:CaptureRecord,scope:Range={}) {
  const p=record.provenance,coding=p?.document?.coding,at=sourceContentTime(record);
  if(scope.deviceId&&record.deviceId!==scope.deviceId||scope.source&&record.source!==scope.source||scope.sourceId&&p?.sourceId!==scope.sourceId)return false;
  const correction=record.source==='note'?record.metadata?.memoryCorrection:undefined;
  for(const key of ['projectKey','repositoryKey','provider','sessionId'] as const)if(scope[key]&&(correction?.domain==='coding'?!correction.scopeRefs.length||correction.scopeRefs.some(ref=>ref[key]!==scope[key]):coding?.[key]!==scope[key]))return false;
  if(scope.after&&Date.parse(record.stateSeries?.samples?.at(-1)?.at??at)<Date.parse(scope.after)||scope.before&&Date.parse(at)>=Date.parse(scope.before))return false;
  if(scope.appId!==undefined&&(record.source==='media'?!record.metadata?.media?.sessions.some(s=>s.appId===scope.appId):record.appId!==scope.appId))return false;
  if(scope.collection==='activity'&&record.privacy.collection!=='activity'||scope.collection==='content'&&(record.source==='activity'||record.privacy.collection==='activity'))return false;
  return !scope.ocrStatus||record.ocr?.status===scope.ocrStatus;
}

/** Long-lived read-only service. Never stores credentials or a previous request's scope. */
export class EvidenceReader {
  readonly memories:MemoryStore;
  constructor(readonly store:Store,readonly sources:SourceStore,readonly files?:FileStore,private readonly indexer?:Indexer,private readonly fileEvidence?:FileEvidenceRequests,private readonly materials?:MaterialStore){
    this.memories=new MemoryStore(store,ids=>this.evidence(ids),id=>Boolean(materials?.isCurrentEvidence(id)||files?.isCurrentEvidence(id)||store.isCurrentEvidence(id)));
  }
  imageReference(ref:string,scope:Range={}){
    const id=evidenceRefId(ref,'capture');if(!id)return;
    const metadata=scopeRecord(this.store,id);if(!metadata||!withinEvidenceScope(metadata,scope))return;
    const value=this.store.imageReference(id);return value?{...value,id,source:metadata.source}:undefined;
  }
  evidence(refs:string[],scope:Range={}){
    const ids=[...new Set(refs.map(ref=>parseEvidenceRef(ref)).filter(ref=>ref?.kind==='capture').map(ref=>ref!.id))];
    return [...this.store.evidence(ids),...(this.materials?.evidence(ids)??[]).filter(record=>Boolean(this.scopedMaterial(record.provenance!.uri!.split('#')[0],scope))),...(this.files?.evidence(ids)??[])].filter(record=>withinEvidenceScope(record,scope));
  }
  memory(ref:string,scope:Range={}){
    const parsed=parseEvidenceRef(ref);if(parsed?.kind!=='memory')return;
    return this.memoryPage({...scope,id:parsed.id,includeStale:true,includeHistory:true,level:'detail',limit:1}).items[0];
  }
  memoryPage(args:Parameters<MemoryStore['page']>[0]&Range={}){
    const id=args.id===undefined?undefined:evidenceRefId(args.id,'memory');
    if(args.id!==undefined&&!id)return {items:[],nextCursor:null};
    const page=this.memories.page({...args,id});
    // Every dependency must remain in scope, including filters not indexed by MemoryStore.
    const scoped=['deviceId','source','sourceId','appId','collection','projectKey','repositoryKey','provider','sessionId','after','before','ocrStatus'].some(key=>args[key as keyof Range]!==undefined);
    return {...page,items:scoped?page.items.filter(value=>{
      const ids=this.store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=?').all(value.id).map(row=>String(row.evidence_id));
      const records=this.evidence(ids,args);
      return records.length>0&&records.length===ids.length;
    }):page.items};
  }
  context(records:CaptureRecord[]){return records.map(record=>{
    const nativeFile=this.files&&this.store.db.prepare('SELECT capture_id FROM file_versions WHERE capture_id=? UNION SELECT capture_id FROM file_chunks WHERE id=? LIMIT 1').get(record.id,record.id);
    const current=this.materials?.isCurrentEvidence(record.id)|| (nativeFile?this.files!.isCurrentEvidence(record.id)||Boolean(this.store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(record.id)):record.provenance&&this.sources.getItem(record.provenance.sourceId,record.provenance.externalId)?.captureId===record.id);
    return {...record,ref:formatEvidenceRef('capture',record.id),sourceType:record.source,...(record.provenance?{revisionState:current?'current':'historical'}:{})};
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
  catalog(args:Range&{path?:string;query?:string}={}){return contextIndex(this.store,{page:args=>this.memoryPage(args)},this.sources,args,args=>this.segments(args));}
  fileCatalog(sourceId:string,args:Parameters<typeof browseSourceCatalog>[2]){this.sources.getSource(sourceId);return browseSourceCatalog(this.store.db,sourceId,args);}
  private artifactMembers(id:string,revision:string,scope:Range={}){
    const pending=[{id,revision}],seen=new Set<string>(),directMembers=new Set<string>(),materialRefs=new Set<string>();
    while(pending.length){
      const ref=pending.pop()!,key=JSON.stringify(ref);if(seen.has(key))continue;seen.add(key);
      if(seen.size>1000)return;
      const row=this.store.db.prepare('SELECT revision,json FROM context_artifacts WHERE id=?').get(ref.id);
      if(!row||row.revision!==ref.revision)return;
      const value=JSON.parse(String(row.json)) as {members:string[];parents?:{id:string;revision:string}[];materialInputs?:{ref:string}[]};
      for(const member of value.members){directMembers.add(member);if(directMembers.size>1000)return;}
      for(const input of value.materialInputs??[]){materialRefs.add(input.ref);if(materialRefs.size>1000)return;}
      pending.push(...value.parents??[]);if(pending.length>1000)return;
    }
    if(!directMembers.size&&!materialRefs.size)return;
    // A material-only artifact still has original captures. The material source
    // ID can be logical (screen/state groups), so its members use the same
    // source-scope rule as material_read rather than the direct-capture rule.
    const members=new Set(directMembers);
    for(const ref of materialRefs){
      if(!this.materials)return;
      let material:MaterialRecord|undefined;
      try{material=this.materials.get(ref);}catch{return;}
      if(!material||material.ref!==ref||this.materials.get(material.id)?.revision!==material.revision||members.size+material.memberCount>1000)return;
      const scoped=this.scopedMaterial(ref,scope);if(!scoped)return;
      if(scoped.members[0]?.kind==='archive'){for(const id of this.materials.evidenceIds(ref))members.add(id);continue;}
      for(const member of scoped.members){
        const captureId=evidenceRefId(member.ref,'capture');if(!captureId)return;
        members.add(captureId);if(members.size>1000)return;
      }
    }
    let firstAt:string|undefined,lastAt:string|undefined;
    for(const member of members){
      const record=scopeRecord(this.store,member)??this.materials?.evidence([member])[0];if(!record||directMembers.has(member)&&!withinEvidenceScope(record,scope))return;
      const start=sourceContentTime(record),end=record.stateSeries?.samples.at(-1)?.at??start;
      if(scope.after&&Date.parse(start)<Date.parse(scope.after)||scope.before&&Date.parse(end)>=Date.parse(scope.before))return;
      if(!firstAt||Date.parse(start)<Date.parse(firstAt))firstAt=start;
      if(!lastAt||Date.parse(end)>Date.parse(lastAt))lastAt=end;
    }
    return {members:[...members],firstAt:firstAt!,lastAt:lastAt!};
  }
  artifact(ref:string,scope:Range={}){
    const parsed=parseArtifactRef(ref);if(!parsed)return;
    const originals=this.artifactMembers(parsed.id,parsed.revision,scope);if(!originals)return;
    const value=this.store.archive.get(parsed.id);return value?{...value,ref:formatArtifactRef(value.id,value.revision),...originals}:undefined;
  }
  segments(args:NonNullable<Parameters<Store['archive']['page']>[0]>={}){
    const parsed=args.id?.startsWith('artifact:')?parseArtifactRef(args.id):undefined;
    if(args.id?.startsWith('artifact:')&&!parsed)throw new StoreError('Invalid artifact reference');
    // Preserve scope in the cursor, then check authored times through every original dependency.
    const page=this.store.archive.page({...args,id:parsed?.id??args.id,originalTimeScope:true});
    return {...page,items:page.items.flatMap(item=>{
      if(!item||parsed&&item.revision!==parsed.revision)return [];
      const originals=this.artifactMembers(item.id,item.revision,args);if(!originals)return [];
      const {members}=originals,limit=args.id?30:3;
      return [{...item,...originals,ref:formatArtifactRef(item.id,item.revision),members:members.slice(0,limit),evidenceCount:members.length,membersTruncated:members.length>limit}];
    })};
  }
  chunks(args:Range&{id:string;offset?:number}){
    if(!this.files)return [];
    const id=evidenceRefId(args.id,'capture');if(!id)return [];
    const v=this.files.version(id),parent=this.evidence([v.capture_id],args)[0];
    return parent?this.context(this.files.chunks(id,args.offset??0,30)):[];
  }
  async readFileEvidence(args:Range&{id:string;offset:number;length:number}){
    const id=evidenceRefId(args.id,'capture');
    if(!id||!this.fileEvidence||!this.evidence([id],args).length)return {status:'unavailable'};
    const result=await this.fileEvidence.read(id,args.offset,args.length);
    // Recheck after asynchronous Shadow reads; removal must not disclose a late response.
    if(!this.evidence([id],args).length)return {status:'unavailable'};
    return result.record?{status:'ready',record:this.context([result.record])[0]}:result;
  }
  sourceHistory(args:Range&{id:string}){
    const p=this.evidence([args.id],args)[0]?.provenance;if(!p)return [];
    return this.context(this.evidence(this.sources.history(p.sourceId,p.externalId).map(i=>i.captureId),args));
  }
  /** A formal material is visible only when every original member remains in scope. */
  private scopedMaterial(ref:string,scope:Range):{material:MaterialRecord;members:MaterialMember[]}|undefined {
    const material=this.materials?.get(ref);if(!material)return;
    if(scope.sourceId&&material.origin.sourceId!==scope.sourceId)return;
    // Material source IDs are logical identities. Screen/state/authored records
    // need not carry the same ID in capture provenance.
    const archiveMember=this.materials!.members(material.ref,{limit:1}).items[0];
    if(material.memberCount===1&&archiveMember?.kind==='archive'){
      if(scope.deviceId&&scope.deviceId!==material.origin.deviceId||scope.after&&(!material.origin.firstAt||Date.parse(material.origin.firstAt)<Date.parse(scope.after))||scope.before&&(!material.origin.lastAt||Date.parse(material.origin.lastAt)>=Date.parse(scope.before))||scope.collection==='activity'||scope.appId&&scope.appId!=='mote.material'||scope.source&&scope.source!=='message'||scope.ocrStatus)return;
      for(const key of ['provider','projectKey','sessionId'] as const)if(scope[key]&&material.origin[key]!==scope[key])return;
      if(scope.repositoryKey)return;
      return {material,members:[archiveMember]};
    }
    const memberScope={...scope,sourceId:undefined};
    const members:MaterialMember[]=[];
    for(let offset=0;offset<material.memberCount;offset+=200){
      const page=this.materials!.members(material.ref,{offset,limit:200});
      for(const member of page.items){
        if(member.kind!=='capture')return;
        const id=evidenceRefId(member.ref,'capture');if(!id)return;
        const record=scopeRecord(this.store,id);
        if(!record||!withinEvidenceScope(record,memberScope))return;
        const first=sourceContentTime(record),last=record.stateSeries?.samples.at(-1)?.at??first;
        if(scope.after&&Date.parse(first)<Date.parse(scope.after)||scope.before&&Date.parse(last)>=Date.parse(scope.before))return;
        members.push(member);
      }
    }
    return members.length?{material,members}:undefined;
  }
  materialCatalog(args:Range&{sourceId?:string;kind?:string;query?:string}={}){
    if(!this.materials)return {items:[],nextCursor:null};
    const page=this.materials.list({query:args.query,sourceId:args.sourceId,kind:args.kind,deviceId:args.deviceId,after:args.after,before:args.before,limit:args.limit,cursor:args.cursor});
    return {...page,items:page.items.filter(item=>Boolean(this.scopedMaterial(item.ref,args)))};
  }
  materialRead(args:Range&{ref:string;offset?:number;length?:number}){
    const scoped=this.scopedMaterial(args.ref,args);if(!scoped||!this.materials)throw new StoreError('Material not found in selected scope',404);
    const page=this.materials.read(scoped.material.ref,{offset:args.offset,length:args.length});
    const relevant=new Set(page.spans.flatMap(span=>span.memberIds));
    if(scoped.members[0]?.kind==='archive'){const blocks=new Set(page.spans.map(span=>span.blockId));const ids=this.store.db.prepare('SELECT id,block_id FROM material_evidence WHERE material_id=? AND revision=?').all(page.material.id,page.material.revision).filter(row=>blocks.has(String(row.block_id))).map(row=>String(row.id));return {...page,originalRefs:ids.slice(0,30),originalRefsTotal:ids.length,originalRefsTruncated:ids.length>30};}
    const originals=scoped.members.filter(member=>relevant.has(member.id)).map(member=>evidenceRefId(member.ref,'capture')).filter((id):id is string=>Boolean(id));
    return {...page,originalRefs:originals.slice(0,30),originalRefsTotal:originals.length,originalRefsTruncated:originals.length>30};
  }
  agent(options:{diagnostics:ServerDiagnostics;allowQueryImages?:()=>boolean}):ContextReader {
    const {store,sources}=this,{diagnostics}=options;
    return {
      catalog:async args=>this.catalog(args),
      materialCatalog:async args=>this.materialCatalog(args),
      materialRead:async args=>this.materialRead(args),
      readImage:async ({id})=>{if(!options.allowQueryImages?.())throw new StoreError('Query image disclosure is disabled',403);const captureId=evidenceRefId(id,'capture');if(!captureId)throw new StoreError('Invalid capture reference');const image=store.image(captureId);return {mimeType:image.mime,data:image.bytes.toString('base64')};},
      readFileEvidence:async args=>this.readFileEvidence(args),
      fileChunks:async args=>this.chunks(args),
      mediaActivity:async args=>diagnostics.measure('source','activity',()=>store.mediaActivity(args),result=>({count:result.observations})),
      sourceHistory:async args=>this.sourceHistory(args),
      sources:async args=>sources.listSources().filter(s=>!args.deviceId||s.deviceId===args.deviceId).map(s=>({id:s.id,name:s.name,kind:s.kind,retention:s.retention,enabled:s.enabled,status:s.status})),
      // listItems applies calendar overlap / authored-time semantics; do not replace planned time with capture time.
      sourceItems:async args=>{const page=sources.listItems(args);return {...page,items:this.context(this.evidence(page.items.map(i=>i.captureId),{deviceId:args.deviceId}))};},
      segments:async args=>this.segments(args) as any,
      memories:async args=>{const page=this.memoryPage({...args,level:args.id?'detail':'overview'});return {...page,references:args.id?page.items.flatMap((m:any)=>(m.evidence??[]).map((e:any)=>({id:e.id,capturedAt:e.capturedAt,characters:e.length??0}))):[]};},
      search:async args=>diagnostics.measure('source','search',async()=>{const results=await this.search(args);return Object.assign(this.context(results),{retrieval:results.retrieval});},rows=>({count:rows.length})),timeline:async args=>diagnostics.measure('source','timeline',()=>{const page=this.timeline({...args,includeTotal:false});return {...page,items:this.context(page.items)};},page=>({count:page.items.length})),evidence:async args=>diagnostics.measure('source','evidence',()=>this.evidence(args.ids,args),rows=>({count:rows.length})),activity:async args=>diagnostics.measure('source','activity',()=>store.activity(args),result=>({count:result.captures})),devices:async()=>diagnostics.measure('source','devices',()=>store.devices(),rows=>({count:rows.length}))};
  }
}
