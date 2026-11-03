import {HOST_READ_OPERATIONS} from './tools/descriptor.js';
import {isDeepStrictEqual} from 'node:util';
import type {ImagePayload} from './tools/image-result.js';
import {attributionMetadata,attributionMetadataResponse} from './tools/result-metadata.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {imageReadSchema,imageViewSchema,IMAGE_MAX_BYTES,IMAGE_REGION_MAX_SIDE,type ImageView,type ImageViewTrace} from '@mote/shared';
import {CONTEXT_TOOLS} from './context-tools.js';
import {pinContextTools,contextToolSnapshot,releaseContextTools,hasPinnedContextTools} from './tool-contributions.js';
import type {HostSessionPort,HostReadOperation} from './tools/host-session.js';
import {validateCapabilityArguments} from './capability-schema.js';
import {rememberEvidence,evidenceLayers,copyEvidencePresentation,snapshotEvidenceLedger,restoreEvidenceLedger} from './evidence-ledger.js';
import {projectEvidence as project} from './evidence-receipt.js';
import {AgentYieldError,hostControlDefinitions} from './host-controls.js';
import {taskTools,dispatchTools} from './task-context.js';
import {actionEvidenceText,parseEvidenceRef,parseEvidenceId,formatEvidenceRef} from '@mote/shared';
import {ContextToolError} from './tool-errors.js';
import {AgentResponseError,reportTrace,reportProgress} from './types.js';
import {sourceProtocolInstructions} from './tasks/evidence-rules.js';
import {extractionSeedScopeValid} from './extraction-seed-scope.js';
import {randomBytes,createHash} from "node:crypto";
import type {BridgeToolHandler,PreparedToolDelivery,PrepareToolDelivery} from "./bridge-contracts.js";
import { displayTime } from './time.js';
import {sourceSchema,documentSchema,sourceContentTime,attributionContextSchema,sourceContextDeclarationSchema,type SourceContextDeclaration} from '@mote/shared';
import type {
  ContextReader,
  ContextRecord,
  ContextRange,
  MediaContextRange,
  QueryInput,
  ToolTrace,
} from "./types.js";

const hostError=(message:string)=>new ContextToolError('invalid_tool_arguments',message,'correct_arguments');

export const TOOL_NAMES = CONTEXT_TOOLS.map(([name])=>name);

function dateValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw hostError(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function range(
  args: Record<string, unknown>,
  bounds: QueryInput,
): ContextRange {
  const after = dateValue(args.after, "after");
  const before = dateValue(args.before, "before");
  const lower = dateValue(bounds.after, "after");
  const upper = dateValue(bounds.before, "before");
  const effectiveAfter =
    after && lower ? (after > lower ? after : lower) : (after ?? lower);
  const effectiveBefore =
    before && upper ? (before < upper ? before : upper) : (before ?? upper);
  if (effectiveAfter && effectiveBefore && effectiveAfter > effectiveBefore)
    throw hostError("Time range is outside the requested scope");
  if (args.deviceId !== undefined && typeof args.deviceId !== "string")
    throw hostError("deviceId must be a string");
  if (bounds.deviceId && args.deviceId !== undefined && args.deviceId !== bounds.deviceId)
    throw hostError("Device is outside the requested scope");
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) || Number(args.limit) < 1)
  )
    throw hostError("limit must be a positive integer");
  if (args.cursor !== undefined && (typeof args.cursor !== "string" || !args.cursor || args.cursor.length > 4096))
    throw hostError("cursor must be a pagination token returned by timeline");
  if (args.source !== undefined && !sourceSchema.safeParse(args.source).success) throw hostError('Invalid source');
  if (args.appId !== undefined && (typeof args.appId !== 'string' || !args.appId.trim() || args.appId.length > 300)) throw hostError('Invalid appId');
  if (args.collection !== undefined && args.collection !== 'content' && args.collection !== 'activity') throw hostError('Invalid collection');
  return {
    after: effectiveAfter,
    before: effectiveBefore,
    deviceId: bounds.deviceId ?? args.deviceId as string | undefined,
    limit: Math.min(Number(args.limit ?? (bounds.skill==='personal-insight'?30:8)), bounds.skill==='personal-insight'?30:12),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
    ...(args.source === undefined ? {} : {source: sourceSchema.parse(args.source)}),
    ...(args.appId === undefined ? {} : {appId: args.appId as string}),
    ...(args.collection === undefined ? {} : {collection: args.collection as 'content' | 'activity'}),
  };
}

export {originalEvidenceReceipt} from './evidence-receipt.js';

const pinnedSourceContextRef=/^source-context:([A-Za-z0-9_-]+)@([1-9][0-9]*)#([a-f0-9]{64})$/;
const pinnedMaterialRef=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/;
/** Reader data is untrusted too: explicitly select catalog metadata, never body/member fields. */
function materialMetadata(value: unknown, scope: ContextRange): Record<string, unknown> | undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))throw hostError('Invalid material catalog row');
  const row=value as Record<string,unknown>,match=typeof row.ref==='string'?pinnedMaterialRef.exec(row.ref):null;
  const origin=row.origin as Record<string,unknown>|undefined;
  if(!match||row.id!==match[1]||row.revision!==match[2]||typeof row.title!=='string'||typeof row.kind!=='string'||!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(row.kind)||!origin||typeof origin.sourceId!=='string'||origin.sourceId.length>128||!Number.isSafeInteger(row.textLength)||Number(row.textLength)<0||!Number.isSafeInteger(row.memberCount)||Number(row.memberCount)<0)throw hostError('Invalid material catalog row');
  const firstAt=typeof origin.firstAt==='string'&&Number.isFinite(Date.parse(origin.firstAt))?new Date(origin.firstAt).toISOString():undefined;
  const lastAt=typeof origin.lastAt==='string'&&Number.isFinite(Date.parse(origin.lastAt))?new Date(origin.lastAt).toISOString():undefined;
  if(scope.deviceId&&origin.deviceId!==scope.deviceId||scope.after&&(!firstAt||firstAt<scope.after)||scope.before&&(!lastAt||lastAt>=scope.before))return;
  const attribution=attributionMetadata(row.attributionContext);
  return {id:row.id,ref:row.ref,kind:row.kind,title:row.title.slice(0,500),
    ...(attribution?{attributionContext:attribution,attributionContextLocator:{ref:row.ref}}:{}),
    ...(Number.isSafeInteger(row.schemaVersion)?{schemaVersion:row.schemaVersion}:{}),
    origin:{sourceId:origin.sourceId,...(typeof origin.deviceId==='string'?{deviceId:origin.deviceId}:{}),...(firstAt?{firstAt}:{}),...(lastAt?{lastAt}:{})},
    revision:row.revision,
    ...(typeof row.updatedAt==='string'&&Number.isFinite(Date.parse(row.updatedAt))?{updatedAt:new Date(row.updatedAt).toISOString()}:{}),
    memberCount:row.memberCount,textLength:row.textLength,
    ...(Number.isSafeInteger(row.blockCount)?{blockCount:row.blockCount}:{}),
    ...(Number.isSafeInteger(row.assetCount)?{assetCount:row.assetCount}:{}),
    coverage:{state:['complete','partial','pending'].includes(String((row.coverage as Record<string,unknown>|undefined)?.state))?(row.coverage as Record<string,unknown>).state:'unknown'},
    artifacts:(Array.isArray(row.artifacts)?row.artifacts:[]).slice(0,32).flatMap(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return [];
      const artifact=value as Record<string,unknown>;
      if(typeof artifact.key!=='string'||!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(artifact.key)||!['ready','pending','failed','unavailable'].includes(String(artifact.state)))return [];
      return [{key:artifact.key,state:artifact.state}];
    }),
    fidelity:{state:['lossless','derived','summary-only'].includes(String((row.fidelity as Record<string,unknown>|undefined)?.state))?(row.fidelity as Record<string,unknown>).state:'unknown'},
    retention:{original:['retained','unavailable'].includes(String((row.retention as Record<string,unknown>|undefined)?.original))?(row.retention as Record<string,unknown>).original:'unknown'}};
}

export async function createContextToolSession(
  reader: ContextReader,
  bounds: QueryInput,
  maxToolCalls?: number,
) {
  let closing=false;
  const canonical={records:new Map<string,ContextRecord>(),
    trace:[] as ToolTrace[],
    discoveredCapabilities:new Set<string>(),
    sourceContextDependencies:new Map<string,SourceContextDeclaration>(),
    discoveredSourceContexts:new Set<string>(),
    disclosedIds:new Set<string>(),
    completeLineage:true,
    metadataImageIds:new Set<string>(),
    discovered:new Set<string>(),
    pinnedMaterials:new Set<string>(),
    deliveredCharacters:0,
    deliveredRanges:[] as {id:string;offset:number;length:number}[],
    expanded:new Set<string>(),
    imageReadReceipts:new Map<string,{id:string;imageView:ImageView}>()};
  type State=typeof canonical;
  type CallbackName='onEvidence'|'onSourceContextDependencies'|'onTrace'|'onProgress'|'onMemoryBodies';
  interface Stage {
    base:State;state:State;evidence:ContextRecord[];signal:AbortSignal;
    callbacks:{name:CallbackName;args:unknown[]}[];delivered:(()=>void)[];
    status:'reading'|'pending'|'committed'|'discarded';fatal?:Error;cancelled?:unknown;
    reservations:Set<ImageDelivery>;checks:Set<()=>void>;discard():void;
  }
  // Pending attachment reservations are resources, not eligible evidence. ACKs
  // and their timers share one table; each stage disposes only its own entries.
  const disclosedImages=new Map<string,ImageDelivery>();
  const execution=new AsyncLocalStorage<Stage>();
  const state=()=>{
    const stage=execution.getStore();if(stage&&stage.status!=='committed')return stage.state;
    if(closing)throw new ContextToolError('bridge_closing','The tool session is closing','stop');
    bounds.signal?.throwIfAborted();return canonical;
  };
  const inheritedRegistry=hasPinnedContextTools(bounds);
  bounds=pinContextTools({...bounds,...(bounds.evidenceIds?{evidenceIds:[...bounds.evidenceIds]}:{}),...(bounds.anchorEvidenceIds?{anchorEvidenceIds:[...bounds.anchorEvidenceIds]}:{}),...(bounds.evidenceRanges?{evidenceRanges:bounds.evidenceRanges.map(range=>({...range}))}:{}),...(bounds.evidenceReadRanges?{evidenceReadRanges:Object.freeze(bounds.evidenceReadRanges.map(range=>Object.freeze({...range})))}:{})},reader);
  const callbacks=new Map<CallbackName,unknown>();
  for(const name of ['onEvidence','onSourceContextDependencies','onTrace','onProgress','onMemoryBodies'] as const){
    const original=bounds[name];callbacks.set(name,original);
    (bounds as unknown as Record<string,unknown>)[name]=(...args:unknown[])=>{
      const stage=execution.getStore();
      if(closing||bounds.signal?.aborted)return;
      if(stage&&stage.status!=='committed'){if(stage.status!=='discarded')stage.callbacks.push({name,args});return;}
      if(typeof original==='function')return (original as (...args:unknown[])=>unknown)(...args);
    };
  }
  const pinnedTools=contextToolSnapshot(bounds);
  const contributions=new Map(pinnedTools.entries.map(tool=>[tool.name,tool]));
  const specialCapabilities=new Map(pinnedTools.entries.filter(entry=>dispatchTools(bounds).includes(entry.name)&&entry.exposure==='catalog').map(entry=>[entry.name,entry]));

  const controls=new Set(hostControlDefinitions(bounds.hostControlChannel).map(([name])=>name));


  const remember=(record:ContextRecord)=>{rememberEvidence(state().records,record);execution.getStore()?.evidence.push(record);try{bounds.onEvidence?.([record]);}catch{/* Receipt observation cannot grant new reads. */}};

  const rememberSourcePin=(pin:SourceContextDeclaration)=>{
    const key=JSON.stringify(pin);if(state().sourceContextDependencies.has(key))return;
    state().sourceContextDependencies.set(key,{...pin});bounds.onSourceContextDependencies?.([...state().sourceContextDependencies.values()].map(value=>Object.freeze({...value})));
  };
  for(const pin of [...(bounds.contextSourceContextDependencies??[]),...(bounds.conversation?.sourceContextDependencies??[])])rememberSourcePin(pin);

  const rememberSourceContexts=(value:unknown,mayDiscover:(ref:string)=>boolean=()=>true)=>{
    if(Array.isArray(value)){for(const item of value)rememberSourceContexts(item,mayDiscover);return;}
    if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>,ref=row.sourceContextRef;
    if(typeof ref==='string'&&mayDiscover(ref)){
      const match=pinnedSourceContextRef.exec(ref);
      if(match){const sourceId=Buffer.from(match[1],'base64url').toString('utf8'),version=Number(match[2]);
        if(sourceId.length>0&&sourceId.length<=128&&Number.isSafeInteger(version)){state().discoveredSourceContexts.add(ref);rememberSourcePin({sourceId,version,fingerprint:match[3]});}}
    }
    const attribution=attributionContextSchema.safeParse(row.attributionContext);
    if(attribution.success)for(const pin of attribution.data.sourceContextDeclarations??[])rememberSourcePin(pin);
    for(const [key,item] of Object.entries(row))if(key!=='attributionContext')rememberSourceContexts(item,mayDiscover);
  };
  canonical.disclosedIds=new Set([...(bounds.conversation?.evidenceDependencies?.ids??[]),...(bounds.contextEvidenceDependencies?.ids??[]),...(bounds.derivedContextEvidenceIds??[])]);
  canonical.completeLineage=(!bounds.conversation||bounds.conversation.evidenceDependencies?.complete===true)&&
    (!bounds.contextEvidenceDependencies||bounds.contextEvidenceDependencies.complete)&&
    (!bounds.openingMemories?.length||bounds.contextEvidenceDependencies?.complete===true&&bounds.contextEvidenceDependencies.ids.length>0)&&
    (!bounds.taskContext?.previousSummary&&!bounds.taskContext?.turns?.length||bounds.contextEvidenceDependencies?.complete===true);
  const rememberDisclosureDependencies=(receipt:unknown)=>{
    const value=receipt&&typeof receipt==='object'&&!Array.isArray(receipt)?receipt as Record<string,unknown>:undefined;
    if(!value||value.version!==1||typeof value.complete!=='boolean'||!Array.isArray(value.ids)||
      Object.keys(value).some(key=>!['version','complete','ids'].includes(key))||value.ids.some(id=>typeof id!=='string'||!parseEvidenceId(id))){state().completeLineage=false;return;}
    state().completeLineage &&= value.complete;
    for(const id of value.ids as string[])state().disclosedIds.add(parseEvidenceId(id)!);
  };
  const restricted = bounds.evidenceIds !== undefined;
  const processingImages=(bounds.processingImages??[]).map(grant=>Object.freeze({...grant,required:Object.freeze([...grant.required])}));
  if(processingImages.length&&(processingImages.some(grant=>
    !/^[a-f0-9]{64}$/.test(grant.originalSha256)||restricted&&![...(bounds.evidenceIds??[]),...(bounds.evidenceReadRanges??[]).map(range=>range.id)].includes(grant.id)||
    !bounds.processingMaterialInputs?.some(pin=>pin.materialId===grant.materialId&&pin.fingerprint===grant.fingerprint&&pin.evidenceIds.includes(grant.id)&&JSON.stringify(pin.required)===JSON.stringify(grant.required)))))throw hostError('Invalid frozen Memory image scope');
  const permitted = new Map<string,ContextRecord>();
  const ranges = bounds.evidenceRanges ?? bounds.evidenceIds?.map(id=>({id,offset:0,length:12000})) ?? [];
  const readRanges=bounds.evidenceReadRanges??[];
  const originalPins=new Map<string,string>();
  const originalPin=(record:ContextRecord)=>JSON.stringify([record.id,record.ocrText,record.capturedAt,record.deviceId,record.provenance,record.attributionContext,record.fileEvidence,record.metadata]);
  const splitsPair=(text:string,at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);
  if(bounds.evidenceRanges&&!restricted)throw hostError('Evidence ranges require explicit evidence IDs');
  if(bounds.evidenceReadRanges&&!restricted)throw hostError('Context read ranges require a bounded extraction session');
  if(restricted){
    const historicalEmpty=bounds.executionLane==='interactive'&&bounds.hostRetrieval==='none'&&Boolean(bounds.conversation?.historyContext)&&Boolean(bounds.historicalSelection?.evidenceIds?.length)&&bounds.evidenceIds?.length===0&&ranges.length===0;
    if(!bounds.evidenceIds||!extractionSeedScopeValid(bounds.evidenceIds,ranges)&&!historicalEmpty)throw hostError('Invalid extraction evidence scope');
    if(readRanges.some(r=>typeof r.id!=='string'||!r.id||!Number.isSafeInteger(r.offset)||r.offset<0||!Number.isSafeInteger(r.length)||r.length<1||!Number.isSafeInteger(r.offset+r.length)))throw hostError('Invalid context evidence read scope');
    const ids=[...new Set([...bounds.evidenceIds,...readRanges.map(r=>r.id)])];
    for(const raw of ids.length?await reader.evidence({...range({},bounds),ids}):[])if(ids.includes(raw.id)){const record=bounds.skill==='calendar-extraction'?{...raw,ocrText:actionEvidenceText(raw)}:raw;permitted.set(record.id,record);originalPins.set(record.id,originalPin(record));}
    const scope=range({},bounds);
    for(const id of ids){
      const record=permitted.get(id);
      if(!record){if(bounds.evidenceIds.includes(id))throw hostError('Extraction evidence is missing');continue;}
      const document=documentSchema.safeParse((record.provenance as Record<string,unknown>|undefined)?.document);
      const at=sourceContentTime({capturedAt:record.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});
      if((scope.deviceId&&record.deviceId!==scope.deviceId)||(scope.after&&Date.parse(at)<Date.parse(scope.after))||(scope.before&&Date.parse(at)>=Date.parse(scope.before)))throw hostError('Extraction evidence is outside the selected scope');
      if(bounds.evidenceIds.includes(id)&&!ranges.some(r=>r.id===id))throw hostError('Every extraction evidence ID requires a delivered range');
    }
    for(const r of ranges){const text=permitted.get(r.id)!.ocrText;
      if(bounds.evidenceRanges&&(r.offset+r.length>text.length||splitsPair(text,r.offset)||splitsPair(text,r.offset+r.length)))throw hostError('Extraction range must stay inside original text and UTF-16 boundaries');
    }
    for(const r of readRanges){const text=permitted.get(r.id)?.ocrText;if(text!==undefined&&(r.offset+r.length>text.length||splitsPair(text,r.offset)||splitsPair(text,r.offset+r.length)))throw hostError('Context read range must stay inside original text and UTF-16 boundaries');}
  }
  const seedEvidence=ranges.flatMap(r=>{const record=permitted.get(r.id);return record?[project(record,r.offset,r.length,bounds.timeZone)]:[];});
  for(const record of seedEvidence){remember(record);state().disclosedIds.add(record.id);}
  rememberSourceContexts(seedEvidence);
  const directImages=bounds.directImages??[];
  if(directImages.length>8||new Set(directImages.map(image=>image.id)).size!==directImages.length||directImages.some(image=>
    !/^[0-9a-f-]{36}$/i.test(image.id)||!['image/png','image/jpeg','image/webp'].includes(image.mimeType)||
    !/^[a-f0-9]{64}$/.test(image.hash)||!Number.isSafeInteger(image.sizeBytes)||image.sizeBytes<1||image.sizeBytes>8*1024*1024||image.name.length>500))throw hostError('Invalid direct image attachments');
  if(restricted&&directImages.length)throw hostError('Extraction sessions cannot receive dialogue images');
  const directImageRecords=new Map<string,ContextRecord>();

  for(const image of directImages){
    const record:ContextRecord={id:image.id,capturedAt:bounds.contextTime??new Date().toISOString(),appName:image.name,ocrText:'',sourceType:'user_attachment',summary:'User attached image',metadata:{mimeType:image.mimeType}};
    directImageRecords.set(image.id,record);
  }
  // Reference locators may be expanded through the normal current-authorized reader.
  // They contain no delivered text and cannot support citations before a read.
  canonical.discovered=new Set([...state().records.keys(),...(!restricted?bounds.anchorEvidenceIds??[]:[])]);
  canonical.pinnedMaterials=new Set<string>(!restricted&&bounds.anchorMaterialRef&&pinnedMaterialRef.test(bounds.anchorMaterialRef)?[bounds.anchorMaterialRef]:[]);
  canonical.deliveredCharacters=JSON.stringify(seedEvidence).length;
  canonical.deliveredRanges=seedEvidence.flatMap(record=>{const span=record.textRange as {start:number;end:number};return span.end>span.start?[{id:record.id,offset:span.start,length:span.end-span.start}]:[];});

  for(const image of directImages)state().expanded.add(image.id);
  // Query-local byte identities only: never skip the reader's fresh authorization
  // or merge the source attribution of two selections containing the same image.
  type ImageDelivery={selection:{id:string;attachmentId?:string};record:ContextRecord;imageView?:ImageViewTrace;token:string;confirmed:boolean;ready:Promise<void>;settle:()=>void;timer:ReturnType<typeof setTimeout>};


  const rememberImageRead=(id:string,value:ImageViewTrace|undefined)=>{
    if(!value?.output)return;
    const {id:_id,attachmentId:_attachment,delivery:_delivery,...imageView}=value;
    state().imageReadReceipts.set(JSON.stringify([id,imageView.viewId]),{id,imageView:structuredClone(imageView)});
  };
  const imageDelivery=(token:string,delivered:boolean)=>{
    const entry=[...disclosedImages].find(([,value])=>value.token===token);
    if(!entry){if(delivered)throw hostError('Image delivery receipt expired');return;}
    const [key,value]=entry;clearTimeout(value.timer);
    if(delivered){value.confirmed=true;if(!state().records.has(value.selection.id))remember(value.record);state().disclosedIds.add(value.selection.id);rememberImageRead(value.selection.id,value.imageView);}else disclosedImages.delete(key);
    if(value.imageView)value.imageView.delivery=delivered?'prepared':'failed';
    value.settle();
  };
  let calls = 0;
  let ready = false;
  let rejectFailure!:(error:Error)=>void;
  const failure=new Promise<never>((_,reject)=>{rejectFailure=error=>{const stage=execution.getStore();if(stage)stage.fatal??=error;reject(error);};});void failure.catch(()=>{});
  let previousFailure='',repeatedFailures=0;
  const countToolCall=()=>{
    calls++;
    if(maxToolCalls!==undefined&&calls>maxToolCalls)throw new ContextToolError('tool_budget_exceeded','The explicitly configured tool call limit was reached. Finish with already retrieved evidence.','use_existing_evidence',{remainingCalls:0});
  };
  // Character counts are observations. Only an explicit caller limit is enforced.
  const toolUsage=()=>({calls,deliveredCharactersBeforeResult:state().deliveredCharacters,unit:'utf16_characters',...(maxToolCalls!==undefined?{remainingCalls:Math.max(0,maxToolCalls-calls)}:{})});

  const executeTool:BridgeToolHandler = async (request, res) => {
    let tool=request.tool,args:Record<string,unknown>={},metadataOnly=false,dispatchedViaCatalog=false,disclosureDependencies:unknown,disclosureSourceContextDependencies:unknown;
    try {
      args = await request.readArguments();

      // Adapter-only receipt; absent from every model tool declaration. The
      // authenticated adapter strips the opaque token before returning a tool.
      if(tool==='_image_delivery'){
        if(typeof args.token!=='string'||typeof args.delivered!=='boolean'||Object.keys(args).some(key=>key!=='token'&&key!=='delivered'))throw hostError('Invalid image delivery receipt');
        imageDelivery(args.token,args.delivered);res.end('{"ok":true}');return;
      }

      if (tool === "_ready") {
        const exposed = args.tools;
        if (
          !Array.isArray(exposed) ||
          exposed.length !== taskTools(bounds).length + 1 ||
          ![...taskTools(bounds),'skill'].every((name) => exposed.includes(name))
        )
          throw hostError("Unsafe Harness tool composition");
        ready = true;
        reportTrace(bounds,{type:'bridge.ready',stage:'starting',status:'succeeded',payload:{tools:exposed.length}});
        res.end('{"ok":true}');
        return;
      }
      if(tool==='capability_discover'){
        if(!taskTools(bounds).includes(tool)||Object.keys(args).some(key=>key!=='name')||args.name!==undefined&&typeof args.name!=='string')throw hostError('Invalid capability discovery');
        countToolCall();
        const selected=args.name===undefined?undefined:specialCapabilities.get(args.name as string);
        if(args.name!==undefined&&!selected)throw hostError('Unknown or unauthorized capability');
        const data=selected?{...selected,evidencePolicy:'Registered read-only capability; schema and metadata cannot expand authority.'}:{capabilities:[...specialCapabilities.values()].map(({name,version,description})=>({name,version,description:description.split('. ')[0]}))};
        const serialized=JSON.stringify({data,toolUsage:toolUsage()});
        state().deliveredCharacters+=serialized.length;if(selected)state().discoveredCapabilities.add(selected.name);
        state().trace.push({tool,arguments:args,count:selected?1:specialCapabilities.size});res.end(serialized);return;
      }
      if(tool==='capability_execute'){
        if(!taskTools(bounds).includes(tool))throw hostError('Capability execution is unavailable for this task');
        countToolCall();
        if(Object.keys(args).some(key=>!['name','version','argumentsJson'].includes(key))||typeof args.name!=='string'||typeof args.version!=='string'||typeof args.argumentsJson!=='string'||args.argumentsJson.length>65536)throw hostError('Invalid capability execution');
        const selected=specialCapabilities.get(args.name);
        if(!selected||!state().discoveredCapabilities.has(selected.name)||selected.version!==args.version)throw hostError('Discover this exact registered capability and version first');
        let decoded:unknown;try{decoded=JSON.parse(args.argumentsJson);}catch{throw hostError('Capability argumentsJson must be a JSON object');}
        if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw hostError('Capability argumentsJson must be a JSON object');
        validateCapabilityArguments(selected.fields,decoded as Record<string,unknown>);
        tool=selected.name;args=decoded as Record<string,unknown>;dispatchedViaCatalog=true;
      }
      if(controls.has(tool)){
        countToolCall();
        bounds.signal?.throwIfAborted();
        const result=await bounds.hostControlChannel!.execute(tool,Object.freeze(args));
        bounds.signal?.throwIfAborted();
        const delivered:ContextRecord[]=[],dependencyIds=new Set<string>();
        const citations=new Set(result.evidence??[]);
        for(const receipt of [...(result.dependencies??[]),...(result.evidence??[])]){
          const citation=citations.has(receipt);
          if(citation&&receipt.contentLayer==='L2_model_interpretation'||typeof receipt.evidenceFingerprint!=='string')throw hostError('A child interpretation is not original evidence');
          const fresh=result.authorizedOriginals!==undefined?result.authorizedOriginals.find(record=>record.id===receipt.id):(await reader.evidence({...(citation?range({},bounds):{}),ids:[receipt.id]})).find(record=>record.id===receipt.id);
          if(!fresh)throw hostError('Delegated evidence is no longer authorized or current');
          const scope=range({},bounds),at=sourceContentTime(fresh);
          if(citation&&(scope.deviceId&&fresh.deviceId!==scope.deviceId||scope.after&&Date.parse(at)<Date.parse(scope.after)||scope.before&&Date.parse(at)>=Date.parse(scope.before)||restricted&&!bounds.evidenceIds!.includes(receipt.id)))throw hostError('Delegated evidence is outside the parent scope');
          const spans=receipt.deliveredRanges as {start:number;end:number;text:string}[]|undefined;
          const supplied=spans?.length?spans:[{...(receipt.textRange as {start:number;end:number}),text:receipt.ocrText}];
          for(const span of supplied){
            if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<span.start||span.end>fresh.ocrText.length)throw hostError('Invalid delegated original range');
            if(citation&&restricted&&!ranges.some(r=>r.id===receipt.id&&span.start>=r.offset&&span.end<=r.offset+r.length))throw hostError('Delegated range exceeds parent authorization');
            const selected=project(fresh,span.start,span.end-span.start,bounds.timeZone);
            if(selected.evidenceFingerprint!==receipt.evidenceFingerprint||selected.ocrText!==span.text)throw hostError('Delegated original revision changed');
            if(citation)delivered.push(selected);
          }
          dependencyIds.add(receipt.id);
        }
        const sourcePins=(result.sourceContextDependencies??[]).map(pin=>sourceContextDeclarationSchema.parse(pin));
        if(sourcePins.length&&!reader.sourceContext)throw hostError('Delegated source description validation is unavailable');
        for(const pin of sourcePins){const ref=`source-context:${Buffer.from(pin.sourceId).toString('base64url')}@${pin.version}#${pin.fingerprint}`;
          const opened=await reader.sourceContext!({...range({},bounds),sourceContextRef:ref});
          if(!opened.attributionContext.sourceContextDeclarations?.some(current=>JSON.stringify(current)===JSON.stringify(pin)))throw hostError('Delegated source description is no longer current');
        }
        const serialized=JSON.stringify(attributionMetadataResponse({source:'untrusted_delegated_result',data:result.data,evidence:delivered,toolUsage:toolUsage()}));
        for(const record of delivered){remember(record);state().discovered.add(record.id);state().disclosedIds.add(record.id);state().expanded.add(record.id);}
        for(const id of dependencyIds)state().disclosedIds.add(id);
        for(const pin of sourcePins)rememberSourcePin(pin);
        state().deliveredCharacters+=serialized.length;state().trace.push({tool,arguments:args,count:delivered.length});
        reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:delivered.length});
        res.end(serialized,()=>{if(result.yield)rejectFailure(new AgentYieldError());});return;
      }
      if (!contributions.has(tool)) {
        if(TOOL_NAMES.includes(tool))throw hostError('Tool is unavailable for this task');
        res.writeHead(404).end('{"error":"Unknown tool"}');
        return;
      }
      if(!dispatchTools(bounds).includes(tool)||!dispatchedViaCatalog&&!taskTools(bounds).includes(tool))throw hostError('Tool is unavailable for this task; use the discovered capability gateway');
      const pin=contributions.get(tool)!;
      // Normalize typed references before discovery/range checks, never after them.
      // Original-only tools use a declared UUID resource identity or an explicit capture ref.
      const captureId=(value:unknown)=>{
        if(typeof value!=='string')return value;
        const parsed=parseEvidenceRef(value);
        if(parsed){if(parsed.kind!=='capture')throw hostError('Expected an original capture reference');return parsed.id;}
        const id=parseEvidenceId(value);
        if(!id)throw hostError('Invalid capture identity');
        return id;
      };
      if(pin.requires.includes('evidence')&&Array.isArray(args.ids))args={...args,ids:args.ids.map(captureId)};
      if(args.id!==undefined&&pin.requires.some(permission=>['readImage','readFileEvidence','fileChunks','sourceHistory','evidence'].includes(permission)))args={...args,id:captureId(args.id)};
      const progressOnly=contributions.get(tool)!.requires.length>0&&contributions.get(tool)!.requires.every(permission=>permission==='progress');
      if(!dispatchedViaCatalog&&!progressOnly)countToolCall();
      reportProgress(bounds,{stage:'tool',tool,phase:'started'});
      if(bounds.skill==='working-memory')throw hostError('Working memory uses only the supplied dialogue; retrieval is disabled');
      const assertTool=()=>{bounds.signal?.throwIfAborted();try{pinnedTools.assertActive(pin);}catch{throw new ContextToolError('stale_tool_pin','The registered tool was revoked or replaced.','stop');}bounds.assertContextAuthority?.();if(closing)throw new ContextToolError('bridge_closing','The tool session is closing','stop');};
      assertTool();execution.getStore()?.checks.add(assertTool);
      try{validateCapabilityArguments(pin.fields as Record<string,Record<string,unknown>>,args);}catch(error){if(tool==='context_evidence')throw new ContextToolError('invalid_evidence_range','Use a declared context original id, absolute offset and length.','correct_arguments');if(tool==='read_image')throw new ContextToolError('invalid_image_region','Use the declared image arguments.','correct_arguments');throw error;}
        const signals=[closeSignal.signal,execution.getStore()?.signal,bounds.signal,...(bounds.toolContributions??[]).filter(pack=>pack.descriptors.some(descriptor=>descriptor.name===pin.name)).map(pack=>pack.lifecycle.signal)].filter((signal):signal is AbortSignal=>Boolean(signal));
        const signal=AbortSignal.any(signals);
        const assertLive=()=>{assertTool();signal.throwIfAborted();};
        const wait=async<T>(task:Promise<T>):Promise<T>=>{
          let aborted!:()=>void;
          const cancelled=new Promise<never>((_,reject)=>{aborted=()=>{try{assertLive();}catch(error){reject(error);}};signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();});
          try{const value=await Promise.race([task,cancelled]);assertLive();return value;}finally{signal.removeEventListener('abort',aborted);}
        };
      const ordinaryReads=new Set<HostReadOperation>(HOST_READ_OPERATIONS.filter(operation=>operation!=='readImage'));
      if(pin.requires.every(permission=>permission==='actionCatalog'||permission==='progress'||ordinaryReads.has(permission as HostReadOperation))){
        const scope=Object.freeze(range(args,bounds));let grantedReadRange:{offset:number;length:number}|undefined;
        const inScope=(record:ContextRecord)=>{const at=sourceContentTime(record);return Number.isFinite(Date.parse(at))&&(!scope.deviceId||record.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));};
        const detach=<T>(value:T):T=>{
          const copied=structuredClone(value);
          const preserve=(source:unknown,target:unknown)=>{if(!source||typeof source!=='object'||!target||typeof target!=='object')return;const record=source as ContextRecord;if(typeof record.id==='string'&&typeof record.ocrText==='string')copyEvidencePresentation(record,target as ContextRecord);for(const [key,item]of Object.entries(source))preserve(item,(target as Record<string,unknown>)[key]);};preserve(value,copied);return copied;
        };
        const produced:{operation:HostReadOperation;value:unknown;originals?:ContextRecord[];views?:ContextRecord[]}[]=[];
        const port:HostSessionPort={tool:pin,scope,signal,assertCurrent:assertLive,
          async read(operation,...parameters){
            assertLive();if(restricted&&operation!=='evidence')throw hostError('This extraction session uses only the supplied evidence ranges');
            if(!ordinaryReads.has(operation))throw hostError('This read operation is unavailable through this tool');
            const requested=(parameters[0]??{}) as Record<string,unknown>;
            const normalized=range(requested,{...bounds,after:scope.after,before:scope.before,deviceId:scope.deviceId});
            const actual:Record<string,unknown>={...requested,...normalized,limit:Math.min(normalized.limit??scope.limit??8,scope.limit??normalized.limit??8),
              ...(scope.source?{source:scope.source}:{}),...(scope.appId?{appId:scope.appId}:{}),...(scope.collection?{collection:scope.collection}:{})};
            if(['sourceHistory','readFileEvidence','fileChunks'].includes(operation)&&
              (typeof requested.id!=='string'||!state().records.has(requested.id)))throw hostError('Discover the original before requesting this read');
            if(operation==='search'&&requested.query!==undefined&&(typeof requested.query!=='string'||requested.query.length>2000))throw hostError('query must be at most 2000 characters');
            if(operation==='mediaActivity'&&actual.source!==undefined&&actual.source!=='media')throw hostError('media_activity requires the media source');
            if(operation==='readFileEvidence'&&(!Number.isSafeInteger(actual.offset??0)||Number(actual.offset??0)<0||Number(actual.offset??0)>10000000||!Number.isSafeInteger(actual.length??8000)||Number(actual.length??8000)<1||Number(actual.length??8000)>16000))throw hostError('Invalid text range');
            if(operation==='fileChunks'&&(!Number.isSafeInteger(actual.offset??0)||Number(actual.offset??0)<0))throw hostError('Invalid chunk offset');
            if(operation==='sourceContext'&&(typeof requested.sourceContextRef!=='string'||!state().discoveredSourceContexts.has(requested.sourceContextRef)))throw hostError('Discover the source context before reading its statement');
            if(operation==='materialRead'&&(typeof requested.ref!=='string'||!state().pinnedMaterials.has(requested.ref)))throw hostError('Use an exact pinned Material ref returned in this run');
            if(operation==='evidence'){
              if(!Array.isArray(requested.ids)||!requested.ids.length||requested.ids.length>30)throw hostError('ids must contain 1–30 original identifiers');
              actual.ids=requested.ids.map(captureId);
              const ids=actual.ids as string[];
              if(ids.some(id=>typeof id!=='string'))throw hostError('Invalid original identifier');
              if(restricted){
                const allowed=tool==='context_evidence'?readRanges.map(grant=>grant.id):bounds.evidenceIds!;
                if(ids.some(id=>!allowed.includes(id)))throw new ContextToolError(tool==='context_evidence'?'evidence_range_exceeded':'evidence_scope_denied','Use only original ids supplied by this Host grant.','correct_arguments',{allowedRanges:ranges.map(({id,offset,length})=>({id,offset,length}))});
              }else{
                const linked=produced.flatMap(read=>read.operation==='materialRead'&&read.value&&typeof read.value==='object'?((read.value as {originalRefs?:string[]}).originalRefs??[]).flatMap(ref=>{const parsed=parseEvidenceRef(ref);return parsed?.kind==='capture'?[parsed.id]:[];}):[]);
                const allowed=tool==='changes'?bounds.incrementalEvidenceIds??[]:[...state().discovered,...linked];
                if(ids.some(id=>!allowed.includes(id)))throw hostError('Discover originals in this run before expanding evidence');
              }
            }
            const method=reader[operation] as ((...args:unknown[])=>Promise<unknown>)|undefined;
            if(!method)throw hostError('The requested read operation is unavailable');
            let value=await wait(Promise.resolve(method.apply(reader,operation==='devices'?[]:[actual]))),originals:ContextRecord[]|undefined,views:ContextRecord[]|undefined;
            if(['search','sourceHistory','fileChunks'].includes(operation)&&Array.isArray(value))value=(value as ContextRecord[]).filter(inScope);
            if(['timeline','sourceItems'].includes(operation)&&value&&typeof value==='object'&&Array.isArray((value as {items?:unknown}).items))value={...value,items:(value as {items:ContextRecord[]}).items.filter(inScope)};
            if(operation==='evidence'){
              if(!Array.isArray(value))throw hostError('The evidence reader returned invalid records');
              const ids=actual.ids as string[];
              value=(value as ContextRecord[]).filter(record=>ids.includes(record.id)&&inScope(record));
              originals=detach(value as ContextRecord[]);
              if(restricted){
                const current=value as ContextRecord[];
                if(ids.some(id=>{const raw=current.find(record=>record.id===id),record=raw&&(bounds.skill==='calendar-extraction'?{...raw,ocrText:actionEvidenceText(raw)}:raw);return !record||originalPin(record)!==originalPins.get(id);}))throw new ContextToolError('evidence_changed','Source evidence, authorization or its Host attribution changed.','stop');
                views=detach(current.map(raw=>bounds.skill==='calendar-extraction'?{...raw,ocrText:actionEvidenceText(raw)}:raw));
                if(tool==='context_evidence'){
                  const id=String(args.id),start=Number(args.offset),length=Number(args.length??4000),grant=readRanges.filter(grant=>grant.id===id&&start>=grant.offset&&start<grant.offset+grant.length).sort((a,b)=>b.offset+b.length-a.offset-a.length)[0];
                  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<1||length>12000)throw new ContextToolError('invalid_evidence_range','Use an absolute UTF-16 offset and length from 1–12000.','correct_arguments');
                  if(!grant)throw new ContextToolError('evidence_range_exceeded','Requested context is outside the Host original read grant.','correct_arguments',{evidenceId:id,allowedRanges:readRanges.filter(grant=>grant.id===id)});
                  const record=permitted.get(id)!;if(splitsPair(record.ocrText,start))throw new ContextToolError('invalid_evidence_range','Context offset splits a UTF-16 pair.','correct_arguments');
                  const grantEnd=grant.offset+grant.length;let end=Math.min(grantEnd,start+length);if(splitsPair(record.ocrText,end))end--;
                  if(end<=start)throw new ContextToolError('invalid_evidence_range','Request a complete Unicode character.','correct_arguments');
                  const projected=project(record,start,end-start,bounds.timeZone);projected.textRange={...(projected.textRange as object),nextOffset:end<grantEnd?end:null};
                  grantedReadRange={offset:grant.offset,length:grant.length};value=[projected];
                }else{
                  value=seedEvidence.filter(record=>ids.includes(record.id));
                  if(requested.offset!==undefined||requested.length!==undefined){
                    const offset=Number(requested.offset??0),length=Number(requested.length??2000);
                    if(!Number.isSafeInteger(offset)||offset<0||offset>10000000||!Number.isSafeInteger(length)||length<1||length>12000)throw new ContextToolError('invalid_evidence_range','Use a nonnegative offset and length 1–12000.','correct_arguments');
                    value=ids.map(id=>{const record=permitted.get(id)!;if(!ranges.some(grant=>grant.id===id&&offset>=grant.offset&&offset+length<=grant.offset+grant.length)||splitsPair(record.ocrText,offset)||splitsPair(record.ocrText,offset+length))throw new ContextToolError('evidence_range_exceeded','Requested range is outside this extraction batch.','correct_arguments',{evidenceId:id,allowedRanges:ranges.filter(grant=>grant.id===id)});return project(record,offset,length,bounds.timeZone);});
                  }
                }
              }else if(tool==='evidence'){
                const offset=Number(requested.offset??0),length=Number(requested.length??12000);
                if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(length)||length<1||length>12000)throw hostError('Invalid original read range');
                if(requested.layer!==undefined&&!['ocr','semantic'].includes(String(requested.layer)))throw hostError('Invalid derived layer');
                views=detach((value as ContextRecord[]).map(record=>requested.layer==='semantic'?{...record,ocrText:String(record.summary??''),contentLayer:'L2_model_interpretation'}:{...record,...(record.sourceType==='screen'?{contentLayer:'L1_machine_extraction'}:{})}));
                value=views.map(record=>project(record,offset,length,bounds.timeZone));
              }
            }
            if(operation==='materialCatalog'){
              const page=value as {items?:unknown[];nextCursor?:unknown}|null;if(!page||!Array.isArray(page.items))throw hostError('Invalid material catalog page');
              value={...page,items:page.items.filter(item=>Boolean(materialMetadata(item,scope)))};
            }
            if(operation==='materialRead'){
              const page=value as {material?:unknown}|null,material=materialMetadata(page?.material,scope);
              if(!material||material.ref!==requested.ref)throw hostError('Material is outside the selected scope or has changed');
            }
            produced.push({operation,value:detach(value),originals,views});return detach(value) as never;
          },
          async actionCatalog(parameters){assertLive();if(bounds.skill!=='calendar-extraction'||!bounds.actionCatalog)throw hostError('Action catalog is not authorized for this task');return wait(bounds.actionCatalog({...parameters,...range({...parameters},bounds),limit:parameters.limit}));},
          progress(message){assertLive();if(typeof message!=='string'||!message.trim()||message.length>600)throw hostError('Progress message must contain 1–600 characters');reportProgress(bounds,{stage:'model',message:message.trim()});},
        };
        let result:unknown;try{result=await pinnedTools.resolve(pin).execute(args,port);}catch(error){assertLive();if(tool==='context_evidence'&&error instanceof ContextToolError&&error.code==='invalid_tool_arguments')throw new ContextToolError('invalid_evidence_range',error.message,'correct_arguments');throw error;}assertLive();
        if(progressOnly){res.end(JSON.stringify(result));return;}
        const body=result&&typeof result==='object'&&!Array.isArray(result)?result as Record<string,unknown>:{data:result};
        if(body.image!==undefined||body.imageDelivery!==undefined)throw hostError('Image delivery requires an actual Host image read');
        type OriginalProof={record:ContextRecord;range?:{start:number;end:number}};
        const proofs:OriginalProof[]=[],spanProofs:OriginalProof[]=[];
        for(const {operation,value,originals,views}of produced){
          if(['search','sourceHistory','fileChunks','evidence'].includes(operation)&&Array.isArray(value))for(const record of value as ContextRecord[]){
            // Match the exact Host-admitted layer/notification text, while raw
            // originals remain separate for revision and source-span checks.
            const full=(views??originals)?.find(original=>original.id===record.id)??record,selection=record.textRange as {start:number;end:number}|undefined;
            proofs.push({record:full,...(selection?{range:selection}:{})});
          }
          else if(['timeline','sourceItems'].includes(operation)&&value&&typeof value==='object'&&Array.isArray((value as {items?:unknown}).items))for(const record of (value as {items:ContextRecord[]}).items)proofs.push({record});
          else if(operation==='readFileEvidence'&&value&&typeof value==='object'&&(value as {record?:ContextRecord}).record)proofs.push({record:(value as {record:ContextRecord}).record});
          if((operation==='materialRead'||operation==='memories')&&value&&typeof value==='object'){
            const page=value as {references?:{id:string}[];sourceSpans?:{record:ContextRecord;offset:number;length:number}[]};
            for(const span of (page.sourceSpans??[]).slice(0,operation==='memories'?3:30)){
              const fresh=operation==='materialRead'?produced.flatMap(read=>read.operation==='evidence'&&Array.isArray(read.value)?read.originals??read.value as ContextRecord[]:[]).find(record=>record.id===span.record.id):span.record;
              if(!fresh||!inScope(fresh)||fresh.contentLayer==='L2_model_interpretation'||span.record.contentLayer==='L2_model_interpretation'||fresh.ocrText!==span.record.ocrText||!Number.isSafeInteger(span.offset)||span.offset<0||!Number.isSafeInteger(span.length)||span.length<1||span.offset>=fresh.ocrText.length||operation==='memories'&&!page.references?.some(ref=>ref.id===fresh.id))continue;
              const end=Math.min(fresh.ocrText.length,span.offset+Math.min(span.length,operation==='memories'?2000:span.length));
              if(splitsPair(fresh.ocrText,span.offset)||splitsPair(fresh.ocrText,end))continue;
              spanProofs.push({record:fresh,range:{start:span.offset,end}});
            }
          }
        }
        const delivered:ContextRecord[]=[];
        const prove=(candidate:unknown,available:OriginalProof[]=proofs):unknown=>{
          if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return candidate;
          const item=candidate as ContextRecord;if(typeof item.id!=='string'||typeof item.ocrText!=='string')return candidate;
          const selected=item.textRange as {start?:unknown;end?:unknown}|undefined;
          const start=Number(selected?.start??0),end=Number(selected?.end??item.ocrText.length);
          const proof=available.find(proof=>proof.record.id===item.id&&(!proof.range||start>=proof.range.start&&end<=proof.range.end));if(!proof)return candidate;
          const original=proof.record;
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>original.ocrText.length||splitsPair(original.ocrText,start)||splitsPair(original.ocrText,end))throw hostError('Tool result exceeds the actual original read');
          const record=project(original,start,end-start,bounds.timeZone);
          if(record.ocrText!==item.ocrText||record.evidenceFingerprint!==item.evidenceFingerprint)throw hostError('Tool result does not match the actual original read');
          // The Host grant, not the pack, owns restricted continuation bounds.
          if(grantedReadRange)record.textRange={...(record.textRange as object),nextOffset:(item.textRange as {nextOffset?:unknown})?.nextOffset??null};
          if(record.contentLayer!=='L2_model_interpretation')delivered.push(record);return record;
        };
        let data=body.data;
        if(Array.isArray(data))data=data.map(candidate=>prove(candidate));
        else if(data&&typeof data==='object'&&(data as {record?:unknown}).record)data={...data,record:prove((data as {record:unknown}).record)};
        if(data&&typeof data==='object'&&Array.isArray((data as {sourceEvidence?:unknown}).sourceEvidence))data={...data,sourceEvidence:(data as {sourceEvidence:unknown[]}).sourceEvidence.map(candidate=>prove(candidate,spanProofs))};
        const {disclosureDependencies:_receipt,sourceContextDependencies:_pins,toolUsage:_usage,hostSourceSemantics:_semantics,...publicBody}=body;
        const publicResult=attributionMetadataResponse({...publicBody,...('data' in body?{source:'untrusted_personal_context',data}:{}),...(grantedReadRange?{readRange:grantedReadRange}:{}),toolUsage:toolUsage(),...(sourceProtocolInstructions(delivered)?{hostSourceSemantics:sourceProtocolInstructions(delivered)}:{})}) as Record<string,unknown>;
        const serialized=JSON.stringify(publicResult);
        assertLive();
        for(const {operation,value}of produced){
          rememberSourceContexts(value,()=>false);
          if(['catalog','sources','activity','mediaActivity','devices'].includes(operation)){
            const raw=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
            rememberDisclosureDependencies(raw.disclosureDependencies);
            // A directory without its producer's observation time cannot
            // establish complete metadata lineage, even with an empty ID list.
            if(operation==='devices'&&(typeof raw.observedAt!=='string'||!Number.isFinite(Date.parse(raw.observedAt))))state().completeLineage=false;
            if(raw.sourceContextDependencies!==undefined){const pins=sourceContextDeclarationSchema.array().safeParse(raw.sourceContextDependencies);if(pins.success)for(const pin of pins.data)rememberSourcePin(pin);else state().completeLineage=false;}
          }
          if(operation==='segments'&&value&&typeof value==='object')for(const item of (value as {items?:{id?:string;members?:string[];metadata?:{citations?:string[]}}[]}).items??[]){
            if(item.id)state().disclosedIds.add(item.id);for(const id of [...(item.members??[]),...(item.metadata?.citations??[])])state().discovered.add(id);
          }
        }
        const visibleIds=new Set<string>();
        const collectVisible=(value:unknown)=>{if(typeof value==='string')visibleIds.add(value);else if(Array.isArray(value))for(const item of value)collectVisible(item);else if(value&&typeof value==='object')for(const item of Object.values(value))collectVisible(item);};collectVisible(publicResult.data);
        for(const {operation,value}of produced){
          if(!value||typeof value!=='object')continue;
          const raw=value as Record<string,unknown>;
          if(operation==='sources'&&Array.isArray(raw.items))for(const item of raw.items as {sourceContextRef?:unknown}[])if(typeof item.sourceContextRef==='string'&&visibleIds.has(item.sourceContextRef))rememberSourceContexts({sourceContextRef:item.sourceContextRef});
          if(operation==='materialCatalog')for(const item of (raw.items as {ref?:string}[]|undefined)??[])if(item.ref&&visibleIds.has(item.ref))state().pinnedMaterials.add(item.ref);
          if(operation==='materialRead')for(const ref of (raw.originalRefs as string[]|undefined)??[]){const parsed=parseEvidenceRef(ref);if(parsed?.kind==='capture'&&visibleIds.has(ref)){state().discovered.add(parsed.id);state().disclosedIds.add(parsed.id);}}
          if(operation==='memories'){
            const page=value as {items?:{id?:string;statement?:string;fingerprint?:string;version?:number}[];references?:{id:string}[];evidence?:ContextRecord[]};
            for(const item of page.items??[])if(item.id&&visibleIds.has(item.id))state().disclosedIds.add(item.id);
            for(const item of [...(page.references??[]),...(page.evidence??[])])if(visibleIds.has(item.id)){state().discovered.add(item.id);state().disclosedIds.add(item.id);}
            const shown=data&&typeof data==='object'&&Array.isArray((data as {items?:unknown}).items)?(data as {items:Record<string,unknown>[]}).items:[];
            const cards=(page.items??[]).flatMap(item=>item.id&&typeof item.statement==='string'&&item.statement.length&&typeof item.fingerprint==='string'&&shown.some(row=>row.id===item.id&&row.statement===item.statement&&row.fingerprint===item.fingerprint&&row.version===item.version)?[{id:item.id,fingerprint:item.fingerprint,...(typeof item.version==='number'?{version:item.version}:{})}]:[]);
            if(cards.length)try{bounds.onMemoryBodies?.(cards);}catch(error){rejectFailure(error instanceof Error?error:new Error('Memory delivery receipt could not be recorded'));}

          }
          if(operation==='materialCatalog'||operation==='materialRead')rememberDisclosureDependencies(raw.disclosureDependencies);
          if(operation==='evidence'&&tool==='attribution_context')for(const record of value as ContextRecord[])state().disclosedIds.add(record.id);
        }
        if(grantedReadRange)for(const record of delivered){const selection=record.textRange as {start:number;end:number};state().deliveredRanges.push({id:record.id,offset:selection.start,length:selection.end-selection.start});}
        for(const record of delivered){remember(record);state().discovered.add(record.id);state().disclosedIds.add(record.id);if(produced.some(read=>read.operation==='evidence'||read.operation==='memories'))state().expanded.add(record.id);}
        for(const proof of proofs){
          state().disclosedIds.add(proof.record.id);
          // An actually shown original locator permits a later fresh read;
          // metadata alone still never enters the delivered-original ledger.
          if(inScope(proof.record)&&visibleIds.has(proof.record.id))state().discovered.add(proof.record.id);
        }
        // An explicitly empty Host arrivals snapshot needs no archive read.
        // Only its exact empty response is covered by that Host fact; extra
        // plugin text, unknown arrivals or invented rows still lack a proof.
        const hostEmptyChanges=tool==='changes'&&bounds.incrementalEvidenceIds?.length===0&&isDeepStrictEqual(body,{source:'untrusted_personal_context',data:[],pagination:{nextCursor:null,totalCount:0}});
        if(!produced.length&&!progressOnly&&!hostEmptyChanges)state().completeLineage=false;
        const materialPage=tool==='material_read'?produced.find(read=>read.operation==='materialRead')?.value as {text?:unknown}|undefined:undefined;
        const traceArguments=materialPage?{ref:args.ref,offset:Number(args.offset??0),length:Number(args.length??4000)}:{...args,...scope};
        const count=tool==='material_catalog'&&data&&typeof data==='object'&&Array.isArray((data as {items?:unknown}).items)?(data as {items:unknown[]}).items.length:Array.isArray(data)?data.length:data===undefined?0:1;
        state().deliveredCharacters+=serialized.length;state().trace.push({tool,arguments:traceArguments,count,...(materialPage?{materialPage:{requestedLength:Number(args.length??4000),returnedLength:String(materialPage.text??'').length}}:{}),...(tool==='attribution_context'&&data&&typeof data==='object'?{attributionPage:{contextFingerprint:String((data as {contextFingerprint?:unknown}).contextFingerprint),offset:Number((data as {offset?:unknown}).offset),total:Number((data as {total?:unknown}).total),requestedLength:Number(args.length??8000),returnedLength:String((data as {text?:unknown}).text??'').length}}:{})});
        reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:state().trace.at(-1)!.count});res.end(serialized);return;
      }
      if(pin.requires.includes('readImage')){
        const parsed=imageReadSchema.safeParse(args);
        if(!parsed.success)throw new ContextToolError('invalid_image_region','Use the declared image arguments. Regions require expectedImageSha256, integer original coordinates and sides of 1–2048.','correct_arguments',{maxRegionSide:IMAGE_REGION_MAX_SIDE});
        const selection=parsed.data;
        const imageGrant=processingImages.find(grant=>grant.id===selection.id);
        if((restricted||processingImages.length>0)&&(!imageGrant||selection.attachmentId!==undefined||selection.expectedImageSha256!==undefined&&selection.expectedImageSha256!==imageGrant.originalSha256))throw new ContextToolError('evidence_scope_denied','Use only an exact original-image id and hash listed in authorizedImages. This grant does not permit other captures or attachments.','correct_arguments');
        if(typeof args.id!=='string'||!state().expanded.has(args.id)&&!imageGrant||!reader.readImage)throw hostError('Expand derived evidence before reading an authorized image');
        for(;;){
          if(closing||res.destroyed)return;
          const direct=directImages.some(image=>image.id===args.id);
          const record=direct?directImageRecords.get(args.id):(await wait(reader.evidence({ids:[args.id]})))[0],scope=range({},bounds);
          const document=documentSchema.safeParse((record?.provenance as {document?:unknown}|undefined)?.document),at=record&&sourceContentTime({capturedAt:record.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});
          if(!record||!direct&&(scope.deviceId&&record.deviceId!==scope.deviceId||scope.after&&Date.parse(at!)<Date.parse(scope.after)||scope.before&&Date.parse(at!)>=Date.parse(scope.before)))throw hostError('Image is outside scope or deleted');
          if(args.attachmentId!==undefined&&(direct||typeof args.attachmentId!=='string'||!document.success||!document.data.attachments?.some(attachment=>attachment.id===args.attachmentId)))throw hostError('Select an image attachment declared by the expanded parent evidence');
          let rawImage:Awaited<ReturnType<NonNullable<ContextReader['readImage']>>>|undefined;
          const imagePort:HostSessionPort={tool:pin,scope:Object.freeze(scope),signal,assertCurrent:assertLive,
            async read(operation,...parameters){
              assertLive();if(operation!=='readImage'||!isDeepStrictEqual(parameters[0],selection)||rawImage)throw hostError('Read exactly the admitted image selection');
              rawImage=structuredClone(await wait(reader.readImage!(selection)));return structuredClone(rawImage) as never;
            },
            actionCatalog:async()=>{throw hostError('Action catalog is unavailable through this image read');},
            progress:message=>reportProgress(bounds,{stage:'model',message}),
          };
          let packed:ImagePayload;try{packed=await pinnedTools.resolve(pin).execute(args,imagePort) as ImagePayload;}catch(error){assertLive();throw error;}assertLive();
          if(!rawImage||packed.id!==selection.id||packed.attachmentId!==selection.attachmentId||packed.view!==selection.view||packed.expectedImageSha256!==selection.expectedImageSha256||!isDeepStrictEqual(packed.region,selection.region)||packed.image?.data!==rawImage.data||packed.image&&packed.image.mimeType!==rawImage.mimeType)throw hostError('Image result does not match the actual Host read');
          const image={...rawImage,...(packed.image?{mimeType:packed.image.mimeType,data:packed.image.data}:{})};
          if(closing||res.destroyed)return;
          const metadata=selection.view==='metadata';
          let imageView:ImageView|undefined;
          if(image.imageView){
            const checked=imageViewSchema.safeParse(image.imageView);if(!checked.success)throw hostError('Invalid image view metadata');imageView=checked.data;
            const expectedTransform=metadata?'metadata@1':selection.region?'crop-encoded-raster-png@1':'original-bytes@1';
            const expectedId=createHash('sha256').update(JSON.stringify([imageView.original.sha256,'encoded-raster-pixels-v1',selection.region??null,expectedTransform])).digest('hex');
            if(JSON.stringify(imageView.region)!==JSON.stringify(selection.region??null)||imageView.transform!==expectedTransform||imageView.viewId!==expectedId||
              selection.expectedImageSha256&&imageView.original.sha256!==selection.expectedImageSha256||
              imageView.region&&(imageView.region.x+imageView.region.width>imageView.original.width||imageView.region.y+imageView.region.height>imageView.original.height||imageView.original.pages!==1))throw hostError('Image view does not match the requested original and region');
          }else if(restricted||metadata||selection.region||selection.expectedImageSha256)throw new ContextToolError('image_view_unsupported','This image reader cannot verify metadata or regions. Use existing evidence or a plain original image request.','use_existing_evidence');
          if(imageGrant&&imageView?.original.sha256!==imageGrant.originalSha256)throw new ContextToolError('evidence_changed','The original image changed after the frozen Memory scope was created.','stop');
          const publicView:ImageViewTrace|undefined=packed.imageView?structuredClone(packed.imageView):undefined;
          if(publicView){const {id,attachmentId,delivery,...view}=publicView;if(id!==selection.id||attachmentId!==selection.attachmentId||delivery!==(metadata?'metadata':'pending')||!isDeepStrictEqual(view,imageView))throw hostError('Image view does not match its actual producer');}else if(imageView)throw hostError('Image result omitted the actual view');
          const imageBudget=()=>({remainingPayloads:Math.max(0,4-disclosedImages.size),maxRegionSide:IMAGE_REGION_MAX_SIDE,maxOutputBytes:IMAGE_MAX_BYTES});
          const sendImageResult=(result:Record<string,unknown>,entry:ToolTrace)=>{
            const {image:payload,imageDelivery:receipt,...text}=result;
            const characters=JSON.stringify(text).length;
            state().deliveredCharacters+=characters;state().trace.push(entry);reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:1});res.end(JSON.stringify(result));
          };
          if(metadata){
            if(image.data!==undefined||imageView?.output)throw hostError('Metadata must not include image bytes');
            sendImageResult({source:'untrusted_personal_context',...selection,imageView:publicView,imageBudget:imageBudget(),toolUsage:toolUsage()},{tool,arguments:selection,count:1,imageView:publicView});
            // Metadata alone cannot claim empty complete disclosure. A later
            // confirmed pixel read supplies this original's actual lineage.
            state().metadataImageIds.add(selection.id);return;
          }
          if(!['image/png','image/jpeg','image/webp'].includes(image.mimeType)||typeof image.data!=='string'||!image.data.length||image.data.length>12*1024*1024)throw hostError('Invalid image output');
          const bytes=Buffer.from(image.data,'base64'),sha256=createHash('sha256').update(bytes).digest('hex'),key=image.mimeType+':'+sha256;
          if(bytes.length>IMAGE_MAX_BYTES)throw hostError('Invalid image output size');
          if(imageView&&(!imageView.output||imageView.output.sha256!==sha256||imageView.output.mimeType!==image.mimeType||imageView.output.sizeBytes!==bytes.length||
            imageView.output.width!==(imageView.region?.width??imageView.original.width)||imageView.output.height!==(imageView.region?.height??imageView.original.height)||
            !imageView.region&&(sha256!==imageView.original.sha256||image.mimeType!==imageView.original.mimeType)))throw hostError('Image output does not match its declared view');
          const existing=disclosedImages.get(key);
          if(existing&&!existing.confirmed){
            let disconnected!:()=>void;const connectionClosed=new Promise<void>(resolve=>{disconnected=resolve;res.once('close',disconnected);});
            try{await Promise.race([existing.ready,connectionClosed]);}finally{res.off('close',disconnected);}
            // Authorization may have changed while another adapter prepared its
            // image. Read again rather than reuse the pre-wait permission result.
            continue;
          }
          const firstSelection=existing?.selection;
          if(!existing&&disclosedImages.size>=4)throw new ContextToolError('image_budget_exceeded','Image disclosure budget exceeded. Finish with existing evidence and state incomplete visual coverage.','use_existing_evidence',{remainingPayloads:0});
          if(existing?.confirmed)rememberImageRead(selection.id,publicView);
          // No await between checking and recording: concurrent identical reads
          // append at most one image. Repeats remain observable tool calls.
          let delivery:ImageDelivery|undefined;
          if(!existing){
            let settle!:()=>void;const ready=new Promise<void>(resolve=>settle=resolve),token=randomBytes(24).toString('hex');
            // A lost local adapter receipt cannot leave future readers waiting
            // forever. A late success is refused, so it cannot disclose a stale
            // reservation after a waiting reader has taken over.
            const timer=setTimeout(()=>imageDelivery(token,false),30_000);timer.unref();
            delivery={selection,record:project({...record,ocrText:''},0,0,bounds.timeZone),imageView:publicView,token,confirmed:false,ready,settle,timer};disclosedImages.set(key,delivery);
            execution.getStore()?.reservations.add(delivery);
          }
          if(firstSelection&&publicView)publicView.delivery='already_disclosed';
          sendImageResult({source:'untrusted_personal_context',...selection,...(publicView?{imageView:publicView}:{}),...(firstSelection?{
            imageDisclosure:{status:'already_disclosed',sha256,mimeType:image.mimeType,firstSelection,...(existing?.imageView?{firstImageView:existing.imageView}:{})},
            message:'These exact image bytes were already supplied in this query. Use the earlier image with this selection’s own source attribution.',
          }:{image:{mimeType:image.mimeType,data:image.data},imageDelivery:delivery!.token}),imageBudget:imageBudget(),toolUsage:toolUsage()},{tool,arguments:selection,count:1,...(publicView?{imageView:publicView}:{})});
          if(existing?.confirmed){if(!state().records.has(selection.id))remember(project({...record,ocrText:''},0,0,bounds.timeZone));state().disclosedIds.add(selection.id);}
          return;
        }
      }
      throw hostError('The registered read operation is unavailable');
    } catch (error) {
      let issue=error instanceof ContextToolError?error:new ContextToolError('context_tool_failed','The tool could not complete. Check the declared argument schema and permitted scope. Do not repeat the same failed request.','correct_arguments');
      const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
      const signature=JSON.stringify([tool,issue.code,canonical(args)]);
      repeatedFailures=signature===previousFailure?repeatedFailures+1:1;previousFailure=signature;
      if(repeatedFailures>=3)issue=new ContextToolError('repeated_tool_failure','The same invalid tool request failed three times. This run has stopped; no output will be committed.','stop',{originalCode:issue.code});
      reportTrace(bounds,{type:'tool.rejected',stage:'tool',tool,status:'rejected',payload:{...issue.toJSON(),call:calls,repeatCount:repeatedFailures,...toolUsage()}});
      res.writeHead(400).end(JSON.stringify({error:issue.message,toolError:issue.toJSON(),toolUsage:toolUsage()}));
      if(issue.recovery==='stop'||maxToolCalls!==undefined&&calls>maxToolCalls+2)rejectFailure(issue.code==='image_disclosure_disabled'
        ?new AgentResponseError('Original-image access for queries is off.','image_disclosure_disabled')
        :new AgentResponseError('Tool failure recovery exhausted.','tool_failure'));

    }
  };
  // Staged execution owns a private working view. The only eligible ledger is
  // canonical; cached maps, methods and iterators never reference this view.
  const cloneState=():State=>{
    const copy:State={
      records:new Map(canonical.records),
      sourceContextDependencies:new Map(canonical.sourceContextDependencies),
      imageReadReceipts:new Map(canonical.imageReadReceipts),
      disclosedIds:new Set(canonical.disclosedIds),
      discoveredCapabilities:new Set(canonical.discoveredCapabilities),
      discovered:new Set(canonical.discovered),
      expanded:new Set(canonical.expanded),
      discoveredSourceContexts:new Set(canonical.discoveredSourceContexts),
      metadataImageIds:new Set(canonical.metadataImageIds),
      pinnedMaterials:new Set(canonical.pinnedMaterials),
      trace:[...canonical.trace],deliveredRanges:[...canonical.deliveredRanges],
      deliveredCharacters:canonical.deliveredCharacters,completeLineage:canonical.completeLineage,
    };
    restoreEvidenceLedger(copy.records,snapshotEvidenceLedger(canonical.records));
    return copy;
  };
  const mergeStage=(stage:Stage)=>{
    // Replay additions, not a whole-state replacement. Independent image ACKs
    // can update canonical while this reader waits for their readiness promise.
    for(const key of ['disclosedIds','discoveredCapabilities','discovered','expanded','discoveredSourceContexts','metadataImageIds','pinnedMaterials'] as const)
      for(const value of stage.state[key])if(!stage.base[key].has(value))canonical[key].add(value);
    const mergeMap=<K,V>(base:Map<K,V>,working:Map<K,V>,target:Map<K,V>)=>{
      for(const [key,value]of working)if(!base.has(key)||base.get(key)!==value)target.set(key,value);
      for(const [key,value]of base)if(!working.has(key)&&target.get(key)===value)target.delete(key);
    };
    mergeMap(stage.base.sourceContextDependencies,stage.state.sourceContextDependencies,canonical.sourceContextDependencies);
    mergeMap(stage.base.imageReadReceipts,stage.state.imageReadReceipts,canonical.imageReadReceipts);
    for(const record of stage.evidence)rememberEvidence(canonical.records,record);
    canonical.trace.push(...stage.state.trace.slice(stage.base.trace.length));
    canonical.deliveredRanges.push(...stage.state.deliveredRanges.slice(stage.base.deliveredRanges.length));
    canonical.deliveredCharacters+=stage.state.deliveredCharacters-stage.base.deliveredCharacters;
    canonical.completeLineage&&=stage.state.completeLineage;
  };
  const closeSignal=new AbortController();
  // A stage excludes every ordinary HTTP writer until it settles. Existing
  // HTTP calls remain concurrent with each other (including image readers
  // whose external producer waits for another request before returning).
  type Admission={exclusive:boolean;signal:AbortSignal;grant(release:()=>void):void;abort():void};
  const admissions:Admission[]=[];
  let readers=0,exclusive=false;
  const admit=()=>{
    if(exclusive||closing)return;
    while(admissions.length){
      const next=admissions[0];if(next.exclusive&&readers)return;
      admissions.shift();next.signal.removeEventListener('abort',next.abort);
      if(next.exclusive)exclusive=true;else readers++;
      let released=false;
      next.grant(()=>{if(released)return;released=true;if(next.exclusive)exclusive=false;else readers--;admit();});
      if(next.exclusive)return;
    }
  };
  const acquireWriter=(signal:AbortSignal,wantsExclusive=true):Promise<()=>void>=>new Promise((grant,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const next:Admission={exclusive:wantsExclusive,signal,grant,abort(){
      const index=admissions.indexOf(next);if(index<0)return;
      admissions.splice(index,1);signal.removeEventListener('abort',next.abort);reject(signal.reason);admit();
    }};
    admissions.push(next);signal.addEventListener('abort',next.abort,{once:true});admit();
  });
  const activeStages=new Set<Stage>();
  const prepareDelivery:PrepareToolDelivery=async(tool,args,requestedSignal)=>{
    const signal=AbortSignal.any([requestedSignal,closeSignal.signal,...(bounds.signal?[bounds.signal]:[])]);
    const release=await acquireWriter(signal);
    let stage:Stage|undefined;
    try{
      if(closing)throw new ContextToolError('bridge_closing','The tool session is closing','stop');
      signal.throwIfAborted();bounds.assertContextAuthority?.();
      const base=cloneState(),working=cloneState();
      let settled=false;
      const clearImages=()=>{for(const value of stage?.reservations??[]){
        clearTimeout(value.timer);for(const [key,current]of disclosedImages)if(current===value)disclosedImages.delete(key);
        if(value.imageView)value.imageView.delivery='failed';value.settle();
      }};
      const finish=()=>{signal.removeEventListener('abort',abort);if(stage)activeStages.delete(stage);release();};
      const discard=()=>{if(settled)return;settled=true;stage!.status='discarded';clearImages();finish();};
      const abort=()=>{stage!.cancelled=signal.reason;discard();};
      stage={base,state:working,evidence:[],signal,callbacks:[],delivered:[],reservations:new Set(),checks:new Set(),status:'reading',discard};activeStages.add(stage);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      let status=200,body:string|undefined;
      const reply={get destroyed(){return signal.aborted||closing;},writeHead(code:number){status=code;return reply;},end(value:string,delivered?:()=>void){body=value;if(delivered)stage!.delivered.push(delivered);},once(){},off(){}};
      await execution.run(stage,()=>executeTool({tool,readArguments:async()=>args},reply));
      if(stage.status==='discarded'){clearImages();signal.throwIfAborted();throw new ContextToolError('bridge_closing','The tool session closed before delivery','stop');}
      signal.throwIfAborted();bounds.assertContextAuthority?.();
      if(stage.fatal)throw stage.fatal;
      if(status>=400){
        let issue:Record<string,unknown>|undefined;try{issue=(JSON.parse(body??'{}') as {toolError?:Record<string,unknown>}).toolError;}catch{}
        const recovery=issue?.recovery==='correct_arguments'||issue?.recovery==='use_existing_evidence'||issue?.recovery==='stop'?issue.recovery:'stop';
        throw new ContextToolError(typeof issue?.code==='string'?issue.code:'context_tool_failed',typeof issue?.message==='string'?issue.message:'The tool could not complete.',recovery,issue?.details&&typeof issue.details==='object'?issue.details as Record<string,unknown>:{});
      }
      if(typeof body!=='string')throw new ContextToolError('context_tool_failed','The tool produced no deliverable response','stop');
      const value:unknown=JSON.parse(body);stage.status='pending';
      const current=stage;
      return {value,
        confirm(){
          if(settled){if(current.cancelled!==undefined)throw current.cancelled;return;}
          try{
            signal.throwIfAborted();bounds.assertContextAuthority?.();for(const check of current.checks)check();
            if(closing)throw new ContextToolError('bridge_closing','The tool session closed before confirmation','stop');
            // Memory receipt persistence is required, unlike observation. A
            // failure must reach this synchronous confirm/Host sender boundary.
            for(const event of current.callbacks.filter(event=>event.name==='onMemoryBodies')){
              const callback=callbacks.get(event.name);
              try{if(typeof callback==='function')execution.exit(()=>(callback as (...args:unknown[])=>void)(...event.args));}
              catch(error){rejectFailure(error instanceof Error?error:new Error('Memory delivery receipt could not be recorded'));throw error;}
            }
            signal.throwIfAborted();bounds.assertContextAuthority?.();for(const check of current.checks)check();
            if(closing)throw new ContextToolError('bridge_closing','The tool session closed before confirmation','stop');
            const token=value&&typeof value==='object'?(value as {imageDelivery?:unknown}).imageDelivery:undefined;
            if(typeof token==='string'&&![...disclosedImages.values()].some(image=>image.token===token))throw hostError('Image delivery receipt expired');
            mergeStage(current);current.status='committed';settled=true;
            if(typeof token==='string')execution.exit(()=>imageDelivery(token,true));
            for(const event of current.callbacks.filter(event=>event.name!=='onMemoryBodies')){
              const callback=callbacks.get(event.name);try{if(typeof callback==='function')execution.exit(()=>(callback as (...args:unknown[])=>void)(...event.args));}catch{}
            }
            execution.run(current,()=>{for(const callback of current.delivered)callback();});
            if(current.fatal)throw current.fatal;
          }catch(error){if(!settled)discard();throw error;}finally{if(settled)finish();}
        },
        discard,
      };
    }catch(error){stage?.discard();release();throw error;}
  };
  // Every ordinary writer shares the complete stage window. Image ACK is an
  // independent completion, not another read, and must remain able to unblock
  // a reader waiting on an existing image reservation.
  const handle:BridgeToolHandler=async(request,res)=>{
    if(request.tool==='_image_delivery')return execution.exit(()=>executeTool(request,res));
    const disconnected=new AbortController(),abort=()=>disconnected.abort(new DOMException('Tool client disconnected','AbortError'));
    res.once('close',abort);
    const signal=AbortSignal.any([closeSignal.signal,disconnected.signal,...(bounds.signal?[bounds.signal]:[])]);
    let release:(()=>void)|undefined;
    try{release=await acquireWriter(signal,false);if(!res.destroyed)await execution.exit(()=>executeTool(request,res));}
    catch(error){if(!res.destroyed)res.writeHead(400).end(JSON.stringify({error:'The tool session closed before delivery'}));}
    finally{res.off('close',abort);release?.();}
  };
  const session={
    imageDelivery,prepareDelivery,failure,trace:canonical.trace,records:canonical.records,seedEvidence,
    get deliveredRanges(){
      const merged:{id:string;offset:number;length:number}[]=[];
      for(const range of [...canonical.deliveredRanges].sort((a,b)=>a.id.localeCompare(b.id)||a.offset-b.offset||a.length-b.length)){
        const prior=merged.at(-1);if(prior&&prior.id===range.id&&range.offset<=prior.offset+prior.length)prior.length=Math.max(prior.offset+prior.length,range.offset+range.length)-prior.offset;
        else merged.push({...range});
      }return merged;
    },
    get sourceContextDependencies(){return [...canonical.sourceContextDependencies.values()];},
    get imageReadReceipts(){return [...canonical.imageReadReceipts.values()].map(value=>structuredClone(value));},
    get evidenceDependencies(){return {version:1 as const,complete:canonical.completeLineage&&[...canonical.metadataImageIds].every(id=>canonical.disclosedIds.has(id)),ids:[...canonical.disclosedIds]};},
    get deliveredCharacters(){return canonical.deliveredCharacters;},get ready(){return ready;},
  };
  const close=()=>execution.exit(()=>{
    closing=true;if(!inheritedRegistry)releaseContextTools(bounds);for(const stage of [...activeStages])stage.discard();closeSignal.abort(new DOMException('Tool session closed','AbortError'));
    const observer=callbacks.get('onEvidence');
    try{if(typeof observer==='function')observer(evidenceLayers(canonical.records));}catch{}
    for(const value of disclosedImages.values()){clearTimeout(value.timer);if(!value.confirmed&&value.imageView)value.imageView.delivery='failed';value.settle();}
    disclosedImages.clear();
  });
  return {handle,session,close};
}
