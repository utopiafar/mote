import {z} from 'zod';
import {materialDependencyStatus,type MaterialInputPin} from './material-readiness.js';
import {scopeRecord} from './evidence-scope-record.js';
import {CODING_DIALOGUE_SCHEMA_VERSION,attributionContextSchema,sourceContentTime,parseEvidenceRef,evidenceRefId,formatEvidenceRef,formatArtifactRef,parseArtifactRef,sourceItemKinds,sourceTextFormat,decodeSourceText,type AttributionContext,type SourceContextDeclaration,type CaptureRecord} from '@mote/shared';
import {ContextToolError,type ContextReader} from '@mote/agent';
import {StoreError,type Store,type Range} from './store.js';
import {MemoryStore,memoryEvidenceFingerprint} from './memory.js';
import type {SourceStore} from './sources.js';
import type {FileStore} from './files.js';
import type {Indexer} from './indexer.js';
import type {FileEvidence} from './file-evidence.js';
import type {ServerDiagnostics} from './diagnostics.js';
import {materialId,parseMaterialRef,type MaterialStore,type MaterialMember,type MaterialRecord} from './materials.js';
import {contextIndex,contextIndexAsync} from './context-index.js';
import {browseSourceContexts,parseSourceContextRef} from './source-context-catalog.js';
import {SourceContextStore} from './source-context.js';
import {browseSourceCatalog} from './source-catalog.js';
import {defaultEvidenceExposurePolicy,type EvidenceExposurePolicy,type EvidenceExposureContext,type EvidenceOperation,type EvidencePhase,type EvidenceRepresentation,type RecipeExposureRoute} from './evidence-exposure.js';
import type {SourcePipelineRuntime} from './source-pipelines.js';
import type {SourceItemRecipeCatalog} from './source-item-recipe.js';
import {createHash} from 'node:crypto';
import {ArchivedFileStore} from './archived-files.js';
import {readEvidenceImage} from './evidence-image.js';
import {memoryImageOriginal,type MemoryImageGrant} from './memory-image-grants.js';
import {fileAttachmentAvailable,fileAttachmentParent} from './file-attachments.js';
import {materialSourcePin,materialSourceCurrent,type MaterialSourcePin} from './material-source-pin.js';
import {authoredRecordProjection} from './material-organizers.js';
import type {MemoryRecipeBinding} from './memory-strategy-contract.js';
import type {ManualMemoryInputPlanRequest} from './memory-input-plans.js';
import type {MemoryBindings} from './memory-bindings.js';
import {MemoryProviderError,memoryProviderKey,memoryProviderRecordSchema,memoryProviderNamespaceSchema,memoryBodyDigest,withMemoryHostState} from './memory-provider-contract.js';
import {memorySchema,type Memory} from './memory-schema.js';
import {combineSourceContextDependencies,sourceContextDependenciesCurrent} from './source-context-lineage.js';
export type MemoryReadSnapshot=ReturnType<MemoryBindings['retainSnapshot']>;
type MemoryExposure={policy:EvidenceExposurePolicy;operation:EvidenceOperation};
/** Host-only disclosure receipt. Catalog metadata is neither a body read nor
 * an extraction target, and its fingerprints never reach model transport. */
export type MemoryCatalogMetadataReceipt={complete:boolean;members:{id:string;materialId?:string;sourceId?:string;attribution?:string}[];sourceContextDependencies:SourceContextDeclaration[]};
const attributionMetadata=(context:AttributionContext)=>{const {ownerStatements:_,importStatements:__,sourceContextStatements:___,...metadata}=context;return JSON.stringify(metadata);};

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
  memoryBindings?:MemoryBindings;
  private readonly memorySnapshots=new WeakMap<object,MemoryReadSnapshot>();
  private readonly archivedFiles:ArchivedFileStore;
  constructor(readonly store:Store,readonly sources:SourceStore,readonly files?:FileStore,private readonly indexer?:Indexer,private readonly fileEvidence?:FileEvidence,private readonly materials?:MaterialStore,private readonly sourcePipelines?:SourcePipelineRuntime,private readonly sourceItemRecipes?:SourceItemRecipeCatalog,private readonly materialMemoryReady?:(ref:string)=>boolean){
    this.archivedFiles=new ArchivedFileStore(store);
    // Memory dependencies must use the canonical Material anchor. The query
    // projection below decorates it with source metadata for display and must
    // not replace its identity when validating a durable dependency.
    this.memories=new MemoryStore(store,ids=>{
      const records=[...store.evidence(ids),...(materials?.evidence(ids)??[]),...(files?.evidence(ids)??[])],contexts=materials?.contextsForEvidence(records);
      return records.map((record,index)=>({...record,...(contexts?{attributionContext:contexts[index]}:{})}));
    },id=>Boolean(materials?.isCurrentEvidence(id)||files?.isCurrentEvidence(id)||store.isCurrentEvidence(id)));
  }
  imageReference(ref:string,scope:Range={}){
    const id=evidenceRefId(ref,'capture');if(!id)return;
    const metadata=scopeRecord(this.store,id);if(!metadata||!withinEvidenceScope(metadata,scope))return;
    const value=this.store.imageReference(id);return value?{...value,id,source:metadata.source}:undefined;
  }
  evidence(refs:string[],scope:Range={}){
    return this.readEvidence(refs,scope,false);
  }
  private evidenceById(ids:string[],scope:Range={},batchViews?:{scoped:Map<string,boolean>;heads:Map<string,CaptureRecord|undefined>}){return this.readEvidence(ids.map(id=>formatEvidenceRef('capture',z.string().uuid().parse(id))),scope,false,batchViews);}
  /** Owner archive views may inspect retained old quotes; model tools stay current-only. */
  archivedEvidence(refs:string[],scope:Range={}){
    return this.readEvidence(refs,scope,true);
  }
  private readEvidence(refs:string[],scope:Range,includeHistorical:boolean,batchViews?:{scoped:Map<string,boolean>;heads:Map<string,CaptureRecord|undefined>}){
    const ids=[...new Set(refs.map(ref=>parseEvidenceRef(ref)).filter(ref=>ref?.kind==='capture').map(ref=>ref!.id))];
    const materialRecords=(this.materials?.evidence(ids)??[]).flatMap(record=>{
      const ref=record.provenance?.uri?.split('#')[0];if(!ref)return [];
      const prior=this.materials?.get(ref),current=prior&&this.materials?.get(prior.id);
      const active=current&&this.currentMaterialAnchor(record,current);
      const material=active?current:includeHistorical?prior:undefined;
      if(!material)return [];
      if(batchViews&&!batchViews.scoped.has(material.ref))batchViews.scoped.set(material.ref,Boolean(this.scopedMaterial(material.ref,scope)));
      if(!(batchViews?batchViews.scoped.get(material.ref):this.scopedMaterial(material.ref,scope)))return [];
      const selected=active??record;
      if(batchViews&&!batchViews.heads.has(material.ref))batchViews.heads.set(material.ref,this.materialHead(material,scope));
      const head=batchViews?batchViews.heads.get(material.ref):this.materialHead(material,scope);
      return [head?this.materialCard(material,head,undefined,selected)??selected:selected];
    });
    return [...this.store.evidence(ids),...materialRecords,...(this.files?.evidence(ids)??[])].map(record=>({...record,...(this.materials?{attributionContext:this.materials.contextForEvidence(record)}:{})})).filter(record=>withinEvidenceScope(record,scope));
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
    if(this.memoryBindings?.binding().namespace)throw new StoreError('External Memory bodies require an asynchronous provider read',503);
    const parsed=parseEvidenceRef(ref);if(parsed?.kind!=='memory')return;
    return this.memoryPage({...scope,id:ref,includeStale:true,includeHistory:true,level:'detail',limit:1},ownerArchive).items[0];
  }
  memoryPage(args:Parameters<MemoryStore['page']>[0]&Range={},ownerArchive=false){
    if((args.level==='detail'||args.query)&&this.memoryBindings?.binding().namespace)throw new StoreError('External Memory bodies and retrieval require an asynchronous provider read',503);
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
  retainMemorySnapshot(context:object){let value=this.memorySnapshots.get(context);if(!value&&this.memoryBindings){value=this.memoryBindings.retainSnapshot();this.memorySnapshots.set(context,value);}return value;}
  memorySnapshot(context?:object){return context?this.memorySnapshots.get(context):undefined;}
  releaseMemorySnapshot(context:object){const value=this.memorySnapshots.get(context);if(value){this.memorySnapshots.delete(context);value.release();}}
  private memoryToolSnapshot(context?:object){const retained=context&&this.memorySnapshots.get(context),owned=retained?undefined:this.memoryBindings?.retainSnapshot();return {snapshot:retained??owned,release:()=>owned?.release()};}
  /** One visibility rule for live cards, frozen snapshots and integration admission.
   * An ancestor is a revocation dependency, not a grant to read its raw body.
   * Only the exact current evidence cited by this card can cover that ancestor. */
  private memoryLineageVisible(lineage:NonNullable<MemoryReadSnapshot['lineage'][string]>,scope:Range,ownerArchive:boolean,exposure:MemoryExposure,strictProof=true){
    const ids=[...new Set(lineage.dependencyIds)];if(!ids.length)return false;
    for(const key of ['projectKey','repositoryKey','provider','sessionId'] as const)if(scope[key]&&(!lineage.scopeRefs?.length||lineage.scopeRefs.some(ref=>ref[key]!==scope[key])))return false;
    if(ownerArchive)return this.archivedEvidence(ids.map(id=>formatEvidenceRef('capture',id)),scope).length===ids.length;
    const anchors=this.memories.readEvidence(lineage.evidenceIds);
    if(anchors.length!==lineage.evidenceIds.length||!anchors.length||anchors.some(anchor=>anchor.privacy.excluded||!this.memories.isCurrentEvidence(anchor.id)))return false;
    if(lineage.evidence.some(proof=>{const anchor=anchors.find(value=>value.id===proof.id);return !anchor||(strictProof||anchor.provenance?.uri?.startsWith('material:'))&&memoryEvidenceFingerprint(anchor)!==proof.contentHash;}))return false;
    const materialAncestors=new Set<string>();
    for(const anchor of anchors){
      if(!this.captureExposure(anchor,exposure.operation,exposure.policy))return false;
      if(anchor.provenance?.uri?.startsWith('material:'))for(const id of this.memories.dependencyIds(anchor.id))materialAncestors.add(id);
    }
    const direct=new Set(lineage.evidenceIds);
    for(const id of ids){
      // Raw lineage checks do not load the archived JSON/text/image payload.
      const record=scopeRecord(this.store,id)??this.evidenceById([id],scope)[0];
      if(!record||record.privacy.excluded||!withinEvidenceScope(record,scope)||!this.memories.isCurrentEvidence(id)||!fileAttachmentAvailable(this.store,id,true))return false;
      const p=record.provenance;
      if(p?.sourceId&&p.externalId&&this.store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(p.sourceId,p.externalId)?.deleted)return false;
      if(direct.has(id)||!materialAncestors.has(id)){
        if(!this.captureExposure(record,exposure.operation,exposure.policy))return false;
      }else if(record.source==='screen'||record.source==='ui_page'){
        // Preserve the existing screen-original policy, without granting a raw tool read.
        if(!this.captureExposure(record,exposure.operation==='discover'?'expand':exposure.operation,exposure.policy,'capture',true,true))return false;
      }else{
        // Source-wide policy still applies to every ancestor; raw-representation
        // denials do not revoke its separately permitted canonical Material.
        const sourceKind=p?.document?.coding?'coding-agent':this.sourceKind(p?.sourceId,record.source);
        if(!exposure.policy.allows({sourceKind,sourceId:p?.sourceId,deviceId:record.deviceId,representation:'material',operation:exposure.operation,phase:'complete'}))return false;
      }
    }
    return true;
  }
  /** Host preflight/transport check. Reads only the selected card's exact proof;
   * no source route is added, no unused raw body is loaded, and no model is run. */
  assertMemoryReadable(cards:readonly Memory[],policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy){
    for(const card of cards){
      const dependencyIds=this.store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=?').all(card.id).map(row=>String(row.evidence_id));
      if(!this.memoryLineageVisible({dependencyIds,evidenceIds:card.evidenceIds,evidence:card.evidence.map(value=>({id:value.id,contentHash:value.contentHash})),scopeRefs:card.scopeRefs},{},false,{policy,operation:'memory'}))throw new StoreError('Integration Memory or its exact original proof is not readable',409);
    }
  }
  async memoryAsync(ref:string,scope:Range={},ownerArchive=false,snapshot?:MemoryReadSnapshot,exposure:MemoryExposure={policy:defaultEvidenceExposurePolicy,operation:'expand'}):Promise<Memory|undefined>{
    const parsed=parseEvidenceRef(ref);if(parsed?.kind!=='memory')return;
    const owned=!snapshot&&this.memoryBindings?this.memoryBindings.retainSnapshot():undefined,pin=snapshot??owned;
    try{
      const args={...scope,query:undefined,cursor:undefined,id:ref,includeStale:true,includeHistory:true,level:'overview' as const,limit:1};
      const visible=()=>{const current=ownerArchive?this.memoryPage(args,true).items[0]:this.agentMemoryPage(args,exposure.policy,exposure.operation).items[0];return current&&(!pin?.lineage[parsed.id]||this.memoryLineageVisible(pin.lineage[parsed.id],scope,ownerArchive,exposure))?current:undefined;};
      if(!visible())return;const key=pin?.catalog[parsed.id];if(pin&&!key)return;
      const body=pin?.records?.[parsed.id]??(pin?.binding.namespace?await this.memoryBindings!.read(parsed.id,pin.binding,key):this.memories.get(parsed.id));
      const memory=memorySchema.parse(body);
      if(key&&JSON.stringify(memoryProviderKey(memory))!==JSON.stringify(key)||pin&&memoryBodyDigest(memory)!==pin.recordDigests[parsed.id])throw new StoreError('The bound Memory body does not match its pinned revision',502);
      // An in-flight read retains its old version, but never an old permission.
      if(!visible())return;return pin?.metadata[parsed.id]?withMemoryHostState(memory,pin.metadata[parsed.id] as Pick<Memory,'status'|'staleReason'|'updatedAt'>):memory;
    }catch(error){if(error instanceof MemoryProviderError)throw new StoreError(error.message,error.code==='invalid_record'||error.code==='conflict'?502:503);throw error;}finally{owned?.release();}
  }
  async memoryPageAsync(args:Parameters<MemoryStore['page']>[0]&Range={},ownerArchive=false,snapshot?:MemoryReadSnapshot,exposure:MemoryExposure={policy:defaultEvidenceExposurePolicy,operation:'discover'}):Promise<ReturnType<MemoryStore['page']>>{
    const owned=!snapshot&&this.memoryBindings?this.memoryBindings.retainSnapshot():undefined,pin=snapshot??owned;
    try{
      const metadataPage=(scope:Parameters<MemoryStore['page']>[0]&Range)=>{const page=ownerArchive?this.memoryPage({...scope,level:'overview'},true):this.agentMemoryPage({...scope,level:'overview'},exposure.policy,exposure.operation);return {...page,items:page.items.filter(value=>!pin?.lineage[value.id]||this.memoryLineageVisible(pin.lineage[value.id],scope,ownerArchive,exposure))};};
      const pinnedMetadata=(current:any)=>pin?.metadata[current.id]?{...pin.metadata[current.id],disclosure:current.disclosure}:current;
      if(args.query&&pin?.binding.namespace){
        const keys=Object.values(pin.catalog);if(!keys.length)return {items:[],nextCursor:null};
        const signature=createHash('sha256').update(JSON.stringify({binding:pin.binding,catalog:pin.catalog,args:{...args,cursor:undefined,limit:undefined,level:undefined}})).digest('hex');let offset=0;
        if(args.cursor){try{const cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());if(cursor.kind!=='provider-memory'||cursor.signature!==signature||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{throw new StoreError('Memory query binding or catalog changed; restart this search',409);}}
        const hits=await this.memoryBindings!.provider(pin.binding.namespace.instanceId,pin.binding.namespace).search({namespace:pin.binding.namespace,query:args.query,keys,limit:keys.length});
        const expectedNamespace=JSON.stringify(memoryProviderNamespaceSchema.parse(pin.binding.namespace));
        const candidates=hits.map(hit=>memoryProviderRecordSchema.parse({namespace:hit.namespace,key:hit.key,memory:hit.memory})).filter(hit=>{
          if(JSON.stringify(hit.namespace)!==expectedNamespace)throw new StoreError('Memory retrieval crossed its bound namespace',502);
          if(!pin.catalog[hit.key.memoryId]||JSON.stringify(pin.catalog[hit.key.memoryId])!==JSON.stringify(hit.key))return false;
          if(memoryBodyDigest(hit.memory)!==pin.recordDigests[hit.key.memoryId])throw new StoreError('Memory retrieval did not preserve its pinned immutable body',502);return true;
        });
        const selected:Memory[]=[];let scanned=offset;const limit=args.limit??30;
        for(;scanned<candidates.length&&selected.length<limit;scanned++){
          const hit=candidates[scanned],scope={...args,query:undefined,cursor:undefined,id:formatEvidenceRef('memory',hit.key.memoryId),level:'overview' as const,limit:1};
          const metadata=metadataPage(scope).items[0];if(!metadata)continue;
          const memory=await this.memoryAsync(formatEvidenceRef('memory',hit.key.memoryId),args,ownerArchive,pin,exposure);
          if(memory&&metadataPage(scope).items.length)selected.push(args.level==='detail'?memory:pinnedMetadata(metadata) as Memory);
        }
        return {items:selected,nextCursor:scanned<candidates.length?Buffer.from(JSON.stringify({kind:'provider-memory',signature,offset:scanned})).toString('base64url'):null};
      }
      const page=metadataPage(args),items:Memory[]=[];
      for(const metadata of page.items){
        if(pin&&!pin.catalog[metadata.id])continue;
        if(args.level==='detail'){
          const memory=await this.memoryAsync(formatEvidenceRef('memory',metadata.id),args,ownerArchive,pin,exposure);
          if(memory&&metadataPage({...args,query:undefined,cursor:undefined,id:formatEvidenceRef('memory',metadata.id),limit:1}).items.length)items.push(memory);
        }else items.push(pinnedMetadata(metadata) as Memory);
      }
      return {...page,items};
    }catch(error){if(error instanceof MemoryProviderError)throw new StoreError(error.message,error.code==='invalid_record'||error.code==='conflict'?502:503);throw error;}finally{owned?.release();}
  }
  context(records:CaptureRecord[]){return records.map(record=>{
    const formal=this.materials&&this.store.db.prepare('SELECT 1 FROM material_evidence WHERE id=?').get(record.id);
    const nativeFile=this.files&&this.store.db.prepare('SELECT capture_id FROM file_versions WHERE capture_id=? UNION SELECT capture_id FROM file_chunks WHERE id=? LIMIT 1').get(record.id,record.id);
    const current=formal?this.materials!.isCurrentEvidence(record.id):nativeFile?this.files!.isCurrentEvidence(record.id)||Boolean(this.store.db.prepare('SELECT 1 FROM file_heads WHERE capture_id=?').get(record.id)):record.provenance?.externalId&&this.sources.getItem(record.provenance.sourceId,record.provenance.externalId)?.captureId===record.id;
    // The built-in organizer declares these JSON wrappers. Neither raw capture
    // prose nor a custom organizer acquires a presentation type by looking like JSON.
    let evidencePresentation:ReturnType<typeof sourceTextFormat>;
    const ref=formal&&record.provenance?.uri?.split('#')[0],material=ref?this.materials!.get(ref):undefined;
    if(material&&[1,2].includes(material.schemaVersion)&&sourceItemKinds.some(kind=>material.kind==='mote.'+kind)&&
      this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_organizer_groups'").get()){
      const owners=this.store.db.prepare('SELECT organizer_id,version FROM material_organizer_groups WHERE material_id=? AND active=1').all(material.id);
      if(owners.length===1&&owners[0].organizer_id==='mote.source-item'&&(String(owners[0].version)==='12'||material.schemaVersion===1&&String(owners[0].version)==='11')){
        const block=this.store.db.prepare(`SELECT b.block_id,b.format,b.locator,p.text FROM material_blocks b
          JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.revision=? AND b.anchor_id=?`).get(material.id,material.revision,record.id);
        if(block&&block.text===record.ocrText){
          const format=sourceTextFormat({id:String(block.block_id),format:typeof block.format==='string'?block.format:undefined,...(block.locator?{locator:JSON.parse(String(block.locator))}:{} )});
          if(format&&decodeSourceText(format,record.ocrText))evidencePresentation=format;
        }
      }
    }
    return {...record,...(this.materials?{attributionContext:this.materials.contextForEvidence(record)}:{}),ref:formatEvidenceRef('capture',record.id),sourceType:record.source,...(record.provenance?{revisionState:current?'current':'historical'}:{}),evidencePresentation};
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
  catalogAsync(args:Range&{path?:string;query?:string}={},snapshot?:MemoryReadSnapshot){return contextIndexAsync(this.store,{page:scope=>this.memoryPageAsync(scope,false,snapshot)},this.sources,args,scope=>this.segments(scope));}
  fileCatalog(sourceId:string,args:Parameters<typeof browseSourceCatalog>[2]){this.sources.getSource(sourceId);return browseSourceCatalog(this.store.db,sourceId,args);}
  private artifactMembers(id:string,revision:string,scope:Range={}){
    const pending=[{id,revision}],seen=new Set<string>(),directMembers=new Set<string>(),materialRefs=new Map<string,{ref:string;offset?:number;length?:number}[]>();
    while(pending.length){
      const ref=pending.pop()!,key=JSON.stringify(ref);if(seen.has(key))continue;seen.add(key);
      const row=this.store.db.prepare('SELECT revision,json FROM context_artifacts WHERE id=?').get(ref.id);
      if(!row||row.revision!==ref.revision)return;
      const value=JSON.parse(String(row.json)) as {members:string[];parents?:{id:string;revision:string}[];materialInputs?:{ref:string;offset?:number;length?:number}[]};
      for(const member of value.members)directMembers.add(member);
      for(const input of value.materialInputs??[]){const pages=materialRefs.get(input.ref)??[];pages.push(input);materialRefs.set(input.ref,pages);}
      pending.push(...value.parents??[]);
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
      if(!material||material.ref!==ref||this.materials.get(material.id)?.revision!==material.revision)return;
      const scoped=this.scopedMaterial(ref,scope);if(!scoped)return;
      if(scoped.members[0]?.kind==='archive'){
        const add=(id:string)=>{members.add(id);archiveTimes.set(id,{firstAt:material.origin.firstAt,lastAt:material.origin.lastAt});};
        if(material.kind==='mote.coding-session'&&inputs.every(input=>Number.isSafeInteger(input.offset)&&Number.isSafeInteger(input.length))){
          for(const input of inputs){let page;try{page=this.materials.read(ref,{offset:input.offset,length:input.length});}catch{return;}
            for(const span of page.spans){if(!span.evidenceId)return;add(span.evidenceId);}}
        }else for(const id of this.materials.evidenceIds(ref))add(id);
        continue;
      }
      for(const member of scoped.members){
        const captureId=evidenceRefId(member.ref,'capture');if(!captureId)return;
        members.add(captureId);
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
  private artifactAttribution(members:readonly string[]){
    return Object.fromEntries(members.flatMap(id=>{
      const record=scopeRecord(this.store,id)??this.materials?.evidence([id])[0];
      return record&&this.materials?[[id,this.materials.contextForEvidence(record)]]:[];
    }));
  }
  artifact(ref:string,scope:Range={}){
    const parsed=parseArtifactRef(ref);if(!parsed)return;
    const originals=this.artifactMembers(parsed.id,parsed.revision,scope);if(!originals)return;
    const value=this.store.archive.get(parsed.id),members=originals.members.slice(0,30);return value?{...value,ref:formatArtifactRef(value.id,value.revision),...originals,members,evidenceCount:originals.members.length,membersTruncated:originals.members.length>30,attributionContexts:this.artifactAttribution(members)}:undefined;
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
      return [{...item,...originals,ref:formatArtifactRef(item.id,item.revision),members:members.slice(0,limit),attributionContexts:this.artifactAttribution(members.slice(0,limit)),evidenceCount:members.length,membersTruncated:members.length>limit}];
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
    // Recheck after the asynchronous excerpt write; removal must not disclose a late response.
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
  /** Record all metadata/body contributors without loading their text or
   * expanding model read grants. Only genuinely missing lineage is incomplete. */
  private materialDisclosureDependencies(refs:readonly string[]){
    const ids=new Set<string>();let complete=true;
    for(const ref of refs){
      const material=this.materials?.get(ref);if(!material){complete=false;continue;}
      const anchors=this.materials!.evidenceIds(ref);
      for(const id of anchors)ids.add(id);
      if(!material.memberCount)complete=false;
      for(let offset=0;offset<material.memberCount;offset+=200){
        const page=this.materials!.members(ref,{offset,limit:200});
        for(const member of page.items){
          if(member.kind==='archive'){if(!anchors.length)complete=false;continue;}
          const id=member.kind==='capture'?evidenceRefId(member.ref,'capture'):undefined;
          if(id)ids.add(id);else complete=false;
        }
      }
    }
    return {version:1 as const,complete,ids:[...ids]};
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
        const required=[...(strategy.requires??(allowList?this.materials!.requirementsForEvidence(material.ref,allowList):this.sourcePipelines?.memoryWork.sourceRequirements(material.ref))??['material'])];
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
  /** Validate every disclosed dependency without loading its body. Reuse only
   * within this synchronous check: the next external request/commit gets a fresh
   * view, including current source tombstones and attachment/Material policy. */
  contextDependenciesAllowed(ids:readonly string[],policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy,historical=false):boolean {
    const selected=[...new Set(ids)],encoded=JSON.stringify(selected),db=this.store.db;
    if(!selected.length)return true;
    const anchors=this.materials?db.prepare(`SELECT e.id,e.material_id,e.revision,e.block_id FROM material_evidence e
      JOIN json_each(?) wanted ON wanted.value=e.id JOIN material_heads h ON h.id=e.material_id
      JOIN material_revisions r ON r.material_id=e.material_id AND r.revision=e.revision
      WHERE h.retired=0 AND ${historical?'1':'r.sequence>=h.min_visible_sequence'} AND (
        EXISTS(SELECT 1 FROM material_blocks b WHERE b.material_id=e.material_id AND b.revision=e.revision AND b.block_id=e.block_id)
        OR EXISTS(SELECT 1 FROM material_block_versions b WHERE b.material_id=e.material_id AND b.from_revision=e.revision AND b.block_id=e.block_id AND b.anchor_id=e.id))`)
      .all(encoded) as {id:string;material_id:string;revision:string;block_id:string}[]:[];
    const fileChunks=this.files?db.prepare(`SELECT c.id,c.capture_id FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id
      JOIN file_versions v ON v.capture_id=c.capture_id JOIN json_each(?) wanted ON wanted.value=c.id WHERE a.current=1`)
      .all(encoded) as {id:string;capture_id:string}[]:[];
    const captures=new Map(this.store.evidenceMetadata([...selected,...fileChunks.map(chunk=>chunk.capture_id)]).map(record=>[record.id,record]));
    const anchorMap=new Map(anchors.map(anchor=>[anchor.id,anchor])),chunkMap=new Map(fileChunks.map(chunk=>[chunk.id,chunk]));
    const derived=new Set(db.prepare(`SELECT wanted.value id FROM json_each(?) wanted WHERE
      EXISTS(SELECT 1 FROM memories m WHERE m.id=wanted.value) OR EXISTS(SELECT 1 FROM context_artifacts a WHERE a.id=wanted.value)
      OR EXISTS(SELECT 1 FROM file_artifacts a WHERE a.id=wanted.value)`).all(encoded).map(row=>String(row.id)));
    const metadata=new Map<string,MaterialRecord|undefined>(),materialAllowed=new Map<string,boolean>(),fileAllowed=new Map<string,boolean>(),attachmentAllowed=new Map<string,boolean>(),headDeleted=new Map<string,boolean>();
    const material=(ref:string)=>{if(!metadata.has(ref))metadata.set(ref,this.materials?.authorizationMetadata(ref));return metadata.get(ref);};
    const attachment=(id:string)=>{if(!attachmentAllowed.has(id))attachmentAllowed.set(id,fileAttachmentAvailable(this.store,id,true));return attachmentAllowed.get(id)!;};
    const tombstone=(sourceId:string,externalId:string)=>{const key=JSON.stringify([sourceId,externalId]);if(!headDeleted.has(key))headDeleted.set(key,Boolean(db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(sourceId,externalId)?.deleted));return headDeleted.get(key)!;};
    const allowMaterial=(current:MaterialRecord)=>{if(!materialAllowed.has(current.ref))materialAllowed.set(current.ref,this.materialExposure(current,'expand',policy,undefined,false,undefined,true)&&policy.allows({sourceKind:this.materialKind(current),sourceId:current.origin.sourceId,representation:'material',operation:'expand',phase:current.coverage.state}));return materialAllowed.get(current.ref)!;};
    const allowRecord=(record:CaptureRecord,attachmentId=record.id)=>{
      if(!attachment(attachmentId))return false;
      const p=record.provenance;if(p?.sourceId&&p.externalId&&tombstone(p.sourceId,p.externalId))return false;
      const current=p?.sourceId&&p.externalId?material(materialId(p.sourceId,p.externalId)):undefined;
      return current?allowMaterial(current):this.captureExposure(record,'expand',policy,'capture',true,true);
    };
    for(const id of selected){
      const capture=captures.get(id);if(capture){if(!allowRecord(capture))return false;continue;}
      const anchor=anchorMap.get(id);
      if(anchor){const prior=material(historical?anchor.material_id:`material:${anchor.material_id}@${anchor.revision}`),current=prior&&material(prior.id);
        if(!prior||!current||!attachment(id)||tombstone(prior.origin.sourceId,prior.id)||!allowMaterial(current))return false;continue;}
      const chunk=chunkMap.get(id);
      if(chunk){if(!fileAllowed.has(chunk.capture_id)){const parent=captures.get(chunk.capture_id);fileAllowed.set(chunk.capture_id,Boolean(parent&&allowRecord({...parent,id,provenance:parent.provenance?{...parent.provenance,layer:'derived'}:undefined},chunk.capture_id)));}if(!fileAllowed.get(chunk.capture_id))return false;continue;}
      if(!derived.has(id))return false;
    }
    return true;
  }
  /** Revalidate a restricted Memory read immediately before model transport.
   * A loaded seed is not a retained permission. All records and Formal output
   * selections are fresh; reuse is confined to this synchronous check. */
  processingEvidenceAllowed(ids:readonly string[],fingerprints:Readonly<Record<string,string>>|undefined,inputs:readonly MaterialInputPin[]|undefined,policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy):boolean {
    const selected=[...new Set(ids)],selectedIds=new Set(selected);
    if(!selected.length)return true;
    if(!fingerprints||selected.some(id=>!fingerprints[id]))return false;
    const records=new Map(this.memories.readCurrentEvidence(selected).map(record=>[record.id,record]));
    const materialPermissions=new Map<string,boolean>(),materials=new Map<string,MaterialRecord|undefined>(),granted=new Map<string,Set<string>>();
    const material=(id:string)=>{if(!materials.has(id))materials.set(id,this.materials?.get(id));return materials.get(id);};
    for(const pin of inputs??[]){
      // A future context read grant is not an already-disclosed original.
      // Unused independent originals can change without retiring this seed.
      if(!pin.evidenceIds.some(id=>selectedIds.has(id)))continue;
      const current=material(pin.materialId),selection=current&&this.materials?.input(current.ref,pin.required);
      if(!current||!selection?.ready||selection.fingerprint!==pin.fingerprint||!this.materialExposure(current,'memory',policy,pin.required,false,true))return false;
      const currentIds=new Set(selection.evidenceIds);if(pin.evidenceIds.some(id=>!currentIds.has(id)))return false;
      const permissions=granted.get(pin.materialId)??new Set<string>();for(const id of pin.evidenceIds)permissions.add(id);granted.set(pin.materialId,permissions);
    }
    for(const id of selected){
      const record=records.get(id);if(!record||memoryEvidenceFingerprint(record)!==fingerprints[id])return false;
      const ref=record.provenance?.uri?.startsWith('material:')?record.provenance.uri.split('#')[0]:undefined;
      if(ref){
        const prior=material(ref),current=prior&&material(prior.id);if(!current)return false;
        if(inputs?.length){if(!granted.get(current.id)?.has(id))return false;}
        else{if(!materialPermissions.has(current.ref))materialPermissions.set(current.ref,this.materialExposure(current,'memory',policy));if(!materialPermissions.get(current.ref))return false;}
      }else if(!this.captureExposure(record,'memory',policy,'capture',true))return false;
    }
    return true;
  }
  /** These are the host member vectors actually serialized in memoryWork,
   * including declaration prose shared by the lossless wire dictionaries. */
  memoryCatalogMetadata(task:unknown):MemoryCatalogMetadataReceipt|undefined {
    if(!task||typeof task!=='object'||Array.isArray(task))return;
    const work=(task as {memoryWork?:unknown}).memoryWork;if(!work||typeof work!=='object'||Array.isArray(work))return;
    const w=work as Record<string,unknown>,history=(value:unknown)=>Array.isArray(value)?value.flatMap(item=>item&&typeof item==='object'?[...(Array.isArray(item.targets)?item.targets:[]),...(Array.isArray(item.contextMembers)?item.contextMembers:[])]:[]):[];
    const feedback=w.feedback&&typeof w.feedback==='object'?w.feedback as Record<string,unknown>:undefined;
    const rows=[...(['members','contextMembers','authorizedMembers'] as const).flatMap(key=>Array.isArray(w[key])?w[key]:[]),...history(w.history),
      ...(feedback? [...(Array.isArray(feedback.targets)?feedback.targets:[]),...(Array.isArray(feedback.authorized)?feedback.authorized:[]),...history(feedback.history)]:[])];
    if(!rows.length)return;
    const members=new Map<string,MemoryCatalogMetadataReceipt['members'][number]>(),pins:SourceContextDeclaration[][]=[];let complete=true;
    for(const value of rows){
      if(!value||typeof value!=='object'||!z.string().uuid().safeParse(value.id).success){complete=false;continue;}
      const row=value as Record<string,unknown>,attribution=row.attributionContext===undefined?undefined:attributionContextSchema.safeParse(row.attributionContext);
      if(attribution&&!attribution.success){complete=false;continue;}
      let materialId:string|undefined;
      try{if(row.materialRef!==undefined){if(typeof row.materialRef!=='string')throw Error();materialId=parseMaterialRef(row.materialRef).id;}}catch{complete=false;continue;}
      const member={id:row.id as string,...(materialId?{materialId}:{}),...(typeof row.sourceId==='string'?{sourceId:row.sourceId}:{}),...(attribution?.success?{attribution:attributionMetadata(attribution.data)}:{})};
      members.set(JSON.stringify(member),member);
      if(attribution?.success)pins.push(attribution.data.sourceContextDeclarations??[]);
    }
    return {complete,members:[...members.values()],sourceContextDependencies:combineSourceContextDependencies(pins)};
  }
  /** Fresh metadata only: a new unread body revision can retire its old read
   * grant without changing a still-readable source/Material declaration. */
  memoryCatalogMetadataAllowed(receipt:MemoryCatalogMetadataReceipt,policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy):boolean {
    if(!receipt.complete||!sourceContextDependenciesCurrent(this.sources.contexts,receipt.sourceContextDependencies))return false;
    const ids=[...new Set(receipt.members.map(member=>member.id))],encoded=JSON.stringify(ids),db=this.store.db;
    const anchors=new Map(this.materials?db.prepare('SELECT e.id,e.material_id FROM material_evidence e JOIN json_each(?) wanted ON wanted.value=e.id').all(encoded).map(row=>[String(row.id),String(row.material_id)]):[]);
    const chunks=new Map(this.files?db.prepare('SELECT c.id,c.capture_id FROM file_chunks c JOIN json_each(?) wanted ON wanted.value=c.id').all(encoded).map(row=>[String(row.id),String(row.capture_id)]):[]);
    const captures=new Map(this.store.evidenceMetadata([...ids,...chunks.values()]).map(record=>[record.id,record]));
    const currentMaterials=new Map<string,MaterialRecord|undefined>(),permissions=new Map<string,boolean>();
    const material=(id:string)=>{if(!currentMaterials.has(id))currentMaterials.set(id,this.materials?.authorizationMetadata(id));return currentMaterials.get(id);};
    const rawIds:string[]=[];
    for(const member of receipt.members){
      const materialId=anchors.get(member.id);
      if(member.materialId&&member.materialId!==materialId)return false;
      if(materialId){
        const current=material(materialId);if(!current||member.sourceId&&member.sourceId!==current.origin.sourceId)return false;
        if(!permissions.has(materialId))permissions.set(materialId,this.materialExposure(current,'memory',policy,undefined,true,undefined,true));
        if(!permissions.get(materialId))return false;
      }else rawIds.push(member.id);
    }
    if(!this.contextDependenciesAllowed(rawIds,policy))return false;
    // The existing resolver joins only current manifests/declaration stores;
    // these placeholder records never load original or derived body payloads.
    const records=ids.map(id=>({...captures.get(id)??captures.get(chunks.get(id)??''),id,ocrText:''}) as CaptureRecord),contexts=this.materials?.contextsForEvidence(records);
    if(!contexts&&receipt.members.some(member=>member.attribution!==undefined))return false;
    const currentContexts=new Map(ids.map((id,index)=>[id,contexts?.[index]&&attributionMetadata(attributionContextSchema.parse(contexts[index]))]));
    return receipt.members.every(member=>member.attribution===undefined||member.attribution===currentContexts.get(member.id));
  }
  private materialMembersAvailable(material:MaterialRecord,metadataOnly=false):boolean {
    if(!this.materials)return false;
    for(let offset=0;offset<material.memberCount;offset+=200){
      const page=this.materials.members(material.ref,{offset,limit:200});
      if(!page.items.length)return false;
      for(const member of page.items){
        if(member.kind==='capture'){
          const id=evidenceRefId(member.ref,'capture');if(!id||!fileAttachmentAvailable(this.store,id,metadataOnly))return false;
        }
      }
    }
    return true;
  }
  private captureExposure(record:CaptureRecord,operation:EvidenceOperation,policy:EvidenceExposurePolicy,representation:EvidenceRepresentation='capture',screenOriginalGrant=false,metadataOnly=false){
    if(!fileAttachmentAvailable(this.store,record.id,metadataOnly))return false;
    const provenance=record.provenance,materialRef=provenance?.uri?.startsWith('material:')?provenance.uri.split('#')[0]:undefined;
    const material=materialRef?this.materials?.get(materialRef):undefined;
    if(materialRef){
      // A pinned old Material body remains in the owner archive, but a model
      // can read only anchors still active in the current formal revision.
      // Coding append keeps unchanged prefix anchors active across revisions.
      if(!material)return false;
      const current=this.materials?.get(material.id);
      return Boolean(current&&this.materials?.isCurrentEvidence(record.id)&&this.materialExposure(current,operation,policy,undefined,false,undefined,metadataOnly));
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
    return this.exposureAllows({sourceKind,sourceId:provenance?.sourceId,deviceId:record.deviceId,representation,operation,phase},policy,screenOriginalGrant);
  }
  /** The built-in authored organizer binds a logical Material to one current
   * owner capture. A string prefix alone is never an authorization claim. */
  private authoredMaterialOriginal(material:MaterialRecord,metadataOnly=false):CaptureRecord|undefined {
    if(!this.materials||material.memberCount!==1)return;
    if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_organizer_groups'").get())return;
    const owners=this.store.db.prepare('SELECT organizer_id,version,group_json FROM material_organizer_groups WHERE material_id=? AND active=1').all(material.id) as
      {organizer_id:string;version:string;group_json:string}[];
    if(owners.length!==1||owners[0].organizer_id!=='mote.authored-record'||!['3','4'].includes(owners[0].version))return;
    let group:{deviceId?:unknown;captureId?:unknown};
    try{group=JSON.parse(owners[0].group_json);}catch{return;}
    if(typeof group.deviceId!=='string'||typeof group.captureId!=='string')return;
    const expectedSource='authored:'+createHash('sha256').update(JSON.stringify(group.deviceId)).digest('hex');
    if(material.origin.sourceId!==expectedSource||material.origin.externalId!==group.captureId||
      material.origin.deviceId!==group.deviceId||material.id!==materialId(expectedSource,group.captureId))return;
    const members=this.materials.members(material.ref,{limit:2}).items;
    if(members.length!==1||members[0].kind!=='capture'||evidenceRefId(members[0].ref,'capture')!==group.captureId)return;
    const original=(metadataOnly?this.store.evidenceMetadata([group.captureId]):this.store.evidence([group.captureId]))[0];
    if(!original||!this.store.isCurrentEvidence(original.id)||original.deviceId!==group.deviceId||
      original.provenance||material.kind!==`mote.${original.source}`)return;
    return original;
  }
  private materialExposure(material:MaterialRecord,operation:EvidenceOperation,policy:EvidenceExposurePolicy,required?:readonly string[],planning=false,selectionReady?:boolean,metadataOnly=false){
    // Reject a Coding projection that does not declare the current clean
    // dialogue contract before any model exposure.
    if(material.kind==='mote.coding-session'&&material.schemaVersion<CODING_DIALOGUE_SCHEMA_VERSION)return false;
    if(!this.materialMembersAvailable(material,metadataOnly))return false;
    if(!planning&&required&&!(selectionReady??this.materials?.input(material.ref,required)?.ready))return false;
    if(operation==='memory'&&this.sourceItemRecipes){
      const original=this.authoredMaterialOriginal(material,metadataOnly);
      if(original){
        if(!this.captureExposure(original,'memory',policy,'capture',false,metadataOnly))return false;
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
    // A ready field body is the entire authorized visible-window input, while
    // the source document remains partial. Do not grant whole-material reads
    // or change query coverage merely to admit this bounded Memory input.
    const readyPageBody=operation==='memory'&&['mote.ui-page-object','mote.capture-event'].includes(material.kind)&&
      material.coverage.state==='partial'&&material.coverage.reason==='visible_window'&&
      required?.length===1&&['source-body','daily-events'].includes(required[0]);
    const phase=planning||readyPageBody?'complete':required&&material.coverage.state==='pending'?'partial':material.coverage.state;
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
        const card=this.memories.get(memory.id);
        if(!this.memoryLineageVisible({dependencyIds:ids,evidenceIds:card.evidenceIds,evidence:card.evidence.map(value=>({id:value.id,contentHash:value.contentHash})),scopeRefs:card.scopeRefs},args,false,{policy,operation},operation==='memory'))continue;
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
  agent(options:{assertSources?:(ids:readonly string[],kind?:'text'|'image')=>void;assertEvidence?:(ids:readonly string[],kind?:'text'|'image')=>void;diagnostics:ServerDiagnostics;allowQueryImages?:()=>boolean;exposurePolicy?:EvidenceExposurePolicy;currentOperation?:()=> 'query'|'memory';currentContextTime?:()=>string|undefined;currentGrantContext?:()=>object|undefined;currentProcessingEvidence?:()=>Readonly<Record<string,string>>|undefined;currentMaterialInputs?:()=>readonly MaterialInputPin[]|undefined}):ContextReader {
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
      if(pinned){const record=this.store.evidence([id])[0],canonical=this.memories.readEvidence([id])[0];
        if(record&&canonical&&this.store.isCurrentEvidence(id)&&record.ocr?.status!=='pending'&&record.ocr?.status!=='failed'&&memoryEvidenceFingerprint(canonical)===pinned)return true;
      }
      return operation('expand')==='expand'&&Boolean(currentGrants()?.get(id)?.some(source=>grantIsCurrent(id,source)));
    };
    const boundedEvidenceAllowed=(record:CaptureRecord,batch?:{canonical:Map<string,CaptureRecord>;selections:Map<MaterialInputPin,boolean>;inputs?:readonly MaterialInputPin[]})=>{
      const inputs=batch?batch.inputs:options.currentMaterialInputs?.();
      const imageGrant=(options.currentGrantContext?.() as {processingImages?:readonly MemoryImageGrant[]}|undefined)?.processingImages?.find(grant=>grant.id===record.id);
      if((operation('expand')==='memory'||imageGrant)&&inputs?.length&&record.provenance?.uri?.startsWith('material:')){
        const expected=options.currentProcessingEvidence?.()?.[record.id],canonical=expected&&(batch?batch.canonical.get(record.id):this.memories.readEvidence([record.id])[0]);
        if(!canonical||memoryEvidenceFingerprint(canonical)!==expected)return false;
        return inputs.some(pin=>{
          if(!pin.evidenceIds.includes(record.id))return false;
          if(imageGrant&&(pin.materialId!==imageGrant.materialId||pin.fingerprint!==imageGrant.fingerprint||JSON.stringify(pin.required)!==JSON.stringify(imageGrant.required)))return false;
          if(batch?.selections.has(pin))return batch.selections.get(pin)!;
          const material=this.materials?.get(pin.materialId),selection=material&&this.materials?.input(material.ref,pin.required);
          const allowed=Boolean(selection?.ready&&selection.fingerprint===pin.fingerprint&&material&&this.materialExposure(material,'memory',policy,pin.required));
          batch?.selections.set(pin,allowed);return allowed;
        });
      }
      return this.captureExposure(record,operation('expand'),policy,'capture',hasScreenGrant(record.id));
    };
    return {
      catalog:async args=>{
        const pin=this.memoryToolSnapshot(options.currentGrantContext?.());
        try{
          const page=await contextIndexAsync(this.store,{page:scope=>this.memoryPageAsync({...scope,asOf:scope?.asOf??options.currentContextTime?.()},false,pin.snapshot,{policy,operation:operation('discover')})},this.sources,args,scope=>this.agentSegments(scope,policy,operation('discover'))),ids=new Set<string>();let complete=true;
          for(const value of page.entries){const entry=value as {layer?:string;id?:string;revision?:string};
            if(entry.layer==='source'){if(entry.id)options.assertSources?.([entry.id]);continue;}if(!entry.id)continue;
            if(entry.layer==='memory'){
              const dependencies=this.store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=?').all(entry.id);if(!dependencies.length){complete=false;continue;}
              ids.add(entry.id);for(const row of dependencies)for(const id of this.memories.dependencyIds(String(row.evidence_id)))ids.add(id);
            }else if(entry.revision){const originals=this.artifactMembers(entry.id,entry.revision,args);if(!originals){complete=false;continue;}for(const id of originals.members)for(const dependency of this.memories.dependencyIds(id))ids.add(dependency);
            }else complete=false;
          }
          return {...page,disclosureDependencies:{version:1 as const,complete,ids:[...ids]}};
        }finally{pin.release();}
      },
      materialCatalog:async args=>{const page=this.materialCatalog(args),items=page.items.filter(material=>this.materialExposure(material,operation('discover'),policy));return {...page,items,disclosureDependencies:this.materialDisclosureDependencies(items.map(item=>item.ref))};},
      materialRead:async args=>{
        const material=this.materials?.get(args.ref);if(!material||this.materials?.get(material.id)?.ref!==material.ref||!this.materialExposure(material,operation('expand'),policy))throw new StoreError('Material not found in selected scope',404);
        const page=this.materialRead(args);grant(page.originalRefs,{kind:'material',ref:material.ref,scope:{...args}});
        // Compressed screen blocks do not declare a capture OCR offset map.
        const mappedRefs=material.kind==='mote.screen-segment'?[]:page.spans.flatMap(span=>span.evidenceId?[formatEvidenceRef('capture',span.evidenceId)]:[]);
        const originalRefs=[...new Set([...mappedRefs,...page.originalRefs])].slice(0,30);
        const originals=this.context(this.evidence(originalRefs,args).filter(record=>boundedEvidenceAllowed(record)));
        const sourceSpans=page.spans.flatMap(span=>{
          const record=originals.find(record=>record.id===span.evidenceId),offset=span.evidenceOffset;
          // The organizer's immutable block mapping identifies source offsets.
          // Derived summaries/interpretations and mapping-less capture members
          // remain navigation only and require a separate original read.
          if(!record||record.provenance?.document?.contentRole==='summary'||!Number.isSafeInteger(offset)||offset!<0)return [];
          const body=page.text.slice(span.pageRange.start,span.pageRange.end),length=Math.min(body.length,record.ocrText.length-offset!);
          if(length<1||record.ocrText.slice(offset!,offset!+length)!==body.slice(0,length))return [];
          return [{record,offset:offset!,length}];
        });
        const originalRefsTotal=Math.max(page.originalRefsTotal,new Set([...mappedRefs,...page.originalRefs]).size);
        return {...page,originalRefs,originalRefsTotal,originalRefsTruncated:page.originalRefsTruncated||originalRefsTotal>originalRefs.length,sourceSpans,disclosureDependencies:this.materialDisclosureDependencies([material.ref])};
      },
      readImage:async (input)=>{
        const {id,attachmentId}=input;
        options.assertEvidence?.([id],'image');
        if(!options.allowQueryImages?.())throw new ContextToolError('image_disclosure_disabled','Original-image access for queries is off. The owner must enable on-demand image access in Central Perception settings before a new query. Do not repeat this image request.','stop');
        const context=options.currentGrantContext?.() as {processingImages?:readonly MemoryImageGrant[]}|undefined;
        if(context?.processingImages?.length){
          const grant=context?.processingImages?.find(grant=>grant.id===id);
          const authorized=()=>{
            if(!grant||attachmentId!==undefined||!this.materials||!options.allowQueryImages?.())return;
            const material=this.materials.get(grant.materialId),selection=material&&this.materials.input(material.ref,grant.required);
            if(!selection?.ready||selection.fingerprint!==grant.fingerprint||!selection.evidenceIds.includes(id)||
              !this.materialExposure(material!,'memory',policy,grant.required))return;
            return memoryImageOriginal(store,grant);
          };
          const original=authorized();if(!original)throw new StoreError('Image is outside the frozen Memory original scope',404);
          return readEvidenceImage(store,this.files,this.archivedFiles,{...input,id:original,expectedImageSha256:grant!.originalSha256},()=>authorized()===original);
        }
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
      mediaActivity:async args=>diagnostics.measure('source','activity',()=>{const ids=new Set<string>(),result=store.mediaActivity(args,id=>ids.add(id));options.assertEvidence?.([...ids]);return {...result,disclosureDependencies:{version:1 as const,complete:true,ids:[...ids]}};},result=>({count:result.observations})),
      sourceHistory:async args=>this.sourceHistory({...args,id:formatEvidenceRef('capture',z.string().uuid().parse(args.id))}).filter(record=>this.captureExposure(record,operation('expand'),policy)),
      sources:async args=>{const page=browseSourceContexts(store,sources,args);options.assertSources?.(page.items.map(item=>item.id));return page;},
      sourceContext:async args=>{
        const pin=parseSourceContextRef(args.sourceContextRef);if(!pin)throw new StoreError('Invalid source context reference');
        options.assertSources?.([pin.sourceId]);
        const source=sources.getSource(pin.sourceId);if(args.deviceId&&source.deviceId!==args.deviceId)throw new StoreError('Source context is outside the selected scope',404);
        const contexts=new SourceContextStore(store),current=contexts.identity(pin.sourceId);
        if(!current||current.version!==pin.version||current.fingerprint!==pin.fingerprint)throw new ContextToolError('attribution_context_changed','The source description changed. Discover its current sourceContextRef and restart; do not combine versions.','correct_arguments');
        return {attributionContext:{version:1,ownerRelation:'unknown',basis:'default',sourceContextDeclarations:[pin],sourceContextStatements:contexts.open([pin])}};
      },
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
        const pin=this.memoryToolSnapshot(options.currentGrantContext?.());try{
        const id=args.id===undefined?undefined:formatEvidenceRef('memory',z.string().uuid().parse(args.id));
        const page=await this.memoryPageAsync({...args,id,asOf:args.asOf??options.currentContextTime?.(),level:args.id?'detail':'overview'},false,pin.snapshot,{policy,operation:operation('discover')});
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
        }finally{pin.release();}
      },
      search:async args=>diagnostics.measure('source','search',async()=>{const results=await this.agentSearch(args,policy,operation('discover'));return Object.assign(this.context(results),{retrieval:results.retrieval});},rows=>({count:rows.length})),timeline:async args=>diagnostics.measure('source','timeline',()=>{const page=this.agentTimeline(args,policy,operation('discover'));return {...page,items:this.context(page.items)};},page=>({count:page.items.length})),evidence:async args=>diagnostics.measure('source','evidence',()=>{
        const read=()=>{
          const inputs=options.currentMaterialInputs?.(),canonical=new Map<string,CaptureRecord>();
          if(inputs?.length)for(const record of this.memories.readEvidence(args.ids.map(ref=>evidenceRefId(ref,'capture')??ref)))if(!canonical.has(record.id))canonical.set(record.id,record);
          const batch={inputs,canonical,selections:new Map<MaterialInputPin,boolean>()};
          return this.context(this.evidenceById(args.ids,args,{scoped:new Map(),heads:new Map()}).filter(record=>boundedEvidenceAllowed(record,batch)));
        };
        return this.materials?this.materials.withReadMetadata(read):read();
      },rows=>({count:rows.length})),
      activity:async args=>diagnostics.measure('source','activity',()=>{const ids=new Set<string>(),result=store.activity(args,id=>ids.add(id));options.assertEvidence?.([...ids]);return {...result,disclosureDependencies:{version:1 as const,complete:true,ids:[...ids]}};},result=>({count:result.captures})),
      devices:async()=>diagnostics.measure('source','devices',()=>{const items=store.devices();options.assertSources?.(items.map(item=>'device:'+item.deviceId));return {items,observedAt:new Date().toISOString(),disclosureDependencies:{version:1 as const,complete:true,ids:[]}};},page=>({count:page.items.length}))};
  }
}
