import {codingProjectContext} from './coding-project.js';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import type {Context,Plugin} from '@deepseek-ai/cordis';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {BackendPluginScope} from './backend-plugin-scope.js';
import type {SourcePipelineRuntime} from './source-pipelines.js';
import type {SourceStore} from './sources.js';
import type {Store} from './store.js';
import {codingConversationEvidence,codingDialogueText,CODING_DIALOGUE_SCHEMA_VERSION,sourceItemSchema,type SourceConnection,type SourceItem} from '@mote/shared';
import {materialId,type CodingAppendBase,type MaterialAppendDraft,type MaterialDraft} from './materials.js';
import {archiveHash} from './source-archive.js';
import {StoreError} from './store.js';
import type {SourcePipeline} from './source-pipelines.js';
import {sourceArchiveCollectionRef} from './source-archive-reader.js';
import {MAX_RAW_PAGE_ITEMS,MAX_RAW_READ_BYTES,type RawReader} from './raw-reader.js';
import type {RecipeSnapshot} from './source-recipe-executor.js';

const group=(item:SourceItem)=>{
  const coding=item.document?.coding;
  if(!coding)throw new StoreError('Coding source requires explicit session identity');
  return JSON.stringify([coding.provider,coding.projectKey,coding.sessionId]);
};
/** Reassemble transport parts before recognizing a complete host envelope.
 * Legacy rows without speaker metadata remain explicitly unattributed. */
function conversationRecords(items:SourceItem[]){
  const active=items.filter(item=>!item.deleted),events=new Map<string,SourceItem[]>();
  for(const item of active){const id=item.document!.coding!.eventId;const event=events.get(id)??[];event.push(item);events.set(id,event);}
  const admitted=new Map<string,SourceItem[]>();
  for(const [id,parts] of events){
    const ordered=[...parts].sort((a,b)=>a.document!.coding!.part-b.document!.coding!.part),coding=ordered[0]!.document!.coding!;
    const complete=ordered.length===coding.parts&&ordered.every((item,index)=>item.document!.coding!.part===index&&item.document!.coding!.parts===coding.parts);
    const original=ordered.map(item=>item.text).join(''),text=codingDialogueText(coding,original);
    if(complete&&text&&ordered.every(item=>codingConversationEvidence(item.document!.coding!))&&codingConversationEvidence(coding,text)){
      admitted.set(id,text===original?ordered:[{...ordered[0],text,document:{...ordered[0].document,coding:{...coding,part:0,parts:1}}}]);
    }
  }
  return [...admitted.values()].flat();
}
/** The same ordered visible events yield the same artifact identity whether
 * assembled in one pass or appended. Private archive activity is not a part. */
const conversationRevision=(records:SourceItem[],seed=archiveHash('mote.coding.conversation-v1'))=>
  records.reduce((revision,item)=>archiveHash([revision,item.externalId,item.revision]),seed);
/** The recipe consumes only the scoped read surface. Cursor and range checks
 * pin one complete group snapshot even if a new receive occurs mid-read. */
async function codingPageRange(reader:RawReader,source:SourceConnection,identity:string,signal:AbortSignal,base?:CodingAppendBase){
  const collectionRef=sourceArchiveCollectionRef(source.id,identity),items:SourceItem[]=[],seenRefs=new Set<string>(),seenCursors=new Set<string>();
  let cursor:string|undefined,checkpoint:string|undefined,total:number|undefined,appendEpoch:number|undefined,first=true;
  do{
    signal.throwIfAborted();
    const page=await reader.page({collectionRef,cursor,limit:MAX_RAW_PAGE_ITEMS,
      ...(first&&base?{seek:{offset:base.headCount,appendEpoch:base.appendEpoch}}:{})});
    if(first&&base&&(page.status==='stale_cursor'||page.status==='invalid_cursor'))return;
    if(page.status!=='available')throw new StoreError(`Coding raw page ${page.status}`,409);
    if(page.items.length>MAX_RAW_PAGE_ITEMS||!Number.isSafeInteger(page.total)||page.total<0||!Number.isSafeInteger(page.appendEpoch)||
      checkpoint!==undefined&&(page.snapshot!==checkpoint||page.total!==total||page.appendEpoch!==appendEpoch))throw new StoreError('Coding raw snapshot changed',409);
    checkpoint=page.snapshot;total=page.total;appendEpoch=page.appendEpoch;first=false;
    for(const entry of page.items){
      signal.throwIfAborted();
      if(seenRefs.has(entry.ref))throw new StoreError('Coding raw page repeated a revision',409);
      seenRefs.add(entry.ref);
      let offset=0,expectedBytes:number|undefined;const chunks:Buffer[]=[];
      for(;;){
        signal.throwIfAborted();
        const part=await reader.read(entry.ref,{offset,length:MAX_RAW_READ_BYTES});
        if(part.status!=='available')throw new StoreError(`Coding raw read ${part.status}`,409);
        if(part.ref!==entry.ref||part.offset!==offset||!Number.isSafeInteger(part.totalBytes)||part.totalBytes<1||part.totalBytes>1_000_000||part.bytes.length<1||part.bytes.length>MAX_RAW_READ_BYTES||expectedBytes!==undefined&&part.totalBytes!==expectedBytes)throw new StoreError('Coding raw range changed',409);
        expectedBytes=part.totalBytes;const next=offset+part.bytes.length;
        if(part.nextOffset!==null&&part.nextOffset!==next||part.nextOffset===null&&next!==part.totalBytes)throw new StoreError('Coding raw range is incomplete',409);
        chunks.push(Buffer.from(part.bytes));offset=next;
        if(part.nextOffset===null)break;
      }
      const item=sourceItemSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if(group(item)!==identity)throw new StoreError('Coding raw group changed',409);
      items.push(item);
    }
    if(page.nextCursor){if(seenCursors.has(page.nextCursor))throw new StoreError('Coding raw cursor repeated',409);seenCursors.add(page.nextCursor);}
    cursor=page.nextCursor??undefined;
    // The reader methods may resolve synchronously. Yield after each bounded
    // page so deadline, lease renewal and source revocation timers can run.
    await new Promise<void>(resolve=>setImmediate(resolve));
    signal.throwIfAborted();
  }while(cursor);
  if(items.length!==total-(base?.headCount??0)||checkpoint===undefined||appendEpoch===undefined)throw new StoreError('Coding raw snapshot is incomplete',409);
  return {items,checkpoint,headCount:total,appendEpoch};
}
async function readCodingSnapshot(reader:RawReader,source:SourceConnection,identity:string,signal:AbortSignal,base?:CodingAppendBase):Promise<RecipeSnapshot>{
  if(base&&base.record.origin.sourceId===source.id&&base.record.origin.externalId===identity&&base.record.coverage.state==='complete'&&
    base.record.schemaVersion>=CODING_DIALOGUE_SCHEMA_VERSION&&base.record.artifacts?.some(artifact=>artifact.key==='conversation'&&artifact.state==='ready')&&base.lastBlock?.format==='markdown-fragment'){
    const delta=await codingPageRange(reader,source,identity,signal,base);
    if(delta){const visible=conversationRecords(delta.items);
      if((!visible.length||Object.entries(codingProjectContext(visible.map(item=>item.document!.coding!))).every(([key,value])=>value===(base.record.origin as Record<string,unknown>)[key]))&&delta.appendEpoch===base.appendEpoch&&delta.items.every(item=>!item.deleted)&&visible.every(item=>item.layer!=='reference'&&
        item.document?.coding?.parts===1&&item.document.coding.part===0&&
        Date.parse(item.document.recordedAt??item.observedAt)>=Date.parse(base.record.origin.lastAt??'1970-01-01T00:00:00.000Z')))
        if(!delta.items.some(item=>codingConversationEvidence(item.document!.coding!)&&item.document!.coding!.parts>1))return {...delta,mode:'append',base};
    }
  }
  const full=await codingPageRange(reader,source,identity,signal);
  if(!full)throw new StoreError('Coding raw snapshot is unavailable',409);
  return {...full,mode:'full'};
}
const eventText=(item:SourceItem)=>{const c=item.document!.coding!,attribution=c.attribution??(['assistant','assistant_delta'].includes(c.role)?'agent':'unknown');return `## ${c.role} · ${item.document?.recordedAt?'Recorded: '+item.document.recordedAt:'Observed: '+item.observedAt}\n\nEvent: ${c.eventId} · Part: ${c.part}/${c.parts} · Attribution: ${attribution}${c.channel?' · Channel: '+c.channel:''}\n\n${item.layer==='reference'?'[Body not collected]':item.text}\n\n`;};
/** Blocks may span several event times. Keep those in their labeled event
 * headers; the block context declares only its earliest actual observation. */
class CodingMaterialBody {
  readonly blocks:MaterialDraft['blocks']=[];
  constructor(private firstIndex=0,private buffer='',private observedAt?:string){}
  flush(){
    if(!this.buffer)return;
    this.blocks.push({id:`section-${this.firstIndex+this.blocks.length}`,kind:'text',format:'markdown-fragment',text:this.buffer,memberIds:['archive'],
      ...(this.observedAt?{evidenceContext:{observedAt:this.observedAt,document:{timeBasis:'unknown',contentRole:'transcript'}}}:{})});
    this.buffer='';this.observedAt=undefined;
  }
  append(text:string,observedAt?:string){
    while(text){
      let take=Math.min(12000-this.buffer.length,text.length);
      if(take<text.length&&/[\uD800-\uDBFF]/.test(text[take-1])&&/[\uDC00-\uDFFF]/.test(text[take]))take--;
      if(!take){this.flush();continue;}
      if(observedAt&&(!this.observedAt||Date.parse(observedAt)<Date.parse(this.observedAt)))this.observedAt=observedAt;
      this.buffer+=text.slice(0,take);text=text.slice(take);if(this.buffer.length>=11999)this.flush();
    }
  }
}
const organize=({source,items,group:identity}:{source:SourceConnection;items:SourceItem[];group:string}):MaterialDraft=>{
      const [provider,projectKey,sessionId]=JSON.parse(identity) as string[];
      const records=conversationRecords(items).sort((a,b)=>{
        const at=a.document?.recordedAt??a.observedAt,bt=b.document?.recordedAt??b.observedAt;
        return Date.parse(at)-Date.parse(bt)||(a.document?.coding?.eventId===b.document?.coding?.eventId?(a.document?.coding?.part??0)-(b.document?.coding?.part??0):0);
      });
      // Keep the logical document complete. Physical blocks are bounded reads,
      // not event records; a block may contain many messages or part of one.
      const body=new CodingMaterialBody();
      body.append(`# Coding dialogue\n\nProvider: ${provider}\nSession: ${sessionId}\n\nUntrusted evidence: human messages and protocol-confirmed final replies only. Process text, tools, host envelopes, unconfirmed replies and oversized messages are excluded by rules before indexing or model processing. Agent reports are not independently verified.\n\n`);
      for(const item of records)body.append(eventText(item),item.observedAt);
      body.flush();const times=records.map(item=>new Date(item.document?.recordedAt??item.observedAt).toISOString()).sort();
      const events=new Map<string,{parts:number;seen:Set<number>}>();for(const item of items.filter(item=>!item.deleted&&codingConversationEvidence(item.document!.coding!))){const c=item.document!.coding!;const event=events.get(c.eventId)??{parts:c.parts,seen:new Set<number>()};event.parts=Math.max(event.parts,c.parts);event.seen.add(c.part);events.set(c.eventId,event);}
      const missingParts=[...events.values()].some(event=>event.seen.size!==event.parts||[...event.seen].some(part=>part>=event.parts));
      const partial=missingParts?'missing_event_parts':!records.length?'no_events':records.some(item=>item.layer==='reference')?'original_body_not_collected':undefined;
      const conversationState=missingParts?'pending':!records.length||partial==='original_body_not_collected'?'unavailable':'ready';
      const project=codingProjectContext(records.map(item=>item.document!.coding!));
      return {id:materialId(source.id,identity),kind:'mote.coding-session',schemaVersion:CODING_DIALOGUE_SCHEMA_VERSION,
        title:project.projectName??sessionId,
        origin:{sourceId:source.id,externalId:identity,deviceId:source.deviceId,provider,projectKey,sessionId,...project,...(times.length?{firstAt:times[0],lastAt:times.at(-1)!}:{})},blocks:body.blocks,
        members:[{id:'archive',kind:'archive',ref:'archive:'+archiveHash([source.id,identity])}],
        coverage:partial?{state:'partial',reason:partial}:{state:'complete'},
        artifacts:[{key:'conversation',state:conversationState,revision:conversationRevision(records),...(partial?{reason:partial}:{})}],
        fidelity:{state:'derived',limitations:['metadata_projected','tool_bodies_omitted','host_context_omitted','process_messages_omitted','unconfirmed_replies_omitted','oversized_messages_omitted']},retention:{original:'retained',policy:'keep'}};
};
const organizeAppend=(source:SourceConnection,identity:string,snapshot:RecipeSnapshot):MaterialAppendDraft=>{
  const base=snapshot.base!;const prior=base.record;
  const records=conversationRecords(snapshot.items).sort((a,b)=>Date.parse(a.document?.recordedAt??a.observedAt)-Date.parse(b.document?.recordedAt??b.observedAt));
  const reuseBlocks=records.length&&base.lastBlock!.text.length<11999?prior.blockCount-1:prior.blockCount;
  const tail=reuseBlocks<prior.blockCount?base.lastBlock:undefined;
  const body=new CodingMaterialBody(reuseBlocks,tail?.text,tail?.evidenceContext?.observedAt);
  for(const item of records)body.append(eventText(item),item.observedAt);body.flush();
  const newLast=records.length?new Date(records.at(-1)!.document?.recordedAt??records.at(-1)!.observedAt).toISOString():prior.origin.lastAt;
  const conversation=prior.artifacts?.find(artifact=>artifact.key==='conversation');
  return {mode:'append',baseRevision:prior.revision,reuseBlocks,id:prior.id,kind:'mote.coding-session',schemaVersion:prior.schemaVersion,
    title:prior.title,origin:{...prior.origin,...(newLast?{lastAt:newLast}:{})},blocks:body.blocks,
    members:[{id:'archive',kind:'archive',ref:'archive:'+archiveHash([source.id,identity])}],
    coverage:{state:'complete'},artifacts:records.length?[{key:'conversation',state:'ready',revision:conversationRevision(records,conversation?.revision)}]:prior.artifacts,
    fidelity:prior.fidelity,retention:prior.retention};
};

/** The recipe selects trusted, versioned capabilities; its data never carries code. */
export function codingSourcePlugin(ctx:Context,options:{accepting?:boolean}={}){
  const recipes=ctx.moteSourceRecipes;
  ctx.effect(()=>ctx.moteMaterialCatalog.register({id:'mote.coding-session',kind:'mote.coding-session',schemaVersion:CODING_DIALOGUE_SCHEMA_VERSION,label:'Coding Agent 会话'}));
  ctx.effect(()=>recipes.registerRawWriter({id:'mote.source-archive-writer',version:'1',kind:'raw-writer'},(archive,source,items,groups)=>archive.receive(source.id,items,groups)));
  ctx.effect(()=>recipes.registerRawReader({id:'mote.source-archive-reader',version:'1',kind:'raw-reader'},readCodingSnapshot));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.retain-source-archive',version:'1',kind:'raw-retention'}));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.on-receive',version:'1',kind:'trigger'}));
  ctx.effect(()=>recipes.registerGroup({id:'mote.coding-group',version:'1',kind:'group'},group));
  ctx.effect(()=>recipes.registerStep({id:'mote.coding-assemble',version:'7',kind:'step'},input=>input.snapshot.mode==='append'?
    organizeAppend(input.source,input.group,input.snapshot):organize({source:input.source,items:[...input.items],group:input.group})));
  ctx.effect(()=>recipes.registerPublisher({id:'mote.material-draft',version:'1',kind:'publish'},input=>input.outputs.assemble as MaterialDraft|MaterialAppendDraft|undefined));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.material-index',version:'1',kind:'index'}));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.coding-exposure',version:'3',kind:'exposure'}));
  ctx.effect(()=>recipes.installRecipe({
    schemaVersion:1,id:'mote.coding',version:'8',accepts:{sourceKind:'coding-agent'},
    raw:{writer:{id:'mote.source-archive-writer'},reader:{id:'mote.source-archive-reader'},retention:{id:'mote.retain-source-archive'}},
    trigger:{policy:{id:'mote.on-receive'}},group:{policy:{id:'mote.coding-group'}},
    steps:[{id:'assemble',use:{id:'mote.coding-assemble'},dependsOn:[]}],
    publish:{use:{id:'mote.material-draft'}},index:{use:{id:'mote.material-index'}},
    exposure:{use:{id:'mote.coding-exposure'},routes:[
      {audience:'query',operation:'ask',phase:'pending',readProjection:'material'},
      {audience:'query',operation:'ask',phase:'partial',readProjection:'material'},
      {audience:'query',operation:'ask',phase:'ready',readProjection:'material'},
      {audience:'query',operation:'ask',phase:'ready',readProjection:'segment'},
      {audience:'memory',operation:'derive',phase:'ready',readProjection:'material'},
    ]},
  }));
  ctx.effect(()=>ctx.moteSourcePipelines.register({
    id:'mote.coding',featureId:'mote.coding',version:'8',recipe:{id:'mote.coding',version:'8'},reprocess:'manual',sourceKinds:['coding-agent'],storage:'archive',index:'material',modelInput:'material',memoryDependencies:['conversation'],
  }));
  if(options.accepting===false)ctx.moteSourcePipelines.quiesce('mote.coding');
}

export const codingSourceContribution={
  id:'coding-source',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.source-runtime',version:'1.0.0'}],provides:[],
} as const satisfies ManifestContribution;
export const codingSourceDeclaration={id:codingSourceContribution.id,apiVersion:'1'} as const;
export const codingSourceReplacement='hot' as const;

interface CodingSourceDependencies {
  readonly runtime:SourcePipelineRuntime;
  readonly sources:SourceStore;
  readonly store:Store;
}
type CodingSourceActivation=CodingSourceDependencies;
export interface CodingSourceOptions {readonly plugins?:readonly Plugin[];}
export interface CodingSource extends PluginLifecycle {close():Promise<void>;}

const routeContributions=new WeakMap<SourcePipelineRuntime,ReturnType<typeof createCodingSourceRoutes>>();
export function codingSourceRoutesFor(runtime:SourcePipelineRuntime){return routeContributions.get(runtime);}

/** The route table survives activation replacement and resolves the current
 * coding-owned ports for every request. */
export function createCodingSourceRoutes(runtime:SourcePipelineRuntime){
  if(routeContributions.has(runtime))throw new StoreError('Coding source routes are already installed',409);
  let current:CodingSourceActivation|undefined;
  const mounted=new WeakSet<FastifyInstance>();
  const active=()=>{if(!current)throw new StoreError('Coding source is unavailable',503);return current;};
  const routes=Object.freeze({
    activate(activation:CodingSourceActivation){
      if(current&&current!==activation)throw new StoreError('Coding source is already active',409);
      current=activation;
    },
    deactivate(activation:CodingSourceActivation){if(current===activation)current=undefined;},
    mount(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Coding source routes are already installed',409);
      mounted.add(app);
      app.register(async child=>{
        child.addHook('onRequest',async(_request,reply)=>{if(!current)return reply.code(503).send({error:'feature_unavailable'});});
        child.get('/api/coding/uploads',async req=>{
          const {runtime:sourcePipelines,sources,store}=active();
          const {offset,limit}=z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().parse(req.query);
          const all=sources.listSources().filter(source=>source.kind==='coding-agent');
          const items=all.slice(offset,offset+limit).map(source=>({
            source:{id:source.id,name:source.name,deviceId:source.deviceId,enabled:source.enabled,status:source.status},
            received:store.db.prepare('SELECT count(*) AS events,max(observed_at) AS lastObservedAt FROM source_archive_heads WHERE source_id=?').get(source.id),
            archiveBytes:Number(store.db.prepare('SELECT bytes FROM source_archive_sizes WHERE source_id=?').get(source.id)?.bytes??0),
            work:store.db.prepare('SELECT state,count(*) AS count FROM source_pipeline_work WHERE source_id=? GROUP BY state').all(source.id),
            materials:Number(store.db.prepare('SELECT count(*) AS n FROM material_heads WHERE source_id=? AND retired=0').get(source.id)?.n??0),
            indexedMaterials:Number(store.db.prepare('SELECT count(*) AS n FROM material_searchable s JOIN material_heads h ON h.id=s.material_id WHERE h.source_id=? AND h.retired=0').get(source.id)?.n??0),
            memory:store.db.prepare("SELECT coalesce(json_extract(j.json,'$.status'),CASE WHEN w.auto_authorized=0 THEN 'not_requested' WHEN w.error IS NOT NULL THEN 'blocked' ELSE 'waiting' END) AS state,count(*) AS count FROM material_memory_requests w JOIN material_heads h ON h.id=w.material_id LEFT JOIN memory_jobs j ON j.id=w.job_id WHERE h.source_id=? AND h.retired=0 GROUP BY state").all(source.id),
            pipeline:(()=>{try{return sourcePipelines.select(source)?.id??null;}catch(error){if(error instanceof StoreError&&error.statusCode===409)return null;throw error;}})(),
          }));
          return {items,nextOffset:offset+limit<all.length?offset+limit:null};
        });
        child.get('/api/source-pipelines',async()=>active().runtime.status());
        child.get('/api/source-pipelines/:sourceId',async req=>{const {sourceId}=req.params as {sourceId:string};const activation=active();activation.sources.getSource(sourceId);return activation.runtime.options(sourceId);});
        child.delete('/api/source-pipelines/:sourceId',async req=>{const {sourceId}=req.params as {sourceId:string};const activation=active();activation.sources.getSource(sourceId);return activation.runtime.forget(sourceId);});
        child.put('/api/source-pipelines/:sourceId',async req=>{const {sourceId}=req.params as {sourceId:string};const activation=active();activation.sources.getSource(sourceId);return activation.runtime.configure(sourceId,req.body);});
      });
    },
  });
  routeContributions.set(runtime,routes);
  return routes;
}

/** Owns only the coding recipe scope. The shared runtime, Store and source
 * catalogue remain borrowed and continue serving other source kinds. */
export function createCodingSource(dependencies:CodingSourceDependencies,routes:ReturnType<typeof createCodingSourceRoutes>,options:CodingSourceOptions={}):CodingSource{
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let scope:BackendPluginScope|undefined,activation:CodingSourceActivation|undefined,closing:Promise<void>|undefined;
  const unavailable=()=>new StoreError('Coding source is unavailable',503);
  const close=()=>closing??=(async()=>{
    if(activation)routes.deactivate(activation);
    activation=undefined;const owned=scope;scope=undefined;
    try{await owned?.close();}finally{phase='stopped';}
  })();
  const quiesce=()=>{if(phase==='active'){phase='quiescing';dependencies.runtime.registry.quiesce('mote.coding');routes.deactivate(activation!);}};
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw unavailable();phase='preparing';
      try{
        scope=new BackendPluginScope(dependencies.runtime.context);
        await scope.install((ctx:Context)=>codingSourcePlugin(ctx,{accepting:false}));
        for(const plugin of options.plugins??[])await scope.install(plugin);
        activation={...dependencies};phase='prepared';
      }catch(error){
        try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Coding source preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){if(phase!=='prepared'||!activation)throw unavailable();routes.activate(activation);dependencies.runtime.registry.start('mote.coding');phase='active';},
    quiesce,
    async stop(_reason?:StopReason){quiesce();await dependencies.runtime.drainPipeline('mote.coding');await close();},
    dispose:close,close,
  });
}

export function createCodingSourceFactory(dependencies:CodingSourceDependencies,routes:ReturnType<typeof createCodingSourceRoutes>,options:CodingSourceOptions={}){
  return (context:HostPluginContext):PluginLifecycle=>{
    const source=createCodingSource(dependencies,routes,options);
    context.scope.defer(()=>source.close());
    return {prepare:()=>source.prepare(),start:()=>source.start(),quiesce:(reason:StopReason)=>source.quiesce(reason),stop:(reason:StopReason)=>source.stop(reason),dispose:()=>source.dispose()};
  };
}
