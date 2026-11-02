import {imageReadSchema,imageViewSchema,IMAGE_MAX_BYTES,IMAGE_REGION_MAX_SIDE,type ImageView,type ImageViewTrace} from '@mote/shared';
import {CONTEXT_TOOLS} from './context-tools.js';
import {pinContextTools,registeredContextToolDefinitions,NATIVE_CONTEXT_TOOLS} from './tool-contributions.js';
import {validateCapabilityArguments} from './capability-schema.js';
import {rememberEvidence,evidenceLayers,projectEvidencePresentation,copyEvidencePresentation,snapshotEvidenceLedger,restoreEvidenceLedger} from './evidence-ledger.js';
import {AgentYieldError,hostControlDefinitions} from './host-controls.js';
import {taskTools,dispatchTools} from './task-context.js';
import {actionEvidenceText,parseEvidenceRef,parseEvidenceId,formatEvidenceRef} from '@mote/shared';
import {ContextToolError} from './tool-errors.js';
import {AgentResponseError,reportTrace,reportProgress} from './types.js';
import {sourceProtocolInstructions} from './instructions.js';
import {extractionSeedScopeValid} from './extraction-seed-scope.js';
import {randomBytes,createHash} from "node:crypto";
import type {BridgeToolHandler,PreparedToolDelivery,PrepareToolDelivery} from "./bridge-contracts.js";
import { displayTime } from './time.js';
import {stateSeriesSchema,fileEvidenceSchema,recordMetadataSchema, sourceMetadataSchema, sourceSchema,documentSchema,sourceContentTime,attributionContextSchema,sourceContextDeclarationSchema,type SourceContextDeclaration} from '@mote/shared';
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

/** Deliberately projects public evidence fields; no file paths, tokens, or images reach the model. */
function project(record: ContextRecord, offset = 0, length = 600, timeZone = 'UTC'): ContextRecord {
  const text = String(record.ocrText ?? "");
  let start = Math.min(offset, text.length), end = Math.min(start + length, text.length);
  // Offsets are UTF-16 units, as in stored JS strings; never split an emoji pair.
  const splitsPair = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
  if (splitsPair(start)) start--;
  if (splitsPair(end)) end--;
  if (end <= start && start < text.length) end = Math.min(start + 2, text.length);
  const duration = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0 ? record.durationMs : 0;
  const intervalStart = duration ? new Date(Date.parse(record.capturedAt) - duration).toISOString() : undefined;
  const metadata = recordMetadataSchema.safeParse(record.metadata);
  const sourceMetadata = sourceMetadataSchema.safeParse((record.provenance as Record<string, unknown> | undefined)?.metadata);
  const document = documentSchema.safeParse((record.provenance as Record<string, unknown> | undefined)?.document);
  const attribution = attributionContextSchema.safeParse(record.attributionContext);
  const contentAt = sourceContentTime({capturedAt:record.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});
  const projected:ContextRecord = {
    ...(fileEvidenceSchema.safeParse(record.fileEvidence).success?{fileEvidence:fileEvidenceSchema.parse(record.fileEvidence)}:{}),
    ...(stateSeriesSchema.safeParse(record.stateSeries).success?{stateSeries:stateSeriesSchema.parse(record.stateSeries)}:{}),
    evidenceFingerprint:createHash('sha256').update(JSON.stringify([text,record.provenance,record.fileEvidence,...(attribution.success&&(attribution.data.basis!=='default'||attribution.data.correction||attribution.data.sourceDeclaration||attribution.data.materialDeclarations||attribution.data.declarations||attribution.data.ownerStatements||attribution.data.importDeclarations||attribution.data.importStatements||attribution.data.sourceContextDeclarations?.length||attribution.data.sourceContextStatements?.length||attribution.data.recordContextDeclarations?.length||attribution.data.recordContextStatements?.length)?[attribution.data]:[])])).digest('hex'),
    ...(attribution.success?{attributionContext:attribution.data}:{}),
    ...(record.retrieval?{retrieval:record.retrieval}:{}),
    estimatedReadCharacters:text.length,
    id: record.id,
    capturedAt: record.capturedAt,
    displayCapturedAt: displayTime(record.capturedAt, timeZone),
    contentAt,displayContentAt:displayTime(contentAt,timeZone),
    timeZone,
    ...(intervalStart ? { sampleInterval: {
      start: intervalStart, end: record.capturedAt,
      displayStart: displayTime(intervalStart, timeZone), displayEnd: displayTime(record.capturedAt, timeZone),
    } } : {}),
    appName: record.appName,
    ...(record.contentLayer?{contentLayer:record.contentLayer}:{}),
    ...(record.perception?{perception:record.perception}:{}),
    ...(record.perceptionJobs?{perceptionJobs:record.perceptionJobs}:{}),
    availableLayers: ['text',...(record.blobHash?['image_on_request']:[])],
    ...(typeof record.appId === 'string' ? {appId: record.appId.slice(0, 300)} : {}),
    ...(metadata.success ? {metadata: {...metadata.data, displayObservedAt: displayTime(metadata.data.observedAt, timeZone)}} : {}),
    ...(record.privacy && typeof record.privacy === 'object' && ['content', 'activity'].includes(String((record.privacy as Record<string,unknown>).collection))
      ? {collection: (record.privacy as Record<string,unknown>).collection} : {}),
    ...(record.revisionState?{revisionState:record.revisionState}:{}),
    ...(typeof record.windowTitle==='string'?{title:record.windowTitle.slice(0,2000)}:{}),
    ...(record.provenance&&typeof record.provenance==='object'?{provenance:{
      sourceId:(record.provenance as Record<string,unknown>).sourceId,
      externalId:(record.provenance as Record<string,unknown>).externalId,
      ...(document.success?{document:document.data}:{}),
      layer:(record.provenance as Record<string,unknown>).layer,
      deleted:(record.provenance as Record<string,unknown>).deleted,
      revision:(record.provenance as Record<string,unknown>).revision,
      calendar:(record.provenance as Record<string,unknown>).calendar,
      modifiedAt:(record.provenance as Record<string,unknown>).modifiedAt,
      ...(sourceMetadata.success ? {metadata:sourceMetadata.data} : {}),
      originalAvailable:(record.provenance as Record<string,unknown>).layer!=='reference',
    }}:{}),
    ocrText: text.slice(start, end),
    textRange: { start, end, total: text.length, nextOffset: end < text.length ? end : null },
    ...(record.summary === undefined
      ? {}
      : { summary: String(record.summary).slice(0, 400) }),
    ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
    ...(record.sourceType === undefined
      ? {}
      : { sourceType: record.sourceType }),
    ...(typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
      ? { durationMs: record.durationMs } : {}),
    ...(typeof record.mood === "string"
      ? { mood: record.mood.slice(0, 80) }
      : {}),
  };
  return projectEvidencePresentation(record,projected);
}
/** Host adapters may create receipts only from a freshly authorized full original. */
export function originalEvidenceReceipt(record:ContextRecord,offset=0,length=600,timeZone='UTC'){return project(record,offset,length,timeZone);}

/** Health reports are not archive coverage. Keep their timestamps out of the record namespace. */
function projectDevice(value: unknown, timeZone = 'UTC'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const device = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['deviceId', 'deviceName', 'platform']) {
    if (typeof device[key] === 'string') result[key] = device[key].slice(0, 300);
  }
  const healthReport: Record<string, unknown> = {};
  for (const [key, label] of [['status', 'statusAsReported'], ['lastSeenAt', 'receivedAt'], ['lastCaptureAt', 'lastCaptureAtAsReported']]) {
    if (typeof device[key] === 'string') {
      healthReport[label] = device[key].slice(0, 100);
      if (key !== 'status' && Number.isFinite(Date.parse(device[key])))
        healthReport['display' + label[0].toUpperCase() + label.slice(1)] = displayTime(device[key], timeZone);
    }
  }
  if (typeof device.queueDepth === 'number' && Number.isSafeInteger(device.queueDepth) && device.queueDepth >= 0)
    healthReport.queueDepthAsReported = device.queueDepth;
  if (Object.keys(healthReport).length) result.healthReport = healthReport;
  const metadata = recordMetadataSchema.safeParse(device.metadata);
  if (metadata.success) result.metadata = {...metadata.data, displayObservedAt: displayTime(metadata.data.observedAt, timeZone)};
  return result;
}

const pinnedSourceContextRef=/^source-context:([A-Za-z0-9_-]+)@([1-9][0-9]*)#([a-f0-9]{64})$/;
const pinnedMaterialRef=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/;
/** Keep statement identities/scopes in ordinary responses; prose has its own
 * authorized, lossless disclosure path and never affects original grants. */
function attributionMetadata(value:unknown){
  const parsed=attributionContextSchema.safeParse(value);if(!parsed.success)return undefined;
  const {ownerStatements:_owner,importStatements:_import,sourceContextStatements:_source,recordContextStatements:_record,...metadata}=parsed.data;
  return metadata;
}
function attributionMetadataResponse(value:unknown,parentLocator?:{id:string}|{ref:string}):unknown {
  if(Array.isArray(value))return value.map(item=>attributionMetadataResponse(item,parentLocator));
  if(!value||typeof value!=='object')return value;
  const object=value as Record<string,unknown>;
  const locator=typeof object.ref==='string'&&pinnedMaterialRef.test(object.ref)?{ref:object.ref}:
    typeof object.id==='string'&&parseEvidenceId(object.id)?{id:parseEvidenceId(object.id)!}:parentLocator;
  const result:Record<string,unknown>={};
  for(const [key,item] of Object.entries(object)){
    if(key==='attributionContext'){
      const metadata=attributionMetadata(item);if(metadata){result[key]=metadata;if(locator)result.attributionContextLocator=locator;}
    }else if(key==='attributionContexts'&&item&&typeof item==='object'&&!Array.isArray(item)){
      result[key]=Object.fromEntries(Object.entries(item).flatMap(([id,context])=>{const metadata=attributionMetadata(context);return metadata?[[id,metadata]]:[];}));
    }else result[key]=attributionMetadataResponse(item,locator);
  }
  return result;
}
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
  bounds=pinContextTools({...bounds,...(bounds.evidenceIds?{evidenceIds:[...bounds.evidenceIds]}:{}),...(bounds.anchorEvidenceIds?{anchorEvidenceIds:[...bounds.anchorEvidenceIds]}:{}),...(bounds.evidenceRanges?{evidenceRanges:bounds.evidenceRanges.map(range=>({...range}))}:{}),...(bounds.evidenceReadRanges?{evidenceReadRanges:Object.freeze(bounds.evidenceReadRanges.map(range=>Object.freeze({...range})))}:{})},reader);
  const contributions=new Map((bounds.toolContributions??[]).map(tool=>[tool.name,tool]));
  const specialCapabilities=new Map(registeredContextToolDefinitions(bounds).filter(([name])=>dispatchTools(bounds).includes(name)&&!NATIVE_CONTEXT_TOOLS.has(name)&&!name.startsWith('delegation_')).map(([name,description,fields])=>[name,{name,version:contributions.get(name)?.version??'1',description,fields}]));
  const discoveredCapabilities=new Set<string>();
  const controls=new Set(hostControlDefinitions(bounds.hostControlChannel).map(([name])=>name));
  const trace: ToolTrace[] = [];
  const records = new Map<string, ContextRecord>();
  const remember=(record:ContextRecord)=>{rememberEvidence(records,record);try{bounds.onEvidence?.([record]);}catch{/* Receipt observation cannot grant new reads. */}};
  const sourceContextDependencies=new Map<string,SourceContextDeclaration>();
  const rememberSourcePin=(pin:SourceContextDeclaration)=>{
    const key=JSON.stringify(pin);if(sourceContextDependencies.has(key))return;
    sourceContextDependencies.set(key,{...pin});bounds.onSourceContextDependencies?.([...sourceContextDependencies.values()].map(value=>Object.freeze({...value})));
  };
  for(const pin of [...(bounds.contextSourceContextDependencies??[]),...(bounds.conversation?.sourceContextDependencies??[])])rememberSourcePin(pin);
  const discoveredSourceContexts=new Set<string>();
  const rememberSourceContexts=(value:unknown)=>{
    if(Array.isArray(value)){for(const item of value)rememberSourceContexts(item);return;}
    if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>,ref=row.sourceContextRef;
    if(typeof ref==='string'){
      const match=pinnedSourceContextRef.exec(ref);
      if(match){const sourceId=Buffer.from(match[1],'base64url').toString('utf8'),version=Number(match[2]);
        if(sourceId.length>0&&sourceId.length<=128&&Number.isSafeInteger(version)){discoveredSourceContexts.add(ref);rememberSourcePin({sourceId,version,fingerprint:match[3]});}}
    }
    const attribution=attributionContextSchema.safeParse(row.attributionContext);
    if(attribution.success)for(const pin of attribution.data.sourceContextDeclarations??[])rememberSourcePin(pin);
    for(const [key,item] of Object.entries(row))if(key!=='attributionContext')rememberSourceContexts(item);
  };
  const disclosedIds=new Set([...(bounds.conversation?.evidenceDependencies?.ids??[]),...(bounds.contextEvidenceDependencies?.ids??[]),...(bounds.derivedContextEvidenceIds??[])]);
  let completeLineage=(!bounds.conversation||bounds.conversation.evidenceDependencies?.complete===true)&&
    (!bounds.contextEvidenceDependencies||bounds.contextEvidenceDependencies.complete)&&
    (!bounds.openingMemories?.length||bounds.contextEvidenceDependencies?.complete===true&&bounds.contextEvidenceDependencies.ids.length>0)&&
    (!bounds.taskContext?.previousSummary&&!bounds.taskContext?.turns?.length||bounds.contextEvidenceDependencies?.complete===true);
  const rememberDisclosureDependencies=(receipt:unknown)=>{
    const value=receipt&&typeof receipt==='object'&&!Array.isArray(receipt)?receipt as Record<string,unknown>:undefined;
    if(!value||value.version!==1||typeof value.complete!=='boolean'||!Array.isArray(value.ids)||
      Object.keys(value).some(key=>!['version','complete','ids'].includes(key))||value.ids.some(id=>typeof id!=='string'||!parseEvidenceId(id))){completeLineage=false;return;}
    completeLineage &&= value.complete;
    for(const id of value.ids as string[])disclosedIds.add(parseEvidenceId(id)!);
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
  for(const record of seedEvidence){remember(record);disclosedIds.add(record.id);}
  rememberSourceContexts(seedEvidence);
  const directImages=bounds.directImages??[];
  if(directImages.length>8||new Set(directImages.map(image=>image.id)).size!==directImages.length||directImages.some(image=>
    !/^[0-9a-f-]{36}$/i.test(image.id)||!['image/png','image/jpeg','image/webp'].includes(image.mimeType)||
    !/^[a-f0-9]{64}$/.test(image.hash)||!Number.isSafeInteger(image.sizeBytes)||image.sizeBytes<1||image.sizeBytes>8*1024*1024||image.name.length>500))throw hostError('Invalid direct image attachments');
  if(restricted&&directImages.length)throw hostError('Extraction sessions cannot receive dialogue images');
  const directImageRecords=new Map<string,ContextRecord>();
  const metadataImageIds=new Set<string>();
  for(const image of directImages){
    const record:ContextRecord={id:image.id,capturedAt:bounds.contextTime??new Date().toISOString(),appName:image.name,ocrText:'',sourceType:'user_attachment',summary:'User attached image',metadata:{mimeType:image.mimeType}};
    directImageRecords.set(image.id,record);
  }
  // Reference locators may be expanded through the normal current-authorized reader.
  // They contain no delivered text and cannot support citations before a read.
  const discovered=new Set([...records.keys(),...(!restricted?bounds.anchorEvidenceIds??[]:[])]);
  const pinnedMaterials=new Set<string>(!restricted&&bounds.anchorMaterialRef&&pinnedMaterialRef.test(bounds.anchorMaterialRef)?[bounds.anchorMaterialRef]:[]);
  let deliveredCharacters=JSON.stringify(seedEvidence).length;
  const deliveredRanges=seedEvidence.flatMap(record=>{const span=record.textRange as {start:number;end:number};return span.end>span.start?[{id:record.id,offset:span.start,length:span.end-span.start}]:[];});
  const expanded=new Set<string>();
  for(const image of directImages)expanded.add(image.id);
  // Query-local byte identities only: never skip the reader's fresh authorization
  // or merge the source attribution of two selections containing the same image.
  type ImageDelivery={selection:{id:string;attachmentId?:string};record:ContextRecord;imageView?:ImageViewTrace;token:string;confirmed:boolean;ready:Promise<void>;settle:()=>void;timer:ReturnType<typeof setTimeout>};
  const disclosedImages=new Map<string,ImageDelivery>();
  const imageReadReceipts=new Map<string,{id:string;imageView:ImageView}>();
  const rememberImageRead=(id:string,value:ImageViewTrace|undefined)=>{
    if(!value?.output)return;
    const {id:_id,attachmentId:_attachment,delivery:_delivery,...imageView}=value;
    imageReadReceipts.set(JSON.stringify([id,imageView.viewId]),{id,imageView:structuredClone(imageView)});
  };
  let closing=false;
  const imageDelivery=(token:string,delivered:boolean)=>{
    const entry=[...disclosedImages].find(([,value])=>value.token===token);
    if(!entry){if(delivered)throw hostError('Image delivery receipt expired');return;}
    const [key,value]=entry;clearTimeout(value.timer);
    if(delivered){value.confirmed=true;if(!records.has(value.selection.id))remember(value.record);disclosedIds.add(value.selection.id);rememberImageRead(value.selection.id,value.imageView);}else disclosedImages.delete(key);
    if(value.imageView)value.imageView.delivery=delivered?'prepared':'failed';
    value.settle();
  };
  let calls = 0;
  let ready = false;
  let rejectFailure!:(error:Error)=>void;
  const failure=new Promise<never>((_,reject)=>rejectFailure=reject);void failure.catch(()=>{});
  let previousFailure='',repeatedFailures=0;
  const countToolCall=()=>{
    calls++;
    if(maxToolCalls!==undefined&&calls>maxToolCalls)throw new ContextToolError('tool_budget_exceeded','The explicitly configured tool call limit was reached. Finish with already retrieved evidence.','use_existing_evidence',{remainingCalls:0});
  };
  // Character counts are observations. Only an explicit caller limit is enforced.
  const toolUsage=()=>({calls,deliveredCharactersBeforeResult:deliveredCharacters,unit:'utf16_characters',...(maxToolCalls!==undefined?{remainingCalls:Math.max(0,maxToolCalls-calls)}:{})});

  let stagingBase:StagedState|undefined;
  type StagedState={
    records:Map<string,ContextRecord>;
    evidenceLedger:Map<string,ContextRecord>;
    deliveredRanges:{id:string;offset:number;length:number}[];
    disclosedIds:Set<string>;
    discoveredCapabilities:Set<string>;
    sourceContextDependencies:Map<string,SourceContextDeclaration>;
    discovered:Set<string>;
    expanded:Set<string>;
    discoveredSourceContexts:Set<string>;
    metadataImageIds:Set<string>;
    pinnedMaterials:Set<string>;
    deliveredCharacters:number;
    trace:ToolTrace[];
    completeLineage:boolean;
    imageReadReceipts:Map<string,{id:string;imageView:ImageView}>;
    disclosedImages:Map<string,ImageDelivery>;
  };
  const captureState=():StagedState=>({
    records:new Map(records),
    evidenceLedger:snapshotEvidenceLedger(records),
    deliveredRanges:deliveredRanges.map(range=>({...range})),
    disclosedIds:new Set(disclosedIds),
    discoveredCapabilities:new Set(discoveredCapabilities),
    sourceContextDependencies:new Map([...sourceContextDependencies].map(([key,value])=>[key,{...value}])),
    discovered:new Set(discovered),
    expanded:new Set(expanded),
    discoveredSourceContexts:new Set(discoveredSourceContexts),
    metadataImageIds:new Set(metadataImageIds),
    pinnedMaterials:new Set(pinnedMaterials),
    deliveredCharacters,
    trace:trace.map(entry=>({...entry})),
    completeLineage,
    imageReadReceipts:new Map([...imageReadReceipts].map(([key,value])=>[key,{id:value.id,imageView:structuredClone(value.imageView)}])),
    disclosedImages:new Map([...disclosedImages].map(([key,value])=>[key,{...value}])),
  });
  const publicRecords=new Proxy(records,{
    get(target,property){
      const source=stagingBase?.records??target,value=Reflect.get(source,property,source);
      return typeof value==='function'?value.bind(source):value;
    },
    has(target,property){return Reflect.has(stagingBase?.records??target,property);},
  });
  const applyState=(state:StagedState)=>{
    records.clear();for(const [key,value] of state.records)records.set(key,value);
    restoreEvidenceLedger(records,state.evidenceLedger);
    deliveredRanges.length=0;deliveredRanges.push(...state.deliveredRanges.map(range=>({...range})));
    disclosedIds.clear();for(const id of state.disclosedIds)disclosedIds.add(id);
    discoveredCapabilities.clear();for(const name of state.discoveredCapabilities)discoveredCapabilities.add(name);
    sourceContextDependencies.clear();for(const [key,value] of state.sourceContextDependencies)sourceContextDependencies.set(key,{...value});
    discovered.clear();for(const id of state.discovered)discovered.add(id);
    expanded.clear();for(const id of state.expanded)expanded.add(id);
    discoveredSourceContexts.clear();for(const ref of state.discoveredSourceContexts)discoveredSourceContexts.add(ref);
    metadataImageIds.clear();for(const id of state.metadataImageIds)metadataImageIds.add(id);
    pinnedMaterials.clear();for(const ref of state.pinnedMaterials)pinnedMaterials.add(ref);
    deliveredCharacters=state.deliveredCharacters;
    trace.length=0;trace.push(...state.trace.map(entry=>({...entry})));
    completeLineage=state.completeLineage;
    imageReadReceipts.clear();for(const [key,value] of state.imageReadReceipts)imageReadReceipts.set(key,{id:value.id,imageView:structuredClone(value.imageView)});
    disclosedImages.clear();for(const [key,value] of state.disclosedImages)disclosedImages.set(key,{...value});
  };
  type DeferredCallbacks={originals:Map<string,unknown>;events:{name:string;args:unknown[]}[]};
  const callbackNames=['onEvidence','onSourceContextDependencies','onTrace','onProgress','onMemoryBodies'] as const;
  const beginCallbacks=():DeferredCallbacks=>{
    const originals=new Map<string,unknown>(),events:{name:string;args:unknown[]}[]=[];
    for(const name of callbackNames){
      originals.set(name,(bounds as unknown as Record<string,unknown>)[name]);
      (bounds as unknown as Record<string,unknown>)[name]=(...args:unknown[])=>events.push({name,args});
    }
    return {originals,events};
  };
  const endCallbacks=(deferred:DeferredCallbacks)=>{
    for(const name of callbackNames)(bounds as unknown as Record<string,unknown>)[name]=deferred.originals.get(name);
  };
  const flushCallbacks=(deferred:DeferredCallbacks)=>{
    for(const event of deferred.events){
      const callback=deferred.originals.get(event.name);
      if(typeof callback!=='function')continue;
      try{(callback as (...args:unknown[])=>void)(...event.args);}catch(error){
        if(event.name==='onMemoryBodies')rejectFailure(error instanceof Error?error:new Error('Memory delivery receipt could not be recorded'));
        /* Other observation callbacks cannot change the receipt. */
      }
    }
  };
  let prepareLock=Promise.resolve();
  const activeStaged=new Set<PreparedToolDelivery>();
  const handle:BridgeToolHandler = async (request, res) => {
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
        deliveredCharacters+=serialized.length;if(selected)discoveredCapabilities.add(selected.name);
        trace.push({tool,arguments:args,count:selected?1:specialCapabilities.size});res.end(serialized);return;
      }
      if(tool==='capability_execute'){
        if(!taskTools(bounds).includes(tool))throw hostError('Capability execution is unavailable for this task');
        countToolCall();
        if(Object.keys(args).some(key=>!['name','version','argumentsJson'].includes(key))||typeof args.name!=='string'||typeof args.version!=='string'||typeof args.argumentsJson!=='string'||args.argumentsJson.length>65536)throw hostError('Invalid capability execution');
        const selected=specialCapabilities.get(args.name);
        if(!selected||!discoveredCapabilities.has(selected.name)||selected.version!==args.version)throw hostError('Discover this exact registered capability and version first');
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
        for(const record of delivered){remember(record);discovered.add(record.id);disclosedIds.add(record.id);expanded.add(record.id);}
        for(const id of dependencyIds)disclosedIds.add(id);
        for(const pin of sourcePins)rememberSourcePin(pin);
        deliveredCharacters+=serialized.length;trace.push({tool,arguments:args,count:delivered.length});
        reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:delivered.length});
        res.end(serialized,()=>{if(result.yield)rejectFailure(new AgentYieldError());});return;
      }
      if (!TOOL_NAMES.includes(tool)&&!contributions.has(tool)) {
        res.writeHead(404).end('{"error":"Unknown tool"}');
        return;
      }
      if(!dispatchTools(bounds).includes(tool)||!dispatchedViaCatalog&&!taskTools(bounds).includes(tool))throw hostError('Tool is unavailable for this task; use the discovered capability gateway');
      if(tool==='progress_update'){
        if(typeof args.message!=='string'||!args.message.trim()||args.message.length>600)throw hostError('Progress message must contain 1–600 characters');
        reportProgress(bounds,{stage:'model',message:args.message.trim()});
        res.end('{"ok":true}');return;
      }
      if (!contributions.has(tool)&&!['timeline','search_context','activity','media_activity','segments','context_index'].includes(tool) && ['source','appId','collection'].some(field => args[field] !== undefined))
        throw hostError('App/source/collection filters require a context or activity tool');
      if (!contributions.has(tool)&&tool !== 'media_activity' && ['appVisibility','screenLocked','playbackType'].some(field => args[field] !== undefined))
        throw hostError('Media state filters require media_activity');
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
      if(tool==='evidence'&&Array.isArray(args.ids))args={...args,ids:args.ids.map(captureId)};
      if(['read_image','read_file_evidence','file_chunks','source_history','context_evidence'].includes(tool)||tool==='attribution_context'&&args.id!==undefined)args={...args,id:captureId(args.id)};
      if(!dispatchedViaCatalog)countToolCall();
      reportProgress(bounds,{stage:'tool',tool,phase:'started'});
      if(bounds.skill==='working-memory')throw hostError('Working memory uses only the supplied dialogue; retrieval is disabled');
      const contribution=contributions.get(tool);
      if(contribution){
        const scope=Object.freeze(range(args,bounds)),parsed=Object.freeze(contribution.parse(args));
        if(!await contribution.authorize(scope,parsed))throw hostError('Context capability is unavailable or outside the authorized scope');
        bounds.signal?.throwIfAborted();
        const value=await contribution.read(parsed,{scope,signal:bounds.signal});
        if(!await contribution.authorize(scope,parsed))throw hostError('Context capability was revoked');
        const serialized=JSON.stringify({source:'untrusted_personal_context',version:contribution.version,data:value??null,evidencePolicy:'Metadata only; no original citation grants.',toolUsage:toolUsage()});
        deliveredCharacters+=serialized.length;completeLineage=false;
        trace.push({tool,arguments:{...parsed,...scope},count:1});reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:1});res.end(serialized);return;
      }
      if(tool==='action_catalog'){
        if(bounds.skill!=='calendar-extraction'||!bounds.actionCatalog)throw hostError('Action catalog is not authorized for this task');
        if(Object.keys(args).some(key=>!['query','id','cursor','limit'].includes(key))||args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200)||args.id!==undefined&&(typeof args.id!=='string'||!/^[0-9a-f-]{36}$/i.test(args.id))||args.cursor!==undefined&&(typeof args.cursor!=='string'||args.cursor.length>4096)||args.limit!==undefined&&(!Number.isInteger(args.limit)||Number(args.limit)<1||Number(args.limit)>20))throw hostError('Invalid action catalog arguments');
        const scope=range({},bounds),effective={...scope,...args,limit:Number(args.limit??8)};
        const value=await bounds.actionCatalog(effective),serialized=JSON.stringify({data:value,evidencePolicy:'Untrusted prior proposals; sameAs identifiers only, not original citation grants.',toolUsage:toolUsage()});
        deliveredCharacters+=serialized.length;trace.push({tool,arguments:args,count:value.items.length});reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:value.items.length});res.end(serialized);return;
      }
      if(tool==='material_catalog'){
        if(Object.keys(args).some(key=>!['after','before','deviceId','limit','cursor','sourceId','kind','query'].includes(key)))throw hostError('Invalid material catalog filter');
        for(const key of ['sourceId','kind','query'])if(args[key]!==undefined&&(typeof args[key]!=='string'||!args[key]||String(args[key]).length>128))throw hostError(`Invalid ${key}`);
        const scope=range(args,bounds),effective={...scope,sourceId:args.sourceId as string|undefined,kind:args.kind as string|undefined,query:args.query as string|undefined};
        const page=await reader.materialCatalog?.(effective)??{items:[],nextCursor:null};
        if(!page||!Array.isArray(page.items)||(page.nextCursor!==null&&(typeof page.nextCursor!=='string'||page.nextCursor.length>4096)))throw hostError('Invalid material catalog page');
        const items=page.items.slice(0,scope.limit).map(item=>materialMetadata(item,scope)).filter((item):item is Record<string,unknown>=>Boolean(item));
        const serialized=JSON.stringify({source:'untrusted_personal_context',data:{items,nextCursor:page.nextCursor},toolUsage:toolUsage()});
        deliveredCharacters+=serialized.length;
        rememberSourceContexts(items);
        for(const item of items)pinnedMaterials.add(item.ref as string);
        rememberDisclosureDependencies(page.disclosureDependencies);
        trace.push({tool,arguments:effective,count:items.length});reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:items.length});res.end(serialized);return;
      }
      if(tool==='material_read'){
        if(Object.keys(args).some(key=>!['ref','offset','length'].includes(key))||typeof args.ref!=='string'||!pinnedMaterialRef.test(args.ref)||!pinnedMaterials.has(args.ref))throw hostError('Use the owner-selected pinned material ref or one returned by material_catalog in this run');
        const offset=args.offset??0,length=args.length??4000;
        if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>12000)throw hostError('Invalid material read range');
        if(!reader.materialRead)throw hostError('Material reading is unavailable');
        const scope=range({},bounds);
        if(closing||res.destroyed)return;
        bounds.signal?.throwIfAborted();
        const page=await reader.materialRead({...scope,ref:args.ref,offset:Number(offset),length:Number(length)});
        bounds.signal?.throwIfAborted();
        const material=materialMetadata(page.material,scope);
        if(!material||material.ref!==args.ref||typeof page.text!=='string'||page.text.length>Number(length)||!page.textRange||page.textRange.offset!==offset||!Number.isSafeInteger(page.textRange.total)||page.textRange.total<Number(offset)+page.text.length||page.textRange.nextOffset!==(Number(offset)+page.text.length<page.textRange.total?Number(offset)+page.text.length:null)||page.text.length===0&&Number(offset)<page.textRange.total||!Array.isArray(page.spans)||page.spans.length>64||!Array.isArray(page.originalRefs))throw hostError('Invalid material read page');
        const spans=page.spans.map(span=>{
          const pageRange=span?.pageRange as {start?:unknown;end?:unknown}|undefined;
          const materialRange=span?.materialRange as {start?:unknown;end?:unknown}|undefined;
          if(!span||typeof span.blockId!=='string'||span.blockId.length>128||typeof span.kind!=='string'||!['text','asset'].includes(span.kind)||!Array.isArray(span.memberIds)||span.memberIds.length>32||span.memberIds.some(id=>typeof id!=='string'||id.length>128)||!pageRange||!materialRange||!Number.isSafeInteger(pageRange.start)||!Number.isSafeInteger(pageRange.end)||Number(pageRange.start)<0||Number(pageRange.end)<Number(pageRange.start)||Number(pageRange.end)>page.text.length||!Number.isSafeInteger(materialRange.start)||!Number.isSafeInteger(materialRange.end)||Number(materialRange.start)<0||Number(materialRange.end)<Number(materialRange.start))throw hostError('Invalid material span');
          const attribution=attributionContextSchema.safeParse(span.attributionContext);
          return {blockId:span.blockId,kind:span.kind,...(attribution.success?{attributionContext:attribution.data}:{}),...(typeof span.format==='string'&&span.format.length<=128?{format:span.format}:{}),pageRange:{start:pageRange.start,end:pageRange.end},materialRange:{start:materialRange.start,end:materialRange.end},memberIds:span.memberIds};
        });
        const refs=[...new Set(page.originalRefs.slice(0,30).map(ref=>{const parsed=parseEvidenceRef(ref);return parsed?.kind==='capture'?parsed.id:undefined;}))];
        if(refs.some(id=>typeof id!=='string'||!id||id.length>300))throw hostError('Invalid material original reference');
        const ids=refs as string[];
        let originals:ContextRecord[]=[];
        if(ids.length){
          originals=await reader.evidence({...scope,ids});
          const valid=new Set(originals.filter(record=>{const at=sourceContentTime(record);return (!scope.deviceId||record.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));}).map(record=>record.id));
          if(ids.some(id=>!valid.has(id)))throw hostError('Material original is missing or outside the selected scope');
        }
        const total=Number.isSafeInteger(page.originalRefsTotal)&&page.originalRefsTotal>=ids.length?page.originalRefsTotal:ids.length;
        const sourceEvidence:ContextRecord[]=[];
        // A locator/ancestry is not proof. Reauthorize each host-mapped span,
        // match its exact current original bytes and preserve original offsets.
        for(const span of (page.sourceSpans??[]).slice(0,30)){
          const fresh=originals.find(record=>record.id===span.record.id);
          if(!fresh||fresh.contentLayer==='L2_model_interpretation'||span.record.contentLayer==='L2_model_interpretation'||!Number.isSafeInteger(span.offset)||span.offset<0||!Number.isSafeInteger(span.length)||span.length<1||span.offset+span.length>fresh.ocrText.length||splitsPair(fresh.ocrText,span.offset)||splitsPair(fresh.ocrText,span.offset+span.length)||fresh.ocrText!==span.record.ocrText)continue;
          sourceEvidence.push(project(fresh,span.offset,span.length,bounds.timeZone));
        }
        if(closing||res.destroyed)return;
        bounds.signal?.throwIfAborted();
        const data={material,text:page.text,textRange:{offset:page.textRange.offset,total:page.textRange.total,nextOffset:page.textRange.nextOffset},spans,originalRefs:ids.map(id=>formatEvidenceRef('capture',id)),originalRefsTotal:total,originalRefsTruncated:page.originalRefsTruncated||total>ids.length||page.originalRefs.length>ids.length,sourceEvidence,sourceCoverage:{references:total,delivered:sourceEvidence.length,partial:total>new Set(sourceEvidence.map(record=>record.id)).size||page.originalRefsTruncated},pagination:{requestedLength:Number(length),returnedLength:page.text.length}};
        const serialized=JSON.stringify(attributionMetadataResponse({source:'untrusted_personal_context',data,toolUsage:toolUsage(),...(sourceProtocolInstructions(sourceEvidence)?{hostSourceSemantics:sourceProtocolInstructions(sourceEvidence)}:{})}));
        deliveredCharacters+=serialized.length;
        rememberSourceContexts(data);
        for(const id of ids){discovered.add(id);disclosedIds.add(id);}
        for(const record of sourceEvidence){remember(record);expanded.add(record.id);}
        rememberDisclosureDependencies(page.disclosureDependencies);
        trace.push({tool,arguments:{ref:args.ref,offset,length},count:1,materialPage:{requestedLength:Number(length),returnedLength:page.text.length}});reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:1});res.end(serialized);return;
      }
      if(tool==='attribution_context'){
        if(Object.keys(args).some(key=>!['id','ref','sourceContextRef','offset','length','expectedFingerprint'].includes(key))||
          [args.id,args.ref,args.sourceContextRef].filter(value=>value!==undefined).length!==1)throw hostError('Choose exactly one discovered original id, pinned Material ref or sourceContextRef');
        const offset=args.offset??0,length=args.length??8000;
        if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>12000)
          throw hostError('Attribution offset must be nonnegative and length must be 1–12000 UTF-16 units');
        if(args.expectedFingerprint!==undefined&&(typeof args.expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(args.expectedFingerprint)))throw hostError('Invalid attribution context fingerprint');
        if(Number(offset)>0&&args.expectedFingerprint===undefined)throw hostError('Copy contextFingerprint as expectedFingerprint when continuing an attribution page');
        const scope=range({},bounds);let context:unknown,dependencies:unknown;
        let locator:{id:string}|{ref:string}|{sourceContextRef:string};
        if(args.id!==undefined){
          if(typeof args.id!=='string'||!discovered.has(args.id))throw hostError('Discover the original before reading its attribution context');
          locator={id:args.id};
          const record=(await reader.evidence({...scope,ids:[args.id]})).find(record=>record.id===args.id);
          if(!record)throw hostError('Original attribution context is unavailable in the current scope');
          const at=sourceContentTime(record);
          if(!Number.isFinite(Date.parse(at))||scope.deviceId&&record.deviceId!==scope.deviceId||scope.after&&Date.parse(at)<Date.parse(scope.after)||scope.before&&Date.parse(at)>=Date.parse(scope.before))throw hostError('Original attribution context is outside the selected scope');
          context=record.attributionContext;
        }else if(args.sourceContextRef!==undefined){
          if(typeof args.sourceContextRef!=='string'||!discoveredSourceContexts.has(args.sourceContextRef)||!reader.sourceContext)throw hostError('Discover the source context before reading its statement');
          locator={sourceContextRef:args.sourceContextRef};
          context=(await reader.sourceContext({...scope,sourceContextRef:args.sourceContextRef})).attributionContext;
        }else{
          if(typeof args.ref!=='string'||!pinnedMaterialRef.test(args.ref)||!pinnedMaterials.has(args.ref))throw hostError('Use an exact pinned Material ref returned in this run');
          if(!reader.materialRead)throw hostError('Material context reading is unavailable');
          locator={ref:args.ref};
          // This host read reuses current privacy/revision checks. Its source
          // bodies and internal grants are never delivered or remembered here.
          const page=await reader.materialRead({...scope,ref:args.ref,offset:0,length:2});
          const material=materialMetadata(page.material,scope);
          if(!material||material.ref!==args.ref)throw hostError('Material attribution context changed or left the selected scope');
          context=page.material.attributionContext;dependencies=page.disclosureDependencies;
        }
        if(closing||res.destroyed)return;bounds.signal?.throwIfAborted();
        const parsed=attributionContextSchema.safeParse(context??{version:1,ownerRelation:'unknown',basis:'default'});
        if(!parsed.success)throw hostError('Invalid host attribution context');
        const text=JSON.stringify(parsed.data),contextFingerprint=createHash('sha256').update(text).digest('hex');
        if(args.expectedFingerprint!==undefined&&args.expectedFingerprint!==contextFingerprint)throw new ContextToolError('attribution_context_changed','The current attribution context changed. Restart at offset 0; do not combine pages from different versions.','correct_arguments');
        const start=Number(offset),requestedLength=Number(length);
        if(start>text.length||splitsPair(text,start))throw hostError('Attribution offset exceeds its context or splits a UTF-16 pair');
        let end=Math.min(text.length,start+requestedLength);if(splitsPair(text,end))end--;
        const serialize=(stop:number)=>JSON.stringify({source:'untrusted_personal_context',data:{...locator,contextFingerprint,offset:start,total:text.length,nextOffset:stop<text.length?stop:null,text:text.slice(start,stop),citationAuthority:false},toolUsage:toolUsage()});
        const serialized=serialize(end);
        if(end===start&&start<text.length)throw hostError('Attribution length must deliver a complete UTF-16 character');
        deliveredCharacters+=serialized.length;
        // Context disclosure participates in deletion/correction lineage only;
        // it never populates records, discovered or expanded original grants.
        rememberSourceContexts({attributionContext:parsed.data});
        if('id' in locator)disclosedIds.add(locator.id);else if('ref' in locator)rememberDisclosureDependencies(dependencies);
        trace.push({tool,arguments:{...locator,offset:start,length:requestedLength,...(args.expectedFingerprint?{expectedFingerprint:args.expectedFingerprint}:{})},count:1,
          attributionPage:{contextFingerprint,offset:start,total:text.length,requestedLength,returnedLength:end-start}});
        reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:1});res.end(serialized);return;
      }
      if(restricted&&tool!=='read_image'){
        if(tool==='context_evidence'){
          if(Object.keys(args).some(key=>!['id','offset','length'].includes(key))||typeof args.id!=='string'||!Number.isSafeInteger(args.offset)||Number(args.offset)<0||!Number.isSafeInteger(args.length??4000)||Number(args.length??4000)<1||Number(args.length??4000)>12000)throw new ContextToolError('invalid_evidence_range','Use an original id from authorizedContextRanges, an absolute UTF-16 offset and length from 1–12000.','correct_arguments');
          const id=args.id,start=Number(args.offset),requestedLength=Number(args.length??4000);
          const grant=readRanges.filter(r=>r.id===id&&start>=r.offset&&start<r.offset+r.length).sort((a,b)=>b.offset+b.length-a.offset-a.length)[0];
          if(!grant)throw new ContextToolError('evidence_range_exceeded','Requested context is outside the host original read grant.','correct_arguments',{evidenceId:id,requestedOffset:start,allowedRanges:readRanges.filter(r=>r.id===id).map(({offset,length})=>({offset,length}))});
          const raw=(await reader.evidence({...range({},bounds),ids:[id]})).find(record=>record.id===id),fresh=raw&&(bounds.skill==='calendar-extraction'?{...raw,ocrText:actionEvidenceText(raw)}:raw);
          if(!fresh||originalPin(fresh)!==originalPins.get(id))throw new ContextToolError('evidence_changed','Source evidence, authorization or its host attribution changed. Stop this run; its original read grant cannot be repaired by changing arguments.','stop');
          const text=fresh.ocrText,grantEnd=grant.offset+grant.length;
          if(splitsPair(text,start))throw new ContextToolError('invalid_evidence_range','Context offset splits a UTF-16 pair. Use the returned continuation offset.','correct_arguments');
          let end=Math.min(grantEnd,start+requestedLength);if(splitsPair(text,end))end--;
          const serialize=(stop:number)=>{const record=project(fresh,start,stop-start,bounds.timeZone);record.textRange={...(record.textRange as object),nextOffset:stop<grantEnd?stop:null};return {record,text:JSON.stringify({source:'untrusted_personal_context',data:[record],readRange:{offset:grant.offset,length:grant.length},toolUsage:toolUsage()})};};
          if(end<=start)throw new ContextToolError('invalid_evidence_range','This page cannot deliver a complete Unicode character; request at least two UTF-16 units.','correct_arguments');
          const page=serialize(end);
          remember(page.record);discovered.add(id);disclosedIds.add(id);expanded.add(id);rememberSourceContexts(page.record);
          deliveredRanges.push({id,offset:start,length:end-start});deliveredCharacters+=page.text.length;
          trace.push({tool,arguments:{id,offset:start,length:requestedLength,returnedLength:end-start},count:1});
          reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:1});res.end(page.text);return;
        }
        if(tool!=='evidence')throw hostError('This extraction session uses only the supplied evidence ranges');
        if(!Array.isArray(args.ids)||!args.ids.length||args.ids.some(id=>typeof id!=='string'||!bounds.evidenceIds!.includes(id)))throw new ContextToolError('evidence_scope_denied','Use only record.id values supplied by the host for this batch, never fingerprints or content hashes. Copy IDs from allowedRanges; omit offset and length to read the supplied segments.','correct_arguments',{allowedRanges:ranges.map(({id,offset,length})=>({id,offset,length}))});
        const current=await reader.evidence({...range({},bounds),ids:args.ids as string[]});
        if((args.ids as string[]).some(id=>{const raw=current.find(r=>r.id===id),after=raw&&(bounds.skill==='calendar-extraction'?{...raw,ocrText:actionEvidenceText(raw)}:raw);return !after||originalPin(after)!==originalPins.get(id);}))throw new ContextToolError('evidence_changed','Source evidence, authorization or its host attribution changed. Stop this run; its original grant cannot be repaired by changing arguments.','stop');
        let data=seedEvidence.filter(record=>(args.ids as string[]).includes(record.id));
        if(args.offset!==undefined||args.length!==undefined){
          const offset=args.offset??0,length=args.length??2000;
          if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>10000000||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>12000)throw new ContextToolError('invalid_evidence_range','offset must be a nonnegative integer and length must be 1–12000 UTF-16 units. Prefer omitting both to read the supplied ranges.','correct_arguments');
          data=(args.ids as string[]).map(id=>{
            const record=permitted.get(id)!;
            if(!ranges.some(r=>r.id===id&&Number(offset)>=r.offset&&Number(offset)+Number(length)<=r.offset+r.length)||splitsPair(record.ocrText,Number(offset))||splitsPair(record.ocrText,Number(offset)+Number(length)))throw new ContextToolError('evidence_range_exceeded','Requested range is outside this extraction batch. Omit offset and length to read each supplied segment, or select one permitted absolute UTF-16 range.','correct_arguments',{evidenceId:id,requestedOffset:offset,requestedLength:length,allowedRanges:ranges.filter(r=>r.id===id).map(({offset,length})=>({offset,length}))});
            return project(record,Number(offset),Number(length),bounds.timeZone);
          });
        }
        const serialized=JSON.stringify({source:'untrusted_personal_context',data,toolUsage:toolUsage()});
        deliveredCharacters+=serialized.length;
        trace.push({tool,arguments:{ids:args.ids,ranges:ranges.filter(r=>(args.ids as string[]).includes(r.id))},count:data.length});
        reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:data.length});
        res.end(serialized);return;
      }
      if(tool==='read_image'){
        const parsed=imageReadSchema.safeParse(args);
        if(!parsed.success)throw new ContextToolError('invalid_image_region','Use the declared image arguments. Regions require expectedImageSha256, integer original coordinates and sides of 1–2048.','correct_arguments',{maxRegionSide:IMAGE_REGION_MAX_SIDE});
        const selection=parsed.data;
        const imageGrant=processingImages.find(grant=>grant.id===selection.id);
        if((restricted||processingImages.length>0)&&(!imageGrant||selection.attachmentId!==undefined||selection.expectedImageSha256!==undefined&&selection.expectedImageSha256!==imageGrant.originalSha256))throw new ContextToolError('evidence_scope_denied','Use only an exact original-image id and hash listed in authorizedImages. This grant does not permit other captures or attachments.','correct_arguments');
        if(typeof args.id!=='string'||!expanded.has(args.id)&&!imageGrant||!reader.readImage)throw hostError('Expand derived evidence before reading an authorized image');
        for(;;){
          if(closing||res.destroyed)return;
          const direct=directImages.some(image=>image.id===args.id);
          const record=direct?directImageRecords.get(args.id):(await reader.evidence({ids:[args.id]}))[0],scope=range({},bounds);
          const document=documentSchema.safeParse((record?.provenance as {document?:unknown}|undefined)?.document),at=record&&sourceContentTime({capturedAt:record.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});
          if(!record||!direct&&(scope.deviceId&&record.deviceId!==scope.deviceId||scope.after&&Date.parse(at!)<Date.parse(scope.after)||scope.before&&Date.parse(at!)>=Date.parse(scope.before)))throw hostError('Image is outside scope or deleted');
          if(args.attachmentId!==undefined&&(direct||typeof args.attachmentId!=='string'||!document.success||!document.data.attachments?.some(attachment=>attachment.id===args.attachmentId)))throw hostError('Select an image attachment declared by the expanded parent evidence');
          const image=await reader.readImage(selection);
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
          const publicView:ImageViewTrace|undefined=imageView?{...imageView,id:selection.id,...(selection.attachmentId?{attachmentId:selection.attachmentId}:{}),delivery:metadata?'metadata' as const:'pending' as const}:undefined;
          const imageBudget=()=>({remainingPayloads:Math.max(0,4-disclosedImages.size),maxRegionSide:IMAGE_REGION_MAX_SIDE,maxOutputBytes:IMAGE_MAX_BYTES});
          const sendImageResult=(result:Record<string,unknown>,entry:ToolTrace)=>{
            const {image:payload,imageDelivery:receipt,...text}=result;
            const characters=JSON.stringify(text).length;
            deliveredCharacters+=characters;trace.push(entry);reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:1});res.end(JSON.stringify(result));
          };
          if(metadata){
            if(image.data!==undefined||imageView?.output)throw hostError('Metadata must not include image bytes');
            sendImageResult({source:'untrusted_personal_context',...selection,imageView:publicView,imageBudget:imageBudget(),toolUsage:toolUsage()},{tool,arguments:selection,count:1,imageView:publicView});
            // Metadata alone cannot claim empty complete disclosure. A later
            // confirmed pixel read supplies this original's actual lineage.
            metadataImageIds.add(selection.id);return;
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
          }
          if(firstSelection&&publicView)publicView.delivery='already_disclosed';
          sendImageResult({source:'untrusted_personal_context',...selection,...(publicView?{imageView:publicView}:{}),...(firstSelection?{
            imageDisclosure:{status:'already_disclosed',sha256,mimeType:image.mimeType,firstSelection,...(existing?.imageView?{firstImageView:existing.imageView}:{})},
            message:'These exact image bytes were already supplied in this query. Use the earlier image with this selection’s own source attribution.',
          }:{image:{mimeType:image.mimeType,data:image.data},imageDelivery:delivery!.token}),imageBudget:imageBudget(),toolUsage:toolUsage()},{tool,arguments:selection,count:1,...(publicView?{imageView:publicView}:{})});
          if(existing?.confirmed){if(!records.has(selection.id))remember(project({...record,ocrText:''},0,0,bounds.timeZone));disclosedIds.add(selection.id);}
          return;
        }
      }
      let value: unknown;
      let effective: Record<string, unknown> = args;
      let textOffset = 0, textLength = 600;
      let retrieval:unknown;
      const discoveredMemoryIds:string[]=[];
      const derivedIds:string[]=[];
      let memoryEvidence:ContextRecord[]=[];
      let pagination: { nextCursor: string | null; totalCount?: number } | undefined;
      if (tool === "devices") {
        value = await reader.devices();
        let observedAt:string|undefined;
        if(value&&typeof value==='object'&&!Array.isArray(value)){
          const page=value as Record<string,unknown>;
          if(!Array.isArray(page.items))throw hostError('Device reader returned invalid metadata');
          disclosureDependencies=page.disclosureDependencies;disclosureSourceContextDependencies=page.sourceContextDependencies;
          if(typeof page.observedAt==='string'&&Number.isFinite(Date.parse(page.observedAt)))observedAt=page.observedAt;else completeLineage=false;
          value=page.items;
        }
        if (bounds.deviceId && Array.isArray(value)) value = value.filter(device => device.deviceId === bounds.deviceId);
        if (Array.isArray(value)) value = value.map(device => ({...projectDevice(device,bounds.timeZone),...(observedAt?{directoryObservedAt:observedAt,displayDirectoryObservedAt:displayTime(observedAt,bounds.timeZone)}:{})}));
      }
      else if(tool==='read_file_evidence'){
        if(typeof args.id!=='string'||!records.has(args.id))throw hostError('Discover the file before requesting evidence');
        const offset=args.offset??0,length=args.length??8000;if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>10000000||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>16000)throw hostError('Invalid text range');
        const result=await reader.readFileEvidence?.({...range({},bounds),id:args.id,offset:Number(offset),length:Number(length)})??{status:'unavailable'};
        const record=result.record?project(result.record,0,Number(length),bounds.timeZone):undefined;
        value={...result,record};if(record)memoryEvidence.push(record);
      }
      else if(tool==='file_chunks'){
        if(typeof args.id!=='string'||!records.has(args.id))throw hostError('Discover the file before reading its chunks');
        const offset=args.offset??0;if(!Number.isSafeInteger(offset)||Number(offset)<0)throw hostError('Invalid chunk offset');
        const scope=range({},bounds);effective={...scope,id:args.id,offset,limit:30};
        value=await reader.fileChunks?.({...scope,id:args.id,offset:Number(offset)})??[];
        if(Array.isArray(value))value=value.filter(r=>{const document=documentSchema.safeParse(r.provenance?.document),at=sourceContentTime({capturedAt:r.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});return (!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));});
        pagination={nextCursor:Array.isArray(value)&&value.length===30?String(Number(offset)+30):null};
      }
      else if(tool==='context_index'){const scope=range(args,bounds);if(args.path!==undefined&&(typeof args.path!=='string'||args.path.length>100)||args.query!==undefined&&(typeof args.query!=='string'||args.query.length>500))throw hostError('Invalid context index arguments');value=await reader.catalog?.({...scope,path:args.path as string|undefined,query:args.query as string|undefined})??{entries:[],coverage:'unavailable'};metadataOnly=true;}
      else if(tool==='source_history'){
        if(typeof args.id!=='string'||!records.has(args.id))throw hostError('Discover a source record before requesting history');
        const scope=range({},bounds);effective={...scope,id:args.id};value=await reader.sourceHistory?.({...scope,id:args.id})??[];
      }
      else if(tool==='sources'){if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>500))throw hostError('Invalid source query');effective={...range(args,bounds),query:args.query};value=await reader.sources?.(effective as ContextRange&{query?:string})??{items:[],nextCursor:null};metadataOnly=true;}
      else if(tool==='segments'){
        const scope=range(args,bounds);
        if(args.id!==undefined&&(typeof args.id!=='string'||args.id.length>1600))throw hostError('Invalid segment id');
        if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>500))throw hostError('Invalid segment query');
        effective={...scope,id:args.id,query:args.query};
        const page=await reader.segments?.({...scope,id:args.id as string|undefined,query:args.query as string|undefined})??{items:[],nextCursor:null};
        // IDs become discoverable, never citable until original text is delivered.
        const items=page.items.filter(item=>(!scope.deviceId||item.deviceId===scope.deviceId)&&(!scope.after||typeof item.firstAt==='string'&&Date.parse(item.firstAt)>=Date.parse(scope.after))&&(!scope.before||typeof item.lastAt==='string'&&Date.parse(item.lastAt)<Date.parse(scope.before)));
        discoveredMemoryIds.push(...items.flatMap(item=>[...item.members,...((item.metadata as {citations?:string[]}|undefined)?.citations??[])]));
        derivedIds.push(...items.flatMap(item=>typeof item.id==='string'?[item.id]:[]));
        value={...page,items};pagination={nextCursor:page.nextCursor};
      }
      else if(tool==='memories'){
        const scope=range(args,bounds);
        if(args.id!==undefined&&(typeof args.id!=='string'||args.id.length>128))throw hostError('Invalid memory id');
        if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>500))throw hostError('Invalid memory query');
        if(args.tier!==undefined&&!['episode','consolidated'].includes(String(args.tier)))throw hostError('Invalid memory tier');
        if(args.kind!==undefined&&!['episodic','semantic','procedural'].includes(String(args.kind)))throw hostError('Invalid memory kind');
        if(args.layer!==undefined&&!['observation','memory'].includes(String(args.layer)))throw hostError('Invalid memory layer');
        if(args.includeHistory!==undefined&&typeof args.includeHistory!=='boolean')throw hostError('Invalid memory history flag');
        if(args.includeEvidence!==undefined&&typeof args.includeEvidence!=='boolean')throw hostError('Invalid memory evidence flag');
        if(args.includeEvidence===true&&!args.id)throw hostError('Select a memory id before requesting its original evidence');
        if(args.asOf!==undefined&&(typeof args.asOf!=='string'||!Number.isFinite(Date.parse(args.asOf))))throw hostError('Invalid memory validity time');
        const search={includeHistory:args.id?true:args.includeHistory as boolean|undefined,asOf:args.asOf as string|undefined,layer:args.id?undefined:(args.layer??'memory') as 'observation'|'memory',query:args.query as string|undefined,tier:args.tier as 'episode'|'consolidated'|undefined,kind:args.kind as 'episodic'|'semantic'|'procedural'|undefined};
        effective={...scope,id:args.id,...search,includeEvidence:args.includeEvidence};
        const result=await reader.memories?.({...scope,id:args.id as string|undefined,...search,includeEvidence:args.includeEvidence as boolean|undefined})??{items:[]};
        derivedIds.push(...result.items.flatMap(item=>typeof (item as {id?:unknown}).id==='string'?[(item as {id:string}).id]:[]));
        const evidence=(result.evidence??[]).filter(r=>{const d=documentSchema.safeParse((r.provenance as Record<string,unknown>|undefined)?.document);const at=sourceContentTime({capturedAt:r.capturedAt,...(d.success?{provenance:{document:d.data}}:{})});return (!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));}).slice(0,30).map(r=>({id:r.id,capturedAt:r.capturedAt,appName:r.appName,characters:r.ocrText.length}));
        discoveredMemoryIds.push(...evidence.map(r=>r.id),...(result.references??[]).map(r=>r.id));
        const references=result.references??[];
        if(args.includeEvidence===true&&result.items.length){
          // Only host-verified, requested, in-scope original ranges become citable.
          const allowedIds=new Set(references.map(ref=>ref.id));
          for(const span of (result.sourceSpans??[]).slice(0,3)){
            const r=span.record,at=sourceContentTime(r);
            if(!allowedIds.has(r.id)||!Number.isFinite(Date.parse(at))||!Number.isSafeInteger(span.offset)||span.offset<0||!Number.isSafeInteger(span.length)||span.length<1||span.offset>=r.ocrText.length||
              scope.deviceId&&r.deviceId!==scope.deviceId||scope.after&&Date.parse(at)<Date.parse(scope.after)||scope.before&&Date.parse(at)>=Date.parse(scope.before))continue;
            memoryEvidence.push(project(r,span.offset,Math.min(span.length,2000),bounds.timeZone));
          }
        }
        // Saved quotes locate a claim but are not a fresh permission/version check.
        const items=result.items.map(item=>{
          if(!item||typeof item!=='object'||!Array.isArray((item as {evidence?:unknown}).evidence))return item;
          return {...item,evidence:(item as {evidence:Record<string,unknown>[]}).evidence.map(({quote,...ref})=>ref)};
        });
        const partial=result.sourceCoverage?.partial===true||memoryEvidence.length<references.length||(result.sourceSpans??[]).length>memoryEvidence.length||(result.sourceSpans??[]).some(span=>span.length>2000);
        value={items,evidence:[...evidence,...references],...(args.includeEvidence===true?{sourceEvidence:memoryEvidence,sourceCoverage:{references:result.sourceCoverage?.references??references.length,delivered:memoryEvidence.length,partial}}:{}),coverage:{layer:'derived_memories',scope:'selected_summaries_only',originalSearchTool:'search_context'}};pagination={nextCursor:result.nextCursor??null};
      }
      else if (tool === "evidence") {
        if (
          !Array.isArray(args.ids) ||
          args.ids.length < 1 ||
          args.ids.length > 30 ||
          args.ids.some((id) => typeof id !== "string" || id.length > 300)
        )
          throw hostError("ids must contain 1–30 record identifiers");
        // Evidence expansion only reads records discovered in this run, inside its scope.
        const ids = args.ids as string[];
        if (ids.some((id) => !discovered.has(id)))
          throw hostError(
            "Discover records with search_context or timeline before expanding evidence",
          );
        if(args.layer!==undefined&&!['ocr','semantic'].includes(String(args.layer)))throw hostError('Invalid derived layer');
        const scope=range({},bounds);
        for (const [key, fallback, min, max] of [["offset", 0, 0, 100000], ["length", 12000, 1, 12000]] as const) {
          const n = args[key] ?? fallback;
          if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw hostError(`${key} must be an integer from ${min} to ${max}`);
          if (key === "offset") textOffset = n; else textLength = n;
        }
        value = (await reader.evidence({ ids })).filter(r=>{
          const at=sourceContentTime(r);return ids.includes(r.id)&&(!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));
        }).map(r=>args.layer==='semantic'?{...r,ocrText:String(r.summary??''),contentLayer:'L2_model_interpretation'}:{...r,...(r.sourceType==='screen'?{contentLayer:'L1_machine_extraction'}:{})});
        effective = { ids, ...(args.layer?{layer:args.layer}:{}), ...(args.offset === undefined ? {} : { offset:textOffset }), ...(args.length === undefined ? {} : { length:textLength }) };
      } else {
        const filters = range(args, bounds);
        effective = { ...filters };
        if(tool==='changes'){
        const ids=bounds.incrementalEvidenceIds??[],offset=args.cursor===undefined?0:Number(args.cursor),limit=Math.min(Number(args.limit??30),30);
        if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw hostError('Invalid changes page');
        const scope=range({},bounds);effective={...filters,limit};
        const selectedIds=new Set(ids.slice(offset,offset+limit));
        value=(await reader.evidence({ids:[...selectedIds]})).filter(r=>{const at=sourceContentTime(r);return selectedIds.has(r.id)&&(!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));});
        if(args.view!==undefined&&!['overview','text'].includes(String(args.view)))throw new ContextToolError('invalid_changes_view','view must be overview or text.','correct_arguments');
        metadataOnly=args.view==='overview'||(args.view===undefined&&bounds.skill==='personal-insight');
        if(metadataOnly){discoveredMemoryIds.push(...(value as ContextRecord[]).map(r=>r.id));value=(value as ContextRecord[]).map(r=>({id:r.id,capturedAt:r.capturedAt,contentAt:sourceContentTime(r),appName:r.appName,sourceType:r.sourceType,characters:r.ocrText.length}));}
        pagination={nextCursor:offset+limit<ids.length?String(offset+limit):null,totalCount:ids.length};
      }
      else if (tool === "search_context") {
          if (
            args.query !== undefined &&
            (typeof args.query !== "string" || args.query.length > 2000)
          )
            throw hostError("query must be at most 2000 characters");
          effective = { ...filters, query: args.query };
          value = await reader.search(
            effective as ContextRange & { query?: string },
          );
          retrieval=(value as {retrieval?:unknown})?.retrieval;
        } else if (tool === "timeline"||tool==='source_items') {
          if(tool==='source_items')for(const field of ['sourceId','kind'])if(args[field]!==undefined&&(typeof args[field]!=='string'||String(args[field]).length>128))throw hostError('Invalid source filter');
          if(tool==='source_items'&&args.includeDeleted!==undefined&&typeof args.includeDeleted!=='boolean')throw hostError('includeDeleted must be boolean');
          if(tool==='source_items')effective={...filters,sourceId:args.sourceId,kind:args.kind,includeDeleted:args.includeDeleted};
          const page = tool==='timeline'?await reader.timeline(filters):await reader.sourceItems?.({...filters,sourceId:args.sourceId as string|undefined,kind:args.kind as string|undefined,includeDeleted:args.includeDeleted as boolean|undefined})??{items:[],nextCursor:null};
          {
            if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw hostError("Context reader returned an invalid page");
            if (page.totalCount !== undefined && (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.totalCount < page.items.length)) throw hostError("Context reader returned an invalid total count");
            value = page.items; pagination = { nextCursor:page.nextCursor, ...(page.totalCount === undefined ? {} : { totalCount:page.totalCount }) };
          }
        }
        else if (tool === 'media_activity') {
          if (args.source !== undefined && args.source !== 'media') throw hostError('media_activity requires the media source');
          if (args.appVisibility !== undefined && (typeof args.appVisibility !== 'string' || !['foreground','background','unknown'].includes(args.appVisibility))) throw hostError('Invalid appVisibility');
          if (args.playbackType !== undefined && (typeof args.playbackType !== 'string' || !['local','remote','unknown'].includes(args.playbackType))) throw hostError('Invalid playbackType');
          if (args.screenLocked !== undefined && typeof args.screenLocked !== 'boolean') throw hostError('screenLocked must be boolean');
          if (!reader.mediaActivity) throw hostError('Media activity is unavailable from this archive reader');
          effective = {...filters, source:'media',
            ...(args.appVisibility === undefined ? {} : {appVisibility:args.appVisibility}),
            ...(args.screenLocked === undefined ? {} : {screenLocked:args.screenLocked}),
            ...(args.playbackType === undefined ? {} : {playbackType:args.playbackType})};
          value = await reader.mediaActivity(effective as MediaContextRange);
        }
        else value = await reader.activity(filters);
      }
      if (!metadataOnly && (
        tool === "search_context" ||
        tool === "timeline" ||
        tool === "evidence" || tool==='source_items' || tool==='source_history' || tool==='file_chunks' || tool==='changes'
      )) {
        if (!Array.isArray(value))
          throw hostError("Context reader returned invalid records");
        value = (value as ContextRecord[])
          .slice(0, tool === "evidence" ? 30 : Number(effective.limit ?? 100))
          .map(record => {
            let offset=textOffset;
            if(tool==='search_context'&&typeof args.query==='string'){
              // Literal lexical localization only: no task/topic/intent classification.
              const terms=args.query.match(/[\p{L}\p{N}_-]+/gu)??[];
              const positions=terms.map(term=>record.ocrText.search(new RegExp(term,'iu'))).filter(n=>n>=0);
              if(positions.length)offset=Math.max(0,Math.min(...positions)-120);
            }
            return project(record,offset,textLength,bounds.timeZone);
          });
      }
      if(['sources','context_index','activity','media_activity'].includes(tool)&&value&&typeof value==='object'&&!Array.isArray(value)){
        const {disclosureDependencies:receipt,sourceContextDependencies:pins,...data}=value as Record<string,unknown>;disclosureDependencies=receipt;disclosureSourceContextDependencies=pins;value=data;
      }
      const safeValue = JSON.parse(JSON.stringify(value ?? null));
      const serialized = JSON.stringify(attributionMetadataResponse({
        source: "untrusted_personal_context",
        data: safeValue,
        toolUsage:toolUsage(),
        ...(sourceProtocolInstructions([...(Array.isArray(value)?value:[]) as ContextRecord[],...memoryEvidence])?{hostSourceSemantics:sourceProtocolInstructions([...(Array.isArray(value)?value:[]) as ContextRecord[],...memoryEvidence])}:{}),
        ...(retrieval?{retrieval}:{}),
        ...(pagination ? { pagination } : {}),
      }));
      deliveredCharacters+=serialized.length;
      rememberSourceContexts(safeValue);
      for(const id of [...discoveredMemoryIds,...derivedIds])disclosedIds.add(id);
      // Private host receipts fence metadata without granting original reads.
      // Aggregate tools without contributor receipts remain conservative.
      if(['sources','context_index','devices','activity','media_activity'].includes(tool)){
        rememberDisclosureDependencies(disclosureDependencies);
        if(disclosureSourceContextDependencies!==undefined){
          const pins=sourceContextDeclarationSchema.array().safeParse(disclosureSourceContextDependencies);
          if(pins.success)for(const pin of pins.data)rememberSourcePin(pin);else completeLineage=false;
        }
      }
      // Changes overviews are projected from the exact current originals above;
      // their contributor IDs are complete even when their bodies remain unread.
      else if(metadataOnly&&tool!=='changes')completeLineage=false;
      for(const id of discoveredMemoryIds)discovered.add(id);
      // Only a successfully serialized, deliverable tool result authorizes evidence.
      if (!metadataOnly&&(tool === "search_context" || tool === "timeline" || tool === "evidence" || tool==='source_items' || tool==='source_history' || tool==='file_chunks' || tool==='changes')) {
        for (const [index,record] of (safeValue as ContextRecord[]).entries())
          {copyEvidencePresentation((value as ContextRecord[])[index],record);remember(record);discovered.add(record.id);disclosedIds.add(record.id);}
        if(tool==='evidence')for(const record of safeValue as ContextRecord[])expanded.add(record.id);
      }
      for(const record of memoryEvidence){remember(record);discovered.add(record.id);disclosedIds.add(record.id);if(tool==='memories')expanded.add(record.id);}
      trace.push({
        tool,
        arguments: effective,
        count: Array.isArray(safeValue)
          ? safeValue.length
          : safeValue == null
            ? 0
            : 1,
      });
      reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:trace.at(-1)!.count});
      res.end(serialized);
      if(tool==='memories'&&safeValue&&typeof safeValue==='object'){
        const delivered=(safeValue as {items?:{id?:unknown;statement?:unknown;version?:unknown;fingerprint?:unknown}[]}).items??[];
        const cards=delivered.flatMap(item=>typeof item.id==='string'&&typeof item.statement==='string'&&item.statement.length>0&&typeof item.fingerprint==='string'?
          [{id:item.id,fingerprint:item.fingerprint,...(typeof item.version==='number'?{version:item.version}:{})}]:[]);
        if(cards.length)try{bounds.onMemoryBodies?.(cards);}catch(error){rejectFailure(error instanceof Error?error:new Error('Memory delivery receipt could not be recorded'));}
      }
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
  const prepareNow=async(tool:string,args:Record<string,unknown>,signal:AbortSignal,release:()=>void):Promise<PreparedToolDelivery>=>{
    if(closing)throw new ContextToolError('bridge_closing','The tool session is closing','stop');
    signal.throwIfAborted();bounds.assertContextAuthority?.();
    const before=captureState(),deferred=beginCallbacks(),deliveredCallbacks:(()=>void)[]=[];
    stagingBase=before;
    const clearStagedImages=(base:StagedState,staged:StagedState)=>{
      for(const [key,value] of staged.disclosedImages){
        if(base.disclosedImages.has(key))continue;
        clearTimeout(value.timer);
        if(value.imageView)value.imageView.delivery='failed';
        value.settle();
      }
    };
    const restoreBefore=()=>{
      // An HTTP image ACK may arrive while this read is staged. Its live
      // reservation is authoritative even though the staged map is not.
      for(const [key,live] of disclosedImages){
        const base=before.disclosedImages.get(key);
        if(base&&live.confirmed){
          base.confirmed=true;base.imageView=live.imageView;base.timer=live.timer;base.ready=live.ready;base.settle=live.settle;
        }
      }
      applyState(before);
    };
    let status=200,body:string|undefined;
    try{
      const reply={destroyed:false,writeHead(code:number){status=code;return reply;},end(value:string,delivered?:()=>void){body=value;if(delivered)deliveredCallbacks.push(delivered);},once(){},off(){}};
      await handle({tool,readArguments:async()=>args},reply);
    }catch(error){const failed=captureState();clearStagedImages(before,failed);restoreBefore();stagingBase=undefined;endCallbacks(deferred);release();throw error;}
    endCallbacks(deferred);
    try{bounds.assertContextAuthority?.();signal.throwIfAborted();}
    catch(error){const failed=captureState();clearStagedImages(before,failed);restoreBefore();stagingBase=undefined;release();throw error;}
    if(closing||signal.aborted||status>=400||typeof body!=='string'){
      const failed=captureState();clearStagedImages(before,failed);restoreBefore();stagingBase=undefined;
      if(status>=400){
        let issue:Record<string,unknown>|undefined;
        try{issue=(JSON.parse(body??'{}') as {toolError?:Record<string,unknown>}).toolError;}catch{/* Non-JSON failure remains a tool failure. */}
        release();
        const recovery=issue?.recovery==='correct_arguments'||issue?.recovery==='use_existing_evidence'||issue?.recovery==='stop'?issue.recovery:'stop';
        throw new ContextToolError(typeof issue?.code==='string'?issue.code:'context_tool_failed',typeof issue?.message==='string'?issue.message:'The tool could not complete.',recovery,issue?.details&&typeof issue.details==='object'?issue.details as Record<string,unknown>:{});
      }
      release();
      if(closing)throw new ContextToolError('bridge_closing','The tool session closed before delivery','stop');
      if(signal.aborted)throw new ContextToolError('tool_cancelled','The tool call was cancelled before delivery','stop');
      throw new ContextToolError('context_tool_failed','The tool produced no deliverable response','stop');
    }
    let value:unknown;
    try{value=JSON.parse(body);}catch{const failed=captureState();clearStagedImages(before,failed);restoreBefore();stagingBase=undefined;release();throw new ContextToolError('context_tool_failed','The tool produced an invalid response','stop');}
    const after=captureState();
    let settled=false;
    const delivery:PreparedToolDelivery={
      value,
      confirm(){
        if(settled)return;settled=true;activeStaged.delete(delivery);
        try{
          if(closing)throw new ContextToolError('bridge_closing','The tool session closed before confirmation','stop');
          signal.throwIfAborted();bounds.assertContextAuthority?.();
          stagingBase=undefined;
          const token=(value&&typeof value==='object'&&typeof (value as {imageDelivery?:unknown}).imageDelivery==='string')?(value as {imageDelivery:string}).imageDelivery:undefined;
          if(token)imageDelivery(token,true);
          flushCallbacks(deferred);
          for(const callback of deliveredCallbacks)callback();
        }catch(error){clearStagedImages(before,after);restoreBefore();stagingBase=undefined;throw error;}finally{release();}
      },
      discard(){
        if(settled)return;settled=true;activeStaged.delete(delivery);clearStagedImages(before,after);restoreBefore();stagingBase=undefined;release();
      },
    };
    activeStaged.add(delivery);
    return delivery;
  };
  const prepareDelivery:PrepareToolDelivery=(tool,args,signal)=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve);
    const previous=prepareLock;prepareLock=gate;
    return previous.then(()=>prepareNow(tool,args,signal,release)).catch(error=>{release();throw error;});
  };
  const session = {
    imageDelivery,
    prepareDelivery,
    failure,
    get trace(){return stagingBase?.trace??trace;},
    records:publicRecords,
    seedEvidence,
    /** A catalog range is never included here until its text was delivered. */
    get deliveredRanges(){
      const source=stagingBase?.deliveredRanges??deliveredRanges;
      const merged:{id:string;offset:number;length:number}[]=[];
      for(const range of [...source].sort((a,b)=>a.id.localeCompare(b.id)||a.offset-b.offset||a.length-b.length)){
        const prior=merged.at(-1);if(prior&&prior.id===range.id&&range.offset<=prior.offset+prior.length)prior.length=Math.max(prior.offset+prior.length,range.offset+range.length)-prior.offset;
        else merged.push({...range});
      }
      return merged;
    },
    get sourceContextDependencies(){return [...(stagingBase?.sourceContextDependencies??sourceContextDependencies).values()];},
    get imageReadReceipts(){return [...(stagingBase?.imageReadReceipts??imageReadReceipts).values()].map(value=>structuredClone(value));},
    get evidenceDependencies(){
      const disclosed=stagingBase?.disclosedIds??disclosedIds;
      const complete=stagingBase?.completeLineage??completeLineage;
      const metadata=stagingBase?.metadataImageIds??metadataImageIds;
      return {version:1 as const,complete:complete&&[...metadata].every(id=>disclosed.has(id)),ids:[...disclosed]};
    },
    get deliveredCharacters(){return stagingBase?.deliveredCharacters??deliveredCharacters;},
    get ready() {
      return ready;
    },
  };
  const close=()=>{
    closing=true;
    for(const delivery of [...activeStaged])delivery.discard();
    try{bounds.onEvidence?.(evidenceLayers(records));}catch{/* Host observation cannot grant reads or change the result. */}
    for(const value of disclosedImages.values()){clearTimeout(value.timer);if(!value.confirmed&&value.imageView)value.imageView.delivery='failed';value.settle();}
    disclosedImages.clear();
  };
  return {handle,session,close};
}
