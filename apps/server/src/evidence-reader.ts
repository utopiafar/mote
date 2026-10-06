import {z} from 'zod';
import {materialDependencyStatus,type MaterialInputPin} from './material-readiness.js';
import {scopeRecord} from './evidence-scope-record.js';
import {CODING_DIALOGUE_SCHEMA_VERSION,sourceContentTime,parseEvidenceRef,evidenceRefId,formatEvidenceRef,formatArtifactRef,parseArtifactRef,sourceItemKinds,sourceTextFormat,decodeSourceText,type CaptureRecord} from '@mote/shared';
import {ContextToolError,type ContextReader} from '@mote/agent';
import {StoreError,type Store,type Range} from './store.js';
import {MemoryStore,memoryEvidenceFingerprint} from './memory.js';
import type {SourceStore} from './sources.js';
import type {FileStore} from './files.js';
import type {Indexer} from './indexer.js';
import type {FileEvidenceRequests} from './file-evidence.js';
import type {ServerDiagnostics} from './diagnostics.js';
import {materialId,type MaterialStore,type MaterialMember,type MaterialRecord} from './materials.js';
import {contextIndex} from './context-index.js';
import {browseSourceCatalog} from './source-catalog.js';
import {defaultEvidenceExposurePolicy,type EvidenceExposurePolicy,type EvidenceExposureContext,type EvidenceOperation,type EvidencePhase,type EvidenceRepresentation,type RecipeExposureRoute} from './evidence-exposure.js';
import type {SourcePipelineRuntime} from './source-pipelines.js';
import type {SourceItemRecipeCatalog} from './source-item-recipe.js';
import {createHash} from 'node:crypto';
import {ArchivedFileStore} from './archived-files.js';
import {readEvidenceImage} from './evidence-image.js';
import {fileAttachmentAvailable,fileAttachmentParent} from './file-attachments.js';
import {materialSourcePin,materialSourceCurrent,type MaterialSourcePin} from './material-source-pin.js';
import {authoredRecordProjection} from './material-organizers.js';
import type {MemoryRecipeBinding} from './memory-strategy-contract.js';
import type {ManualMemoryInputPlanRequest} from './memory-input-plans.js';

export {parseEvidenceRef} from '@mote/shared';
type ScreenOriginalGrant={kind:'material'|'segment';ref:string;scope:Range};
export function withinEvidenceScope(record:CaptureRecord,scope:Range={}) {
  const p=record.provenance,coding=p?.document?.coding,at=sourceContentTime(record);
  if(scope.deviceId&&record.deviceId!==scope.deviceId||scope.source&&record.source!==scope.source||scope.sourceId&&p?.sourceId!==scope.sourceId)return false;
  const correction=record.source==='note'?record.metadata?.memoryCorrection:undefined;
  for(const key of ['projectKey','repositoryKey','provider','sessionId'] as const)if(scope[key]&&(correction?.scopeRefs.length?correction.scopeRefs.some(ref=>ref[key]!==scope[key]):coding?.[key]!==scope[key]))return false;
  if(scope.after&&Date.parse(record.stateSeries?.samples?.at(-1)?.at??at)<Date.parse(scope.after)||scope.before&&Date.parse(at)>=Date.parse(scope.before))return false;
  if(scope.appId!==undefined&&(record.source==='media'?!record.metadata?.media?.sessions.some(s=>s.appId===scope.appId):record.appId!==scope.appId))return false;
  if(scope.collection==='activity'&&record.privacy.collection!=='activity'||scope.collection==='content'&&(record.source==='activity'||record.privacy.collection==='activity'))return false;
  return !scope.ocrStatus||record.ocr?.status===scope.ocrStatus;
}

/** Long-lived read-only service. Never stores credentials or a previous request's scope. */
export class EvidenceReader {
  readonly memories:MemoryStore;
  private readonly archivedFiles:ArchivedFileStore;
  constructor(readonly store:Store,readonly sources:SourceStore,readonly files?:FileStore,private readonly indexer?:Indexer,private readonly fileEvidence?:FileEvidenceRequests,private readonly materials?:MaterialStore,private readonly sourcePipelines?:SourcePipelineRuntime,private readonly sourceItemRecipes?:SourceItemRecipeCatalog,private readonly materialMemoryReady?:(ref:string)=>boolean){
    this.archivedFiles=new ArchivedFileStore(store);
    // Memory dependencies must use the canonical Material anchor. The query
    // projection below decorates it with source metadata for display and must
    // not replace its identity when validating a durable dependency.
    this.memories=new MemoryStore(store,ids=>[...store.evidence(ids),...(materials?.evidence(ids)??[]),...(files?.evidence(ids)??[])],id=>Boolean(materials?.isCurrentEvidence(id)||files?.isCurrentEvidence(id)||store.isCurrentEvidence(id)));
  }
  imageReference(ref:string,scope:Range={}){
    const id=evidenceRefId(ref,'capture');if(!id)return;
    const metadata=scopeRecord(this.store,id);if(!metadata||!withinEvidenceScope(metadata,scope))return;
    const value=this.store.imageReference(id);return value?{...value,id,source:metadata.source}:undefined;
  }
  evidence(refs:string[],scope:Range={}){
    return this.readEvidence(refs,scope,false);
  }
  private evidenceById(ids:string[],scope:Range={}){return this.evidence(ids.map(id=>formatEvidenceRef('capture',z.string().uuid().parse(id))),scope);}
  /** Owner archive views may inspect retained old quotes; model tools stay current-only. */
  archivedEvidence(refs:string[],scope:Range={}){
    return this.readEvidence(refs,scope,true);
  }
  private readEvidence(refs:string[],scope:Range,includeHistorical:boolean){
    const ids=[...new Set(refs.map(ref=>parseEvidenceRef(ref)).filter(ref=>ref?.kind==='capture').map(ref=>ref!.id))];
    const materialRecords=(this.materials?.evidence(ids)??[]).flatMap(record=>{
      const ref=record.provenance?.uri?.split('#')[0];if(!ref)return [];
      const prior=this.materials?.get(ref),current=prior&&this.materials?.get(prior.id);
      const active=current&&this.currentMaterialAnchor(record,current);
      const material=active?current:includeHistorical?prior:undefined;
      if(!material||!this.scopedMaterial(material.ref,scope))return [];
      const selected=active??record;
      const head=this.materialHead(material,scope);
      return [head?this.materialCard(material,head,undefined,selected)??selected:selected];
    });
    return [...this.store.evidence(ids),...materialRecords,...(this.files?.evidence(ids)??[])].filter(record=>withinEvidenceScope(record,scope));
  }
  /** An unchanged block can reuse an anchor created by an earlier revision. Bind
   * it to the active block in the current head before exposing it to a model. */
  private currentMaterialAnchor(record:CaptureRecord,current:MaterialRecord):CaptureRecord|undefined {
    if(!this.materials?.isCurrentEvidence(record.id)||!record.provenance?.uri)return;
    const oldRef=record.provenance.uri.split('#')[0];
    const active=this.store.db.prepare(`SELECT b.block_id,p.text FROM material_block_versions b
      JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.anchor_id=?
        AND b.from_sequence<=? AND (b.until_sequence IS NULL OR b.until_sequence>?)
      UNION ALL SELECT b.block_id,p.text FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
        WHERE b.material_id=? AND b.revision=? AND b.anchor_id=? LIMIT 1`)
      .get(current.id,record.id,current.sequence,current.sequence,current.id,current.revision,record.id) as {block_id:string;text:string}|undefined;
    if(oldRef!==current.ref&&!active)return;
    return {...record,ocrText:active?.text??record.ocrText,windowTitle:current.title,appName:current.title,
      provenance:{...record.provenance,revision:current.revision,
        uri:`${current.ref}#${active?.block_id??record.provenance.uri.slice(oldRef.length+1)}`}};
  }
  memory(ref:string,scope:Range={},ownerArchive=false){
    const parsed=parseEvidenceRef(ref);if(parsed?.kind!=='memory')return;
    return this.memoryPage({...scope,id:ref,includeStale:true,includeHistory:true,level:'detail',limit:1},ownerArchive).items[0];
  }
  memoryPage(args:Parameters<MemoryStore['page']>[0]&Range={},ownerArchive=false){
    const id=args.id===undefined?undefined:evidenceRefId(args.id,'memory');
    if(args.id!==undefined&&!id)return {items:[],nextCursor:null};
    const page=this.memories.page({...args,id});
    // Every dependency must remain in scope, including filters not indexed by MemoryStore.
    const scoped=['deviceId','source','sourceId','appId','collection','projectKey','repositoryKey','provider','sessionId','after','before','ocrStatus'].some(key=>args[key as keyof Range]!==undefined);
    return {...page,items:scoped?page.items.filter(value=>{
      const ids=this.store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=?').all(value.id).map(row=>String(row.evidence_id));
      const records=ownerArchive?this.archivedEvidence(ids.map(id=>formatEvidenceRef('capture',id)),args):this.evidenceById(ids,args);
      return records.length>0&&records.length===ids.length;
    }):page.items};
  }
  context(records:CaptureRecord[]){return records.map(record=>{
    const formal=this.materials&&this.store.db.prepare('SELECT 1 FROM material_evidence WHERE id=?').get(record.id);
    const nativeFile=this.files&&this.store.db.prepare('SELECT capture_id FROM file_versions WHERE capture_id=? UNION SELECT capture_id FROM file_chunks WHERE id=? LIMIT 1').get(record.id,record.id);
    const current=formal?this.materials!.isCurrentEvidence(record.id):nativeFile?this.files!.isCurrentEvidence(record.id)||Boolean(this.store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(record.id)):record.provenance?.externalId&&this.sources.getItem(record.provenance.sourceId,record.provenance.externalId)?.captureId===record.id;
    // The built-in organizer declares these JSON wrappers. Neither raw capture
    // prose nor a custom organizer acquires a presentation type by looking like JSON.
    let evidencePresentation:ReturnType<typeof sourceTextFormat>;
    const ref=formal&&record.provenance?.uri?.split('#')[0],material=ref?this.materials!.get(ref):undefined;
    if(material&&material.schemaVersion===1&&sourceItemKinds.some(kind=>material.kind==='mote.'+kind)&&
      this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_organizer_groups'").get()){
      const owners=this.store.db.prepare('SELECT organizer_id,version FROM material_organizer_groups WHERE material_id=? AND active=1').all(material.id);
      if(owners.length===1&&owners[0].organizer_id==='mote.source-item'&&['9','10','11'].includes(String(owners[0].version))){
        const block=this.store.db.prepare(`SELECT b.block_id,b.format,b.locator,p.text FROM material_blocks b
          JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.revision=? AND b.anchor_id=?`).get(material.id,material.revision,record.id);
        if(block&&block.text===record.ocrText){
          const format=sourceTextFormat({id:String(block.block_id),format:typeof block.format==='string'?block.format:undefined,...(block.locator?{locator:JSON.parse(String(block.locator))}:{} )});
          if(format&&decodeSourceText(format,record.ocrText))evidencePresentation=format;
        }
      }
    }
    return {...record,ref:formatEvidenceRef('capture',record.id),sourceType:record.source,...(record.provenance?{revisionState:current?'current':'historical'}:{}),evidencePresentation};
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
    const pending=[{id,revision}],seen=new Set<string>(),directMembers=new Set<string>(),materialRefs=new Map<string,{ref:string;offset?:number;length?:number}[]>();
    while(pending.length){
      const ref=pending.pop()!,key=JSON.stringify(ref);if(seen.has(key))continue;seen.add(key);
      if(seen.size>1000)return;
      const row=this.store.db.prepare('SELECT revision,json FROM context_artifacts WHERE id=?').get(ref.id);
      if(!row||row.revision!==ref.revision)return;
      const value=JSON.parse(String(row.json)) as {members:string[];parents?:{id:string;revision:string}[];materialInputs?:{ref:string;offset?:number;length?:number}[]};
      for(const member of value.members){directMembers.add(member);if(directMembers.size>1000)return;}
      for(const input of value.materialInputs??[]){const pages=materialRefs.get(input.ref)??[];pages.push(input);materialRefs.set(input.ref,pages);if(materialRefs.size>1000||pages.length>1000)return;}
      pending.push(...value.parents??[]);if(pending.length>1000)return;
    }
    if(!directMembers.size&&!materialRefs.size)return;
    // A material-only artifact still has original captures. The material source
    // ID can be logical (screen/state groups), so its members use the same
    // source-scope rule as material_read rather than the direct-capture rule.
    const members=new Set(directMembers),archiveTimes=new Map<string,{firstAt?:string;lastAt?:string}>();
    for(const [ref,inputs] of materialRefs){
      if(!this.materials)return;
      let material:MaterialRecord|undefined;
      try{material=this.materials.get(ref);}catch{return;}
      if(!material||material.ref!==ref||this.materials.get(material.id)?.revision!==material.revision||members.size+material.memberCount>1000)return;
      const scoped=this.scopedMaterial(ref,scope);if(!scoped)return;
      if(scoped.members[0]?.kind==='archive'){
        const add=(id:string)=>{members.add(id);archiveTimes.set(id,{firstAt:material.origin.firstAt,lastAt:material.origin.lastAt});};
        if(material.kind==='mote.coding-session'&&inputs.every(input=>Number.isSafeInteger(input.offset)&&Number.isSafeInteger(input.length))){
          for(const input of inputs){let page;try{page=this.materials.read(ref,{offset:input.offset,length:input.length});}catch{return;}
            for(const span of page.spans){if(!span.evidenceId)return;add(span.evidenceId);if(members.size>1000)return;}}
        }else for(const id of this.materials.evidenceIds(ref)){add(id);if(members.size>1000)return;}
        continue;
      }
      for(const member of scoped.members){
        const captureId=evidenceRefId(member.ref,'capture');if(!captureId)return;
        members.add(captureId);if(members.size>1000)return;
      }
    }
    let firstAt:string|undefined,lastAt:string|undefined;
    for(const member of members){
      const record=scopeRecord(this.store,member)??this.materials?.evidence([member])[0];if(!record||directMembers.has(member)&&!withinEvidenceScope(record,scope))return;
      const time=archiveTimes.get(member),start=time?.firstAt??sourceContentTime(record),end=time?.lastAt??record.stateSeries?.samples.at(-1)?.at??start;
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
    const v=this.files.version(id),parent=this.evidenceById([v.capture_id],args)[0];
    return parent?this.context(this.files.chunks(id,args.offset??0,30)):[];
  }
  async readFileEvidence(args:Range&{id:string;offset:number;length:number}){
    const id=evidenceRefId(args.id,'capture');
    if(!id||!this.fileEvidence||!this.evidenceById([id],args).length)return {status:'unavailable'};
    const result=await this.fileEvidence.read(id,args.offset,args.length);
    // Recheck after asynchronous Shadow reads; removal must not disclose a late response.
    if(!this.evidenceById([id],args).length)return {status:'unavailable'};
    return result.record?{status:'ready',record:this.context([result.record])[0]}:result;
  }
  sourceHistory(args:Range&{id:string}){
    const id=evidenceRefId(args.id,'capture');if(!id)return [];const p=this.evidenceById([id],args)[0]?.provenance;if(!p)return [];
    const materialRef=p.uri?.startsWith('material:')?p.uri.split('#')[0]:undefined;
    const material=materialRef?this.materials?.get(materialRef):undefined;
    const sourceId=material?.origin.sourceId??p.sourceId,externalId=material?.origin.externalId??p.externalId;
    return this.context(this.evidenceById(this.sources.history(sourceId,externalId).map(i=>i.captureId),args));
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
      for(const key of ['provider','projectKey','repositoryKey','sessionId'] as const)if(scope[key]&&material.origin[key]!==scope[key])return;
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
  /** A manual selection names fixed originals and recipes, including inputs
   * still being processed. It never authorizes a later range rescan. */
  memoryPlanSelection(scope:Range,bindings:readonly MemoryRecipeBinding[],policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy,evidenceIds?:readonly string[],maximum=20000){
    const manualPlans:ManualMemoryInputPlanRequest[]=[],raw=new Set<string>(),unavailable:string[]=[],materialOriginals=new Set<string>();
    const addMaterial=(material:MaterialRecord,allowList?:string[])=>{
      const scoped=this.scopedMaterial(material.ref,scope);
      if(!scoped||!this.materialPlanAllowed(material.id,policy)){unavailable.push(material.ref);return;}
      const sourcePin=materialSourcePin(this.store,this.materials!,material,this.sourcePipelines?.archive);
      for(const strategy of bindings){
        const required=[...(strategy.requires??this.sourcePipelines?.memoryWork.sourceRequirements(material.ref)??['material'])];
        manualPlans.push({materialId:material.id,selectedRef:material.ref,sourcePin,strategy,required,...(allowList?{evidenceAllowList:allowList}:{})});
      }
      // Only the built-in authored projection is known to represent this one
      // entire original. Other Materials may cover only part of a member.
      const original=this.authoredMaterialOriginal(material);
      if(original)materialOriginals.add(original.id);
      if(manualPlans.length>2000||manualPlans.length+raw.size>maximum)throw new StoreError('Choose a smaller range or fewer recipes for memory extraction',413);
    };
    if(evidenceIds){
      const selected=new Map<string,{material:MaterialRecord;ids:string[]}>();
      for(const id of new Set(evidenceIds)){
        const record=this.memories.readEvidence([id])[0];
        if(!record||!withinEvidenceScope(record,scope)||!this.memories.isCurrentEvidence(id))throw new StoreError('Selected evidence is missing or outside the selected range',409);
        const anchor=this.materials&&this.store.db.prepare('SELECT material_id FROM material_evidence WHERE id=?').get(id);
        const material=anchor?this.materials!.get(String(anchor.material_id)):undefined;
        if(material){const entry=selected.get(material.id)??{material,ids:[]};entry.ids.push(id);selected.set(material.id,entry);}
        else raw.add(id);
      }
      for(const {material,ids} of selected.values())addMaterial(material,ids);
      for(const id of materialOriginals)raw.delete(id);
    }else{
      let cursor:string|undefined;
      do{const page=this.materialCatalog({...scope,cursor,limit:100});for(const material of page.items)addMaterial(material);cursor=page.nextCursor??undefined;}while(cursor);
      // Legacy capture-only records retain their existing admission boundary.
      // Formal materials above must not also be sent as raw source items.
      do{const page=this.store.list({...scope,cursor,limit:200});
        for(const record of page.items){
          if(materialOriginals.has(record.id)||this.sourceItemMaterial(record,scope)||record.provenance?.document?.coding)continue;
          if(record.provenance?.sourceId&&record.source!=='screen'&&record.source!=='ui_page'&&this.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(record.provenance.sourceId))continue;
          if(bindings.every(binding=>binding.requires!==undefined)||record.ocr?.status==='pending'||record.ocr?.status==='failed')continue;
          if(record.ocrText.length&&this.memories.isCurrentEvidence(record.id)&&record.provenance?.layer!=='reference'&&record.provenance?.document?.fileIndex?.coverage!=='lightweight'&&this.captureExposure(record,'memory',policy,'capture',true))raw.add(record.id);
          if(manualPlans.length+raw.size>maximum)throw new StoreError('Choose a smaller range for memory extraction',413);
        }
        cursor=page.nextCursor??undefined;
      }while(cursor);
    }
    return {manualPlans,evidenceIds:[...raw],unavailable};
  }
  /** Legacy selection admits ready inputs. Explicit manual recipes use the
   * independent, durable plans above; automatic jobs have their own queue. */
  memorySelection(scope:Range={}, maximum=20000,policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy,requirements:readonly (readonly string[]|undefined)[]=[undefined]){
    const ids=new Set<string>(),waiting:string[]=[],unavailable:string[]=[],materialOriginals=new Set<string>();
    const add=(id:string)=>{const record=this.memories.readEvidence([id])[0];
      if(record&&withinEvidenceScope(record,scope)&&this.memories.isCurrentEvidence(id)&&record.ocrText.length&&record.provenance?.layer!=='reference'&&record.provenance?.document?.fileIndex?.coverage!=='lightweight')ids.add(id);
      if(ids.size>maximum)throw new StoreError('Choose a smaller range for memory extraction',413);
    };
    let cursor:string|undefined;
    do{const page=this.materialCatalog({...scope,cursor,limit:100});
      for(const material of page.items){
        const selections=requirements.map(required=>({required,input:required?this.materials!.input(material.ref,required):undefined}));
        if(selections.some(({required})=>!this.materialAllowedForMemory(material.ref,policy,required))){
          const pending=selections.some(({required,input})=>required?input?.dependencies.some(d=>d.state==='pending'):material.coverage.state!=='complete');
          (pending?waiting:unavailable).push(material.ref);continue;
        }
        const scoped=this.scopedMaterial(material.ref,scope),original=this.authoredMaterialOriginal(material);
        if(original)materialOriginals.add(original.id);
        const anchors=[...new Set(selections.flatMap(({input})=>input?.evidenceIds??this.materials!.evidenceIds(material.ref)))];
        if(anchors.length){anchors.forEach(add);continue;}
        for(const member of scoped?.members??[]){const id=evidenceRefId(member.ref,'capture');if(id)add(id);}
      }
      cursor=page.nextCursor??undefined;
    }while(cursor);
    cursor=undefined;
    do{const page=this.store.list({...scope,cursor,limit:200});
      for(const record of page.items){
        if(materialOriginals.has(record.id)||this.sourceItemMaterial(record,scope)||record.provenance?.document?.coding)continue;
        if(record.provenance?.sourceId&&record.source!=='screen'&&record.source!=='ui_page'&&this.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(record.provenance.sourceId))continue;
        if(requirements.some(required=>required!==undefined)){unavailable.push(record.id);continue;}
        if(record.ocr?.status==='pending'){waiting.push(record.id);continue;}
        if(record.ocr?.status==='failed'){unavailable.push(record.id);continue;}
        if(this.captureExposure(record,'memory',policy,'capture',true))add(record.id);
      }
      cursor=page.nextCursor??undefined;
    }while(cursor);
    return {evidenceIds:[...ids],waiting,unavailable};
  }
  materialRead(args:Range&{ref:string;offset?:number;length?:number}){
    const scoped=this.scopedMaterial(args.ref,args);if(!scoped||!this.materials)throw new StoreError('Material not found in selected scope',404);
    const page=this.materials.read(scoped.material.ref,{offset:args.offset,length:args.length});
    const relevant=new Set(page.spans.flatMap(span=>span.memberIds));
    if(scoped.members[0]?.kind==='archive'){
      const blocks=[...new Set(page.spans.map(span=>span.blockId))];
      const ids=blocks.length?this.store.db.prepare(`SELECT anchor_id FROM material_block_versions WHERE material_id=?
        AND from_sequence<=? AND (until_sequence IS NULL OR until_sequence>?)
        AND block_id IN (${blocks.map(()=>'?').join(',')}) AND anchor_id IS NOT NULL ORDER BY idx`)
        .all(page.material.id,page.material.sequence,page.material.sequence,...blocks).map(row=>String(row.anchor_id)):[];
      return {...page,originalRefs:ids.slice(0,30).map(id=>formatEvidenceRef('capture',id)),originalRefsTotal:ids.length,originalRefsTruncated:ids.length>30};
    }
    const originals=scoped.members.filter(member=>relevant.has(member.id)).map(member=>evidenceRefId(member.ref,'capture')).filter((id):id is string=>Boolean(id));
    return {...page,originalRefs:originals.slice(0,30).map(id=>formatEvidenceRef('capture',id)),originalRefsTotal:originals.length,originalRefsTruncated:originals.length>30};
  }
  private sourceKind(sourceId:string|undefined,fallback:string){
    if(!sourceId)return fallback;
    try{return this.sources.getSource(sourceId).kind;}catch{return fallback;}
  }
  private materialKind(material:MaterialRecord){
    const builtin=material.kind==='mote.screen-segment'?'screen':material.kind==='mote.coding-session'?'coding-agent':'material';
    return this.sourceKind(material.origin.sourceId,builtin);
  }
  private recipeRoutes(sourceKind:string,sourceId:string|undefined):readonly RecipeExposureRoute[]|undefined {
    const runtime=this.sourcePipelines;
    if(!sourceId)return runtime?.registry.declared(sourceKind)?[]:undefined;
    let source;
    try{source=this.sources.getSource(sourceId);}catch{return runtime?.registry.declared(sourceKind)?[]:undefined;}
    try{
      const pipeline=runtime?.select(source);
      if(pipeline?.recipe){
        const recipe=runtime!.recipes.resolve(pipeline.recipe.id,pipeline.recipe.version);
        return recipe.definition.accepts.sourceKind===source.kind?recipe.definition.exposure.routes:[];
      }
      if(pipeline?.storage==='archive')return [];
      if(this.sourceItemRecipes)return this.sourceItemRecipes.routesForSourceId(sourceId);
      return runtime?.registry.declared(sourceKind)?[]:undefined;
    }catch{return [];}
  }
  private exposureAllows(context:EvidenceExposureContext,policy:EvidenceExposurePolicy,screenOriginalGrant=false){
    return policy.allows(context,this.recipeRoutes(context.sourceKind,context.sourceId),screenOriginalGrant);
  }
  /** Owner deletion rules carry derived text, not a grant to seed raw originals.
   * Check their retained lineage against current source revocation. */
  deletionContextAllowed(id:string,policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy):boolean {
    const record=this.memories.readEvidence([id])[0];if(!record)return false;
    if(!fileAttachmentAvailable(this.store,id))return false;
    const p=record.provenance;
    if(p?.sourceId&&p.externalId&&this.store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(p.sourceId,p.externalId)?.deleted)return false;
    const anchor=this.materials&&this.store.db.prepare('SELECT material_id FROM material_evidence WHERE id=?').get(id);
    const material=anchor?this.materials?.get(String(anchor.material_id)):p?.sourceId&&p.externalId&&this.materials?this.materials.get(materialId(p.sourceId,p.externalId)):undefined;
    if(material)return this.materialExposure(material,'expand',policy)&&policy.allows({sourceKind:this.materialKind(material),sourceId:material.origin.sourceId,representation:'material',operation:'expand',phase:material.coverage.state});
    return this.captureExposure(record,'expand',policy,'capture',true);
  }
  private materialMembersAvailable(material:MaterialRecord):boolean {
    if(!this.materials)return false;
    for(let offset=0;offset<material.memberCount;offset+=200){
      const page=this.materials.members(material.ref,{offset,limit:200});
      if(!page.items.length)return false;
      for(const member of page.items){
        if(member.kind==='capture'){
          const id=evidenceRefId(member.ref,'capture');if(!id||!fileAttachmentAvailable(this.store,id))return false;
        }
      }
    }
    return true;
  }
  private captureExposure(record:CaptureRecord,operation:EvidenceOperation,policy:EvidenceExposurePolicy,representation:EvidenceRepresentation='capture',screenOriginalGrant=false){
    if(!fileAttachmentAvailable(this.store,record.id))return false;
    const provenance=record.provenance,materialRef=provenance?.uri?.startsWith('material:')?provenance.uri.split('#')[0]:undefined;
    const material=materialRef?this.materials?.get(materialRef):undefined;
    if(materialRef){
      // A pinned old Material body remains in the owner archive, but a model
      // can read only anchors still active in the current formal revision.
      // Coding append keeps unchanged prefix anchors active across revisions.
      if(!material)return false;
      const current=this.materials?.get(material.id);
      return Boolean(current&&this.materials?.isCurrentEvidence(record.id)&&this.materialExposure(current,operation,policy));
    }
    // A tombstone revokes model access to every historical revision of that
    // source item. Owner archive/history APIs can still inspect those bytes.
    if(provenance?.sourceId&&provenance.externalId){
      const head=this.store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?')
        .get(provenance.sourceId,provenance.externalId) as {deleted:number}|undefined;
      if(head?.deleted)return false;
    }
    const sourceKind=record.source==='screen'||record.source==='ui_page'?'screen':provenance?.document?.coding?'coding-agent':this.sourceKind(provenance?.sourceId,record.source);
    const phase:EvidencePhase=record.ocr?.status==='pending'?'pending':record.ocr?.status==='failed'?'partial':'complete';
    return this.exposureAllows({sourceKind,sourceId:provenance?.sourceId,representation,operation,phase},policy,screenOriginalGrant);
  }
  /** The built-in authored organizer binds a logical Material to one current
   * owner capture. A string prefix alone is never an authorization claim. */
  private authoredMaterialOriginal(material:MaterialRecord):CaptureRecord|undefined {
    if(!this.materials||material.memberCount!==1)return;
    if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_organizer_groups'").get())return;
    const owners=this.store.db.prepare('SELECT organizer_id,version,group_json FROM material_organizer_groups WHERE material_id=? AND active=1').all(material.id) as
      {organizer_id:string;version:string;group_json:string}[];
    if(owners.length!==1||owners[0].organizer_id!=='mote.authored-record'||!['2','3'].includes(owners[0].version))return;
    let group:{deviceId?:unknown;captureId?:unknown};
    try{group=JSON.parse(owners[0].group_json);}catch{return;}
    if(typeof group.deviceId!=='string'||typeof group.captureId!=='string')return;
    const expectedSource='authored:'+createHash('sha256').update(JSON.stringify(group.deviceId)).digest('hex');
    if(material.origin.sourceId!==expectedSource||material.origin.externalId!==group.captureId||
      material.origin.deviceId!==group.deviceId||material.id!==materialId(expectedSource,group.captureId))return;
    const members=this.materials.members(material.ref,{limit:2}).items;
    if(members.length!==1||members[0].kind!=='capture'||evidenceRefId(members[0].ref,'capture')!==group.captureId)return;
    const original=this.store.evidence([group.captureId])[0];
    if(!original||!this.store.isCurrentEvidence(original.id)||original.deviceId!==group.deviceId||
      original.provenance||material.kind!==`mote.${original.source}`)return;
    return original;
  }
  private materialExposure(material:MaterialRecord,operation:EvidenceOperation,policy:EvidenceExposurePolicy,required?:readonly string[],planning=false){
    // Retain legacy projections for owner inspection without exposing process
    // text to models. Installing new rules does not rebuild historical data.
    if(material.kind==='mote.coding-session'&&material.schemaVersion<CODING_DIALOGUE_SCHEMA_VERSION)return false;
    if(!this.materialMembersAvailable(material))return false;
    if(!planning&&required&&!this.materials?.input(material.ref,required)?.ready)return false;
    if(operation==='memory'&&this.sourceItemRecipes){
      const original=this.authoredMaterialOriginal(material);
      if(original){
        if(!this.captureExposure(original,'memory',policy))return false;
      }else{
        try{
          const source=this.sources.getSource(material.origin.sourceId),pipeline=this.sourcePipelines?.select(source);
          if(!planning&&!required){
            if(pipeline&&!materialDependencyStatus(material,this.sourcePipelines!.options(source.id).memoryDependencies??pipeline.memoryDependencies??['material']).ready)return false;
            if(!pipeline?.recipe&&pipeline?.storage!=='archive'&&!this.materialMemoryReady?.(material.ref))return false;
          }
        }catch{return false;}
      }
    }
    const phase=planning?'complete':required&&material.coverage.state==='pending'?'partial':material.coverage.state;
    return this.exposureAllows({sourceKind:this.materialKind(material),sourceId:material.origin.sourceId,representation:'material',operation,phase},policy);
  }
  /** Memory runners can inspect a material only after its declared route admits the current phase. */
  materialAllowedForMemory(ref:string,policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy,required?:readonly string[]){
    const material=this.materials?.get(ref);return Boolean(material&&this.materials?.get(material.id)?.ref===material.ref&&this.materialExposure(material,'memory',policy,required));
  }
  /** Planning checks permission to derive after readiness; no original content
   * is disclosed by admitting a waiting plan. Actual batches recheck readiness. */
  materialPlanAllowed(id:string,policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy):boolean {
    const material=this.materials?.get(id);
    return Boolean(material&&this.materialExposure(material,'memory',policy,undefined,true));
  }
  materialSourceCurrent(pin:MaterialSourcePin,id:string):boolean {
    return Boolean(this.materials&&materialSourceCurrent(this.store,this.materials,pin,id,this.sourcePipelines?.archive));
  }
  private agentSegments(input:Parameters<Store['archive']['page']>[0],policy:EvidenceExposurePolicy,operation:EvidenceOperation='discover'){
    const args=input??{};
    const page=this.segments(args);
    return {...page,items:page.items.filter(item=>{
      const originals=this.artifactMembers(item.id,item.revision,args);if(!originals)return false;
      const phase:EvidencePhase=item.metadata?.complete===true?'complete':'partial';
      return originals.members.every(id=>{
        const record=scopeRecord(this.store,id)??this.materials?.evidence([id])[0];
        if(!record)return false;
        const anchor=this.materials&&this.store.db.prepare('SELECT material_id FROM material_evidence WHERE id=?').get(id);
        const material=anchor&&this.materials?.get(String(anchor.material_id));
        if(material?.kind==='mote.coding-session'&&material.schemaVersion<CODING_DIALOGUE_SCHEMA_VERSION)return false;
        const sourceKind=record.source==='screen'||record.source==='ui_page'?'screen':record.provenance?.document?.coding?'coding-agent':this.sourceKind(record.provenance?.sourceId,record.source);
        return this.exposureAllows({sourceKind,sourceId:record.provenance?.sourceId,representation:'segment',operation,phase},policy);
      });
    })};
  }
  /** An ordinary source item is represented by its Material only after the
   * published revision includes the current source head. A newer receipt is
   * still discoverable as raw evidence while its organizer job catches up. */
  private sourceItemMaterial(record:CaptureRecord,scope:Range):MaterialRecord|undefined {
    const original=(record as CaptureRecord&{fileEvidence?:{captureId:string}}).fileEvidence?.captureId??record.id;
    const linked=fileAttachmentParent(this.store,original),p=linked?.record.provenance??record.provenance;
    if(!this.materials||!p||p.document?.coding||p.uri?.startsWith('material:'))return;
    try{
      const head=this.sources.getItem(p.sourceId,p.externalId);
      const parent=linked?.record.id??original;
      if(!head||head.deleted||head.captureId!==parent)return;
      const material=this.materials.get(materialId(p.sourceId,p.externalId));
      if(!material||material.origin.sourceId!==p.sourceId||material.origin.externalId!==p.externalId)return;
      return this.materialHead(material,scope)?.id===head.captureId?material:undefined;
    }catch{return;}
  }
  /** Owner navigation uses current stored anchor or source-head relationships.
   * Neither an upstream URI nor captured prose can name another Material. */
  currentMemoryMaterialRef(record:CaptureRecord):string|undefined {
    const anchor=this.materials&&this.store.db.prepare('SELECT material_id FROM material_evidence WHERE id=?').get(record.id);
    if(anchor){const material=this.materials!.get(String(anchor.material_id));return material&&this.materials!.isCurrentEvidence(record.id)?material.ref:undefined;}
    return this.sourceItemMaterial(record,{})?.ref;
  }
  private materialHead(material:MaterialRecord,scope:Range):CaptureRecord|undefined {
    if(!this.materials||material.memberCount>101||!this.scopedMaterial(material.ref,scope))return;
    try{
      const head=this.sources.getItem(material.origin.sourceId,material.origin.externalId);
      if(!head||head.deleted)return;
      const members=this.materials.members(material.ref,{limit:200}).items;
      if(members.length!==material.memberCount||!members.some(member=>member.kind==='capture'&&evidenceRefId(member.ref,'capture')===head.captureId))return;
      for(const member of members){const id=member.kind==='capture'&&evidenceRefId(member.ref,'capture');if(!id||id!==head.captureId&&fileAttachmentParent(this.store,id)?.record.id!==head.captureId)return;}
      const record=scopeRecord(this.store,head.captureId,true);
      return record&&withinEvidenceScope(record,scope)?record:undefined;
    }catch{return;}
  }
  private materialCard(material:MaterialRecord,head:CaptureRecord,query?:string,selected?:CaptureRecord):CaptureRecord|undefined {
    if(!this.materials)return;
    const candidates=selected?[selected]:this.materials.evidence(this.materials.evidenceIds(material.ref).filter(id=>this.materials!.isCurrentEvidence(id)).slice(0,query?64:1))
      .flatMap(record=>{const current=this.currentMaterialAnchor(record,material);return current?[current]:[];});
    const needle=query?.trim().toLocaleLowerCase();
    const anchor=selected??(needle?candidates.find(row=>row.ocrText.toLocaleLowerCase().includes(needle))??candidates[0]:candidates[0]);
    if(!anchor||!anchor.provenance?.uri||!head.provenance)return;
    const p=head.provenance;
    return {...anchor,deviceId:head.deviceId,deviceName:head.deviceName,platform:head.platform,
      capturedAt:head.capturedAt,durationMs:head.durationMs,source:head.source,appId:head.appId,appName:head.appName,
      windowTitle:material.title,privacy:head.privacy,
      provenance:{sourceId:p.sourceId,externalId:p.externalId,revision:p.revision,layer:'derived',deleted:false,
        uri:anchor.provenance.uri,...(p.calendar?{calendar:p.calendar}:{}),...(p.document?{document:p.document}:{})}};
  }
  private materialView(material:MaterialRecord,scope:Range,query?:string):CaptureRecord|undefined {
    const scoped=this.scopedMaterial(material.ref,scope);if(!scoped||!this.materials)return;
    const head=this.materialHead(material,scope);
    if(head)return this.materialCard(material,head,query);
    // Coding sessions and compressed screen groups have no single SourceStore
    // head. Their text anchors are already derived, pinned Material evidence.
    const anchors=this.materials.evidence(this.materials.evidenceIds(material.ref).filter(id=>this.materials!.isCurrentEvidence(id)).slice(0,64));
    const needle=query?.trim().toLocaleLowerCase();
    const selected=(needle?anchors.find(row=>row.ocrText.toLocaleLowerCase().includes(needle)):undefined)??anchors[0];
    const anchor=selected&&this.currentMaterialAnchor(selected,material);
    if(!anchor||!anchor.provenance?.uri)return;
    return {...anchor,source:material.kind==='mote.screen-segment'?'screen':anchor.source,
      windowTitle:material.title,appName:material.title,
      provenance:{...anchor.provenance,externalId:material.origin.externalId,layer:'derived'}};
  }
  private materialIndexedForQuery(material:MaterialRecord,query:string){
    if(material.coverage.reason==='source_evidence_changed')return false;
    const row=this.store.db.prepare(`SELECT h.rowid AS rowid FROM material_heads h JOIN material_searchable s ON s.material_id=h.id
      WHERE h.id=? AND h.revision=? AND h.retired=0`).get(material.id,material.revision) as {rowid:number}|undefined;
    if(!row)return false;
    for(const term of query.trim().split(/\s+/u).filter(Boolean)){
      const matched=[...term].length>=3?
        this.store.db.prepare('SELECT 1 FROM material_fts WHERE rowid=? AND material_fts MATCH ?').get(row.rowid,'"'+term.replaceAll('"','""')+'"'):
        this.store.db.prepare(`SELECT 1 FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
          WHERE b.material_id=? AND b.revision=? AND instr(p.text,?)>0 LIMIT 1`).get(material.id,material.revision,term);
      if(!matched)return false;
    }
    return true;
  }
  /** Stateless, scope-bound model query pages. Formal Materials are visited first,
   * then current raw captures, then unassembled file chunks. Every candidate is
   * checked against the same query audience policy before it enters a page. */
  queryPage(args:Range&{query?:string},mode:'browse'|'search'|'retrieve'='search'){
    const query=args.query?.trim().normalize('NFC')??'',limit=Math.min(100,Math.max(1,args.limit??30));
    const scope={mode,query,sourceId:args.sourceId,projectKey:args.projectKey,repositoryKey:args.repositoryKey,
      provider:args.provider,sessionId:args.sessionId,after:args.after?new Date(args.after).toISOString():undefined,
      before:args.before?new Date(args.before).toISOString():undefined,deviceId:args.deviceId,appId:args.appId,
      source:args.source,collection:args.collection,ocrStatus:args.ocrStatus};
    const hash=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    type Phase='material'|'capture'|'file';
    let phase:Phase=this.materials?'material':'capture',inner:string|null=null;
    if(args.cursor){
      try{
        const decoded=JSON.parse(Buffer.from(args.cursor,'base64url').toString()) as {v?:unknown;hash?:unknown;phase?:unknown;inner?:unknown};
        if(decoded.v!==1||decoded.hash!==hash||!['material','capture','file'].includes(String(decoded.phase))||
          decoded.inner!==null&&typeof decoded.inner!=='string')throw Error();
        phase=decoded.phase as Phase;inner=decoded.inner as string|null;
      }catch{throw new StoreError('Invalid query cursor',400);}
    }
    const selected:CaptureRecord[]=[];let scanned=0,done=false;
    const position=(record:CaptureRecord)=>Buffer.from(JSON.stringify({t:new Date(sourceContentTime(record)).toISOString(),id:record.id})).toString('base64url');
    const materialPosition=(material:MaterialRecord)=>Buffer.from(JSON.stringify({u:material.updatedAt,id:material.id})).toString('base64url');
    const range={...args,query:query||undefined,cursor:undefined,limit:200,includeTotal:false};
    while(selected.length<limit&&scanned<2000&&!done){
      if(phase==='material'){
        const page=this.materials!.list({query:query||undefined,sourceId:args.sourceId,deviceId:args.deviceId,
          after:args.after,before:args.before,cursor:inner??undefined,limit:100});
        if(!page.items.length){phase='capture';inner=null;continue;}
        for(const material of page.items){
          scanned++;inner=materialPosition(material);
          if(this.materialExposure(material,'discover',defaultEvidenceExposurePolicy)){
            const card=this.materialView(material,args,query||undefined);
            if(card&&this.captureExposure(card,'discover',defaultEvidenceExposurePolicy))selected.push(card);
          }
          if(selected.length===limit||scanned>=2000)break;
        }
        if(inner===materialPosition(page.items.at(-1)!)&&!page.nextCursor){phase='capture';inner=null;}
        continue;
      }
      if(phase==='capture'){
        const page=query?this.store.searchPage({...range,cursor:inner??undefined}):this.store.list({...range,cursor:inner??undefined});
        if(!page.items.length){phase='file';inner=null;continue;}
        for(const record of page.items){
          scanned++;inner=position(record);
          const material=this.sourceItemMaterial(record,args);
          if(material){
            if(query&&!this.materialIndexedForQuery(material,query)){
              const card=this.materialCard(material,record,query);
              if(card&&withinEvidenceScope(card,args)&&this.captureExposure(card,'discover',defaultEvidenceExposurePolicy))selected.push(card);
            }
          }else if(this.captureExposure(record,'discover',defaultEvidenceExposurePolicy))selected.push(record);
          if(selected.length===limit||scanned>=2000)break;
        }
        if(inner===position(page.items.at(-1)!)&&!page.nextCursor){phase='file';inner=null;}
        continue;
      }
      const page=this.files?.searchPage({...range,cursor:inner??undefined});
      if(!page?.items.length){done=true;break;}
      for(const record of page.items){
        scanned++;inner=position(record);
        if(!this.sourceItemMaterial(record,args)&&this.captureExposure(record,'discover',defaultEvidenceExposurePolicy))selected.push(record);
        if(selected.length===limit||scanned>=2000)break;
      }
      if(inner===position(page.items.at(-1)!)&&!page.nextCursor)done=true;
    }
    const nextCursor=done?null:Buffer.from(JSON.stringify({v:1,hash,phase,inner})).toString('base64url');
    return {items:this.context(selected),nextCursor,truncated:nextCursor!==null,scanned,
      retrieval:{mode:'paged-lexical' as const,degraded:false,exposure:{policy:'declared',scannedCandidates:scanned}}};
  }
  private async agentSearch(args:Range&{query?:string},policy:EvidenceExposurePolicy,operation:EvidenceOperation='discover'){
    const limit=Math.min(200,Math.max(1,args.limit??50));
    // Overfetch a bounded candidate set so suppressed samples do not consume the
    // entire result page. The original search remains available to owner APIs.
    const results=await this.search({...args,limit:200});
    const materialViews:CaptureRecord[]=[],fallback:CaptureRecord[]=[],seen=new Set<string>();
    let excluded=0,suppressed=0;
    const addMaterial=(material:MaterialRecord)=>{
      if(seen.has(material.ref)||!this.materialExposure(material,operation,policy))return;
      const card=this.materialView(material,args,args.query);
      if(!card||!this.captureExposure(card,operation,policy))return;
      seen.add(material.ref);materialViews.push(card);
    };
    for(const record of results){
      const material=this.sourceItemMaterial(record,args);
      if(material){
        suppressed++;
        addMaterial(material);
      }else if(this.captureExposure(record,operation,policy))fallback.push(record);
      else excluded++;
    }
    // A processed text block may match even when the original capture did not.
    // Query the formal Material index as a separate, scoped retrieval channel.
    if(args.query&&this.materials){
      const page=this.materialCatalog({...args,query:args.query,limit:100});
      for(const material of page.items){
        addMaterial(material);
      }
    }
    const visible=[...materialViews,...fallback].slice(0,limit);
    return Object.assign(visible,{retrieval:{...results.retrieval,
      exposure:{policy:'declared',candidateLimit:200,excludedCandidates:excluded,suppressedByMaterial:suppressed},
      ...(materialViews.length?{materialCatalog:{tool:'material_catalog',matchedRefs:materialViews.slice(0,20).map(row=>row.provenance?.uri?.split('#')[0]),
        sourceIds:[...new Set(materialViews.slice(0,20).map(row=>row.provenance?.sourceId).filter((id):id is string=>Boolean(id)))]}}:{})}});
  }
  private agentTimeline(args:Range,policy:EvidenceExposurePolicy,operation:EvidenceOperation='discover'){
    const limit=Math.min(100,Math.max(1,args.limit??50)),items:CaptureRecord[]=[];
    let cursor=args.cursor,nextCursor:string|null=null;
    // A raw capture cursor remains valid after filtering. Stop after a bounded
    // scan and return the cursor even when a window contains only screenshots.
    for(let scan=0;scan<20;scan++){
      const page=this.store.list({...args,cursor,limit:200,includeTotal:false});
      for(let index=0;index<page.items.length;index++){
        const record=page.items[index];
        const material=this.sourceItemMaterial(record,args);
        // Visit a composed source once at its parent position, including across
        // page boundaries. Attachment processing receipts are not new activity.
        if(material&&fileAttachmentParent(this.store,record.id))continue;
        const view=material?this.materialCard(material,record):record;
        if(!view||!this.captureExposure(view,operation,policy))continue;
        items.push(view);
        if(items.length===limit){
          const more=index<page.items.length-1||page.nextCursor!==null;
          nextCursor=more?Buffer.from(JSON.stringify({t:new Date(sourceContentTime(record)).toISOString(),id:record.id})).toString('base64url'):null;
          return {items,nextCursor};
        }
      }
      cursor=page.nextCursor??undefined;
      if(!cursor)return {items,nextCursor:null};
    }
    return {items,nextCursor:cursor??null};
  }
  private agentMemoryPage(args:Parameters<MemoryStore['page']>[0]&Range,policy:EvidenceExposurePolicy,operation:EvidenceOperation){
    const limit=Math.min(100,Math.max(1,args.limit??30));
    const items:ReturnType<EvidenceReader['memoryPage']>['items']=[];
    let cursor=args.cursor;
    for(let scan=0;scan<20;scan++){
      const page=this.memoryPage({...args,cursor,limit:100});
      for(let index=0;index<page.items.length;index++){
        const memory=page.items[index];
        const ids=this.store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=?').all(memory.id).map(row=>String(row.evidence_id));
        const records=ids.length?this.evidenceById(ids,args):[];
        if(!ids.length||records.length!==ids.length||!records.every(record=>this.captureExposure(record,operation,policy)))continue;
        items.push(memory);
        if(items.length===limit){
          const more=index<page.items.length-1||page.nextCursor!==null;
          return {items,nextCursor:more?Buffer.from(JSON.stringify({at:memory.createdAt,id:memory.id})).toString('base64url'):null};
        }
      }
      cursor=page.nextCursor??undefined;
      if(!cursor)return {items,nextCursor:null};
    }
    return {items,nextCursor:cursor??null};
  }
  agent(options:{diagnostics:ServerDiagnostics;allowQueryImages?:()=>boolean;exposurePolicy?:EvidenceExposurePolicy;currentOperation?:()=> 'query'|'memory';currentContextTime?:()=>string|undefined;currentGrantContext?:()=>object|undefined;currentProcessingEvidence?:()=>Readonly<Record<string,string>>|undefined;currentMaterialInputs?:()=>readonly MaterialInputPin[]|undefined}):ContextReader {
    const {store,sources}=this,{diagnostics}=options;
    const policy=options.exposurePolicy??defaultEvidenceExposurePolicy;
    const operation=(normal:'discover'|'expand'):EvidenceOperation=>options.currentOperation?.()==='memory'?'memory':normal;
    // The host supplies the current query's identity from AsyncLocalStorage.
    // A missing identity cannot receive or reuse an original disclosure grant.
    const grants=new WeakMap<object,Map<string,ScreenOriginalGrant[]>>();
    const currentGrants=()=>{const context=options.currentGrantContext?.();return context&&typeof context==='object'?grants.get(context):undefined;};
    const grant=(refs:readonly string[],source:ScreenOriginalGrant)=>{
      const context=options.currentGrantContext?.();if(!context||typeof context!=='object'||operation('expand')!=='expand')return;
      let byId=grants.get(context);if(!byId){byId=new Map();grants.set(context,byId);}
      for(const ref of refs){
        const id=evidenceRefId(ref,'capture');if(!id)continue;
        const record=scopeRecord(store,id);if(!record||record.source!=='screen'&&record.source!=='ui_page')continue;
        const selected=byId.get(id)??[];selected.push(source);byId.set(id,selected);
      }
    };
    const grantIsCurrent=(id:string,source:ScreenOriginalGrant)=>{
      try{
        if(source.kind==='material'){
          const material=this.materials?.get(source.ref);if(!material||this.materials?.get(material.id)?.ref!==source.ref||
            !this.materialExposure(material,'expand',policy))return false;
          const scoped=this.scopedMaterial(source.ref,source.scope);
          return Boolean(scoped?.members.some(member=>member.kind==='capture'&&evidenceRefId(member.ref,'capture')===id));
        }
        const page=this.agentSegments({...source.scope,id:source.ref},policy,'expand');
        return page.items.some(item=>item.ref===source.ref&&item.members.includes(id));
      }catch{return false;}
    };
    const hasScreenGrant=(id:string)=>{
      const pinned=options.currentProcessingEvidence?.()?.[id];
      if(pinned){const record=this.store.evidence([id])[0];
        if(record&&this.store.isCurrentEvidence(id)&&record.ocr?.status!=='pending'&&record.ocr?.status!=='failed'&&memoryEvidenceFingerprint(record)===pinned)return true;
      }
      return operation('expand')==='expand'&&Boolean(currentGrants()?.get(id)?.some(source=>grantIsCurrent(id,source)));
    };
    const boundedEvidenceAllowed=(record:CaptureRecord)=>{
      const inputs=options.currentMaterialInputs?.();
      if(operation('expand')==='memory'&&inputs?.length&&record.provenance?.uri?.startsWith('material:')){
        const expected=options.currentProcessingEvidence?.()?.[record.id],canonical=expected&&this.memories.readEvidence([record.id])[0];
        if(!canonical||memoryEvidenceFingerprint(canonical)!==expected)return false;
        return inputs.some(pin=>{
          if(!pin.evidenceIds.includes(record.id))return false;
          const material=this.materials?.get(pin.materialId),selection=material&&this.materials?.input(material.ref,pin.required);
          return Boolean(selection?.ready&&selection.fingerprint===pin.fingerprint&&material&&this.materialExposure(material,'memory',policy,pin.required));
        });
      }
      return this.captureExposure(record,operation('expand'),policy,'capture',hasScreenGrant(record.id));
    };
    return {
      catalog:async args=>contextIndex(this.store,{page:scope=>this.agentMemoryPage({...scope,asOf:scope?.asOf??options.currentContextTime?.()},policy,operation('discover'))},this.sources,args,scope=>this.agentSegments(scope,policy,operation('discover'))),
      materialCatalog:async args=>{const page=this.materialCatalog(args);return {...page,items:page.items.filter(material=>this.materialExposure(material,operation('discover'),policy))};},
      materialRead:async args=>{const material=this.materials?.get(args.ref);if(!material||this.materials?.get(material.id)?.ref!==material.ref||!this.materialExposure(material,operation('expand'),policy))throw new StoreError('Material not found in selected scope',404);const page=this.materialRead(args);grant(page.originalRefs,{kind:'material',ref:material.ref,scope:{...args}});return page;},
      readImage:async (input)=>{
        const {id,attachmentId}=input;
        if(!options.allowQueryImages?.())throw new ContextToolError('image_disclosure_disabled','Original-image access for queries is off. The owner must enable on-demand image access in Central Perception settings before a new query. Do not repeat this image request.','stop');
        const captureId=z.string().uuid().safeParse(id);if(!captureId.success)throw new StoreError('Invalid capture reference');
        const parent=()=>{
          const original=scopeRecord(store,captureId.data);if(original)return original;
          // A source-item Material anchor carries the same attachment metadata.
          // Resolve a current root plus only its host-verified attachment members.
          const anchor=this.evidenceById([captureId.data])[0],ref=anchor?.provenance?.uri?.split('#')[0],material=ref&&this.materials?.get(ref);
          if(!anchor||!material||!this.materials?.isCurrentEvidence(captureId.data)||!this.captureExposure(anchor,operation('expand'),policy))return;
          return this.materialHead(material,{});
        };
        const selected=parent();if(!selected)throw new StoreError('Image not found in authorized evidence',404);
        return readEvidenceImage(store,this.files,this.archivedFiles,{...input,id:selected.id,attachmentId},()=>{
          const record=parent();return Boolean(options.allowQueryImages?.()&&record&&record.id===selected.id&&
            this.captureExposure(record,operation('expand'),policy,'image',hasScreenGrant(record.id)));
        });
      },
      readFileEvidence:async args=>{const id=z.string().uuid().parse(args.id),original=this.evidenceById([id],args)[0];if(!original||!this.captureExposure(original,operation('expand'),policy))return {status:'unavailable'};return this.readFileEvidence({...args,id:formatEvidenceRef('capture',id)});},
      fileChunks:async args=>{const parsed=z.string().uuid().safeParse(args.id);if(!parsed.success||!this.files)return [];const id=parsed.data,parent=this.evidenceById([this.files.version(id).capture_id],args)[0];if(!parent||!this.captureExposure(parent,operation('expand'),policy))return [];return this.chunks({...args,id:formatEvidenceRef('capture',id)}).filter(record=>this.captureExposure(record,operation('expand'),policy));},
      mediaActivity:async args=>diagnostics.measure('source','activity',()=>store.mediaActivity(args),result=>({count:result.observations})),
      sourceHistory:async args=>this.sourceHistory({...args,id:formatEvidenceRef('capture',z.string().uuid().parse(args.id))}).filter(record=>this.captureExposure(record,operation('expand'),policy)),
      sources:async args=>sources.listSources().filter(s=>!args.deviceId||s.deviceId===args.deviceId).map(s=>({id:s.id,name:s.name,kind:s.kind,retention:s.retention,enabled:s.enabled,status:s.status})),
      // listItems applies calendar overlap / authored-time semantics; do not replace planned time with capture time.
      sourceItems:async args=>{const page=sources.listItems(args),scope={deviceId:args.deviceId,sourceId:args.sourceId};
        const visible=this.evidenceById(page.items.map(i=>i.captureId),{deviceId:args.deviceId}).flatMap(record=>{
          const material=this.sourceItemMaterial(record,scope);
          const view=material?this.materialCard(material,record):record;
          return view&&this.captureExposure(view,operation('discover'),policy)?[view]:[];
        });
        return {...page,totalCount:undefined,items:this.context(visible)};},
      segments:async args=>{const page=this.agentSegments(args,policy,operation('discover'));const ref=args?.id,parsed=ref?parseArtifactRef(ref):undefined;
        if(ref&&parsed&&operation('expand')==='expand'&&this.agentSegments({...args,id:ref},policy,'expand').items.some(item=>item.ref===ref)){
          const selected=page.items.find(item=>item.ref===ref);if(selected)grant(selected.members.map(id=>formatEvidenceRef('capture',id)),{kind:'segment',ref,scope:{...args}});
        }
        return page as any;},
      memories:async args=>{
        const id=args.id===undefined?undefined:formatEvidenceRef('memory',z.string().uuid().parse(args.id));
        const page=this.agentMemoryPage({...args,id,asOf:args.asOf??options.currentContextTime?.(),level:args.id?'detail':'overview'},policy,operation('discover'));
        const refs=args.id?page.items.flatMap((m:any)=>(m.evidence??[]) as import('./memory-schema.js').MemoryEvidence[]):[];
        const references=refs.map(e=>({id:e.id,capturedAt:e.capturedAt,characters:e.length??0}));
        if(!args.id||!args.includeEvidence)return {...page,references};
        const sourceSpans:import('@mote/agent').MemorySourceSpan[]=[];
        let partial=false;
        for(const ref of refs){
          if(sourceSpans.length===3){partial=true;break;}
          const record=this.evidenceById([ref.id],args)[0],canonical=this.memories.readEvidence([ref.id])[0];
          const offset=ref.offset,quotedLength=ref.length;
          // Verify the stored locator against the original now, not a saved quote.
          // Historical immutable originals remain labelled historical by context().
          if(!record||!canonical||!boundedEvidenceAllowed(record)||memoryEvidenceFingerprint(canonical)!==ref.contentHash||canonical.ocrText!==record.ocrText||
            typeof offset!=='number'||typeof quotedLength!=='number'||!Number.isSafeInteger(offset)||!Number.isSafeInteger(quotedLength)||offset<0||quotedLength<1||
            offset+quotedLength>record.ocrText.length||ref.quote!==record.ocrText.slice(offset,offset+quotedLength)){
            partial=true;continue;
          }
          const length=Math.min(quotedLength,2000);if(length<quotedLength)partial=true;
          sourceSpans.push({record:this.context([record])[0],offset,length});
        }
        return {...page,references,sourceSpans,sourceCoverage:{references:refs.length,delivered:sourceSpans.length,partial}};
      },
      search:async args=>diagnostics.measure('source','search',async()=>{const results=await this.agentSearch(args,policy,operation('discover'));return Object.assign(this.context(results),{retrieval:results.retrieval});},rows=>({count:rows.length})),timeline:async args=>diagnostics.measure('source','timeline',()=>{const page=this.agentTimeline(args,policy,operation('discover'));return {...page,items:this.context(page.items)};},page=>({count:page.items.length})),evidence:async args=>diagnostics.measure('source','evidence',()=>this.context(this.evidenceById(args.ids,args).filter(boundedEvidenceAllowed)),rows=>({count:rows.length})),activity:async args=>diagnostics.measure('source','activity',()=>store.activity(args),result=>({count:result.captures})),devices:async()=>diagnostics.measure('source','devices',()=>store.devices(),rows=>({count:rows.length}))};
  }
}
