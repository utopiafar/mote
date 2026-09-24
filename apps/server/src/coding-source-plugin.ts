import type {Context} from '@deepseek-ai/cordis';
import {sourceItemSchema,type SourceConnection,type SourceItem} from '@mote/shared';
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
    base.record.artifacts?.some(artifact=>artifact.key==='conversation'&&artifact.state==='ready')&&base.lastBlock?.format==='markdown-fragment'){
    const delta=await codingPageRange(reader,source,identity,signal,base);
    if(delta&&delta.appendEpoch===base.appendEpoch&&delta.items.every(item=>!item.deleted&&item.layer!=='reference'&&
      item.document?.coding?.parts===1&&item.document.coding.part===0&&
      Date.parse(item.document.recordedAt??item.observedAt)>=Date.parse(base.record.origin.lastAt??'1970-01-01T00:00:00.000Z')))
      return {...delta,mode:'append',base};
  }
  const full=await codingPageRange(reader,source,identity,signal);
  if(!full)throw new StoreError('Coding raw snapshot is unavailable',409);
  return {...full,mode:'full'};
}
const eventText=(item:SourceItem)=>{const c=item.document!.coding!;return `## ${c.role} · ${item.document?.recordedAt?'Recorded: '+item.document.recordedAt:'Observed: '+item.observedAt}\n\nEvent: ${c.eventId} · Part: ${c.part}/${c.parts}${c.callId?' · Call: '+c.callId:''}\n\n${item.layer==='reference'?'[Body not collected]':item.text}\n\n`;};
const organize:NonNullable<SourcePipeline['organize']>=({source,items,group:identity})=>{
      const [provider,projectKey,sessionId]=JSON.parse(identity) as string[];
      const records=items.filter(item=>!item.deleted).sort((a,b)=>{
        const at=a.document?.recordedAt??a.observedAt,bt=b.document?.recordedAt??b.observedAt;
        return Date.parse(at)-Date.parse(bt)||(a.document?.coding?.eventId===b.document?.coding?.eventId?(a.document?.coding?.part??0)-(b.document?.coding?.part??0):0);
      });
      // Keep the logical document complete. Physical blocks are bounded reads,
      // not event records; a block may contain many messages or part of one.
      const blocks:MaterialDraft['blocks']=[];let buffer='';
      const flush=()=>{if(buffer){blocks.push({id:'section-'+blocks.length,kind:'text',format:'markdown-fragment',text:buffer,memberIds:['archive']});buffer='';}};
      const append=(text:string)=>{
        while(text){let take=Math.min(12000-buffer.length,text.length);if(take<text.length&&/[\uD800-\uDBFF]/.test(text[take-1])&&/[\uDC00-\uDFFF]/.test(text[take]))take--;
          if(!take){flush();continue;}buffer+=text.slice(0,take);text=text.slice(take);if(buffer.length>=11999)flush();}
      };
      append(`# Coding conversation\n\nProvider: ${provider}\nSession: ${sessionId}\n\n`);
      for(const item of records)append(eventText(item));
      flush();const times=records.map(item=>new Date(item.document?.recordedAt??item.observedAt).toISOString()).sort();
      const events=new Map<string,{parts:number;seen:Set<number>}>();for(const item of records){const c=item.document!.coding!;const event=events.get(c.eventId)??{parts:c.parts,seen:new Set<number>()};event.parts=Math.max(event.parts,c.parts);event.seen.add(c.part);events.set(c.eventId,event);}
      const missingParts=[...events.values()].some(event=>event.seen.size!==event.parts||[...event.seen].some(part=>part>=event.parts));
      const partial=!records.length?'no_events':records.some(item=>item.layer==='reference')?'original_body_not_collected':missingParts?'missing_event_parts':undefined;
      const conversationState=!records.length||partial==='original_body_not_collected'?'unavailable':missingParts?'pending':'ready';
      return {id:materialId(source.id,identity),kind:'mote.coding-session',schemaVersion:2,
        title:records[0]?.document?.coding?.projectName??sessionId,
        origin:{sourceId:source.id,externalId:identity,deviceId:source.deviceId,provider,projectKey,sessionId,...(times.length?{firstAt:times[0],lastAt:times.at(-1)!}:{})},blocks,
        members:[{id:'archive',kind:'archive',ref:'archive:'+archiveHash([source.id,identity])}],
        coverage:partial?{state:'partial',reason:partial}:{state:'complete'},
        artifacts:[{key:'conversation',state:conversationState,revision:archiveHash(records.map(item=>[item.externalId,item.revision])),...(partial?{reason:partial}:{})}],
        fidelity:{state:'derived',limitations:['metadata_projected']},retention:{original:'retained',policy:'keep'}};
};
const organizeAppend=(source:SourceConnection,identity:string,snapshot:RecipeSnapshot):MaterialAppendDraft=>{
  const base=snapshot.base!;const prior=base.record;
  const records=[...snapshot.items].sort((a,b)=>Date.parse(a.document?.recordedAt??a.observedAt)-Date.parse(b.document?.recordedAt??b.observedAt));
  const reuseBlocks=records.length&&base.lastBlock!.text.length<11999?prior.blockCount-1:prior.blockCount;
  const blocks:MaterialAppendDraft['blocks']=[];let buffer=reuseBlocks<prior.blockCount?base.lastBlock!.text:'';
  const flush=()=>{if(buffer){blocks.push({id:`section-${reuseBlocks+blocks.length}`,kind:'text',format:'markdown-fragment',text:buffer,memberIds:['archive']});buffer='';}};
  const append=(text:string)=>{while(text){let take=Math.min(12000-buffer.length,text.length);
    if(take<text.length&&/[\uD800-\uDBFF]/.test(text[take-1])&&/[\uDC00-\uDFFF]/.test(text[take]))take--;
    if(!take){flush();continue;}buffer+=text.slice(0,take);text=text.slice(take);if(buffer.length>=11999)flush();}};
  for(const item of records)append(eventText(item));flush();
  const newLast=records.length?new Date(records.at(-1)!.document?.recordedAt??records.at(-1)!.observedAt).toISOString():prior.origin.lastAt;
  const conversation=prior.artifacts?.find(artifact=>artifact.key==='conversation');
  return {mode:'append',baseRevision:prior.revision,reuseBlocks,id:prior.id,kind:'mote.coding-session',schemaVersion:prior.schemaVersion,
    title:prior.title,origin:{...prior.origin,...(newLast?{lastAt:newLast}:{})},blocks,
    members:[{id:'archive',kind:'archive',ref:'archive:'+archiveHash([source.id,identity])}],
    coverage:{state:'complete'},artifacts:[{key:'conversation',state:'ready',revision:archiveHash([conversation?.revision??'',records.map(item=>[item.externalId,item.revision])])}],
    fidelity:prior.fidelity,retention:prior.retention};
};

/** The recipe selects trusted, versioned capabilities; its data never carries code. */
export function codingSourcePlugin(ctx:Context){
  const recipes=ctx.moteSourceRecipes;
  ctx.effect(()=>recipes.registerRawWriter({id:'mote.source-archive-writer',version:'1',kind:'raw-writer'},(archive,source,items,groups)=>archive.receive(source.id,items,groups)));
  ctx.effect(()=>recipes.registerRawReader({id:'mote.source-archive-reader',version:'1',kind:'raw-reader'},readCodingSnapshot));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.retain-source-archive',version:'1',kind:'raw-retention'}));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.on-receive',version:'1',kind:'trigger'}));
  ctx.effect(()=>recipes.registerGroup({id:'mote.coding-group',version:'1',kind:'group'},group));
  ctx.effect(()=>recipes.registerStep({id:'mote.coding-assemble',version:'3',kind:'step'},input=>input.snapshot.mode==='append'?
    organizeAppend(input.source,input.group,input.snapshot):organize({source:input.source,items:[...input.items],group:input.group})));
  ctx.effect(()=>recipes.registerPublisher({id:'mote.material-draft',version:'1',kind:'publish'},input=>input.outputs.assemble as MaterialDraft|MaterialAppendDraft|undefined));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.material-index',version:'1',kind:'index'}));
  ctx.effect(()=>recipes.registerPolicy({id:'mote.coding-exposure',version:'2',kind:'exposure'}));
  ctx.effect(()=>recipes.installRecipe({
    schemaVersion:1,id:'mote.coding',version:'4',accepts:{sourceKind:'coding-agent'},
    raw:{writer:{id:'mote.source-archive-writer'},reader:{id:'mote.source-archive-reader'},retention:{id:'mote.retain-source-archive'}},
    trigger:{policy:{id:'mote.on-receive'}},group:{policy:{id:'mote.coding-group'}},
    steps:[{id:'assemble',use:{id:'mote.coding-assemble'},dependsOn:[]}],
    publish:{use:{id:'mote.material-draft'}},index:{use:{id:'mote.material-index'}},
    exposure:{use:{id:'mote.coding-exposure'},routes:[
      {audience:'query',operation:'ask',phase:'pending',readProjection:'material'},
      {audience:'query',operation:'ask',phase:'partial',readProjection:'material'},
      {audience:'query',operation:'ask',phase:'ready',readProjection:'material'},
      {audience:'memory',operation:'derive',phase:'ready',readProjection:'material'},
    ]},
  }));
  ctx.effect(()=>ctx.moteSourcePipelines.register({
    id:'mote.coding',version:'4',recipe:{id:'mote.coding',version:'4'},reprocess:'deterministic',sourceKinds:['coding-agent'],storage:'archive',index:'material',modelInput:'material',memory:true,memoryDependencies:['conversation'],
    // Retained temporarily for explicit legacy pipeline migration tests. Coding
    // production work executes the registered recipe implementations above.
    group,organize,
  }));
}
