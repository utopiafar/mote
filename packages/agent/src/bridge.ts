import {actionEvidenceText} from '@mote/shared';
import {reportProgress} from './types.js';
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { displayTime } from './time.js';
import {stateSeriesSchema,fileEvidenceSchema,recordMetadataSchema, sourceMetadataSchema, sourceSchema,documentSchema,sourceContentTime} from '@mote/shared';
import type {
  ContextReader,
  ContextRecord,
  ContextRange,
  MediaContextRange,
  QueryInput,
  ToolTrace,
} from "./types.js";

export const TOOL_NAMES = [
  "progress_update",
  "search_context",
  "timeline",
  "evidence",
  "activity",
  "media_activity",
  "devices",
  "sources",
  "source_items",
  "source_history",
  "memories",
  "read_file_evidence",
  "file_chunks",
  "changes",
] as const;

function dateValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error(`${field} must be an ISO timestamp`);
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
    throw new Error("Time range is outside the requested scope");
  if (args.deviceId !== undefined && typeof args.deviceId !== "string")
    throw new Error("deviceId must be a string");
  if (bounds.deviceId && args.deviceId !== undefined && args.deviceId !== bounds.deviceId)
    throw new Error("Device is outside the requested scope");
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) || Number(args.limit) < 1)
  )
    throw new Error("limit must be a positive integer");
  if (args.cursor !== undefined && (typeof args.cursor !== "string" || !args.cursor || args.cursor.length > 4096))
    throw new Error("cursor must be a pagination token returned by timeline");
  if (args.source !== undefined && !sourceSchema.safeParse(args.source).success) throw new Error('Invalid source');
  if (args.appId !== undefined && (typeof args.appId !== 'string' || !args.appId.trim() || args.appId.length > 300)) throw new Error('Invalid appId');
  if (args.collection !== undefined && args.collection !== 'content' && args.collection !== 'activity') throw new Error('Invalid collection');
  return {
    after: effectiveAfter,
    before: effectiveBefore,
    deviceId: bounds.deviceId ?? args.deviceId as string | undefined,
    limit: Math.min(Number(args.limit ?? 30), 100),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
    ...(args.source === undefined ? {} : {source: sourceSchema.parse(args.source)}),
    ...(args.appId === undefined ? {} : {appId: args.appId as string}),
    ...(args.collection === undefined ? {} : {collection: args.collection as 'content' | 'activity'}),
  };
}

/** Deliberately projects public evidence fields; no file paths, tokens, or images reach the model. */
function project(record: ContextRecord, offset = 0, length = 2000, timeZone = 'UTC'): ContextRecord {
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
  const contentAt = sourceContentTime({capturedAt:record.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});
  return {
    ...(fileEvidenceSchema.safeParse(record.fileEvidence).success?{fileEvidence:fileEvidenceSchema.parse(record.fileEvidence)}:{}),
    ...(stateSeriesSchema.safeParse(record.stateSeries).success?{stateSeries:stateSeriesSchema.parse(record.stateSeries)}:{}),
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
      : { summary: String(record.summary).slice(0, 4000) }),
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
}

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

export async function startBridge(
  reader: ContextReader,
  bounds: QueryInput,
  maxToolCalls: number,
) {
  const token = randomBytes(32).toString("hex");
  const trace: ToolTrace[] = [];
  const records = new Map<string, ContextRecord>();
  const restricted = bounds.evidenceIds !== undefined;
  const permitted = new Map<string,ContextRecord>();
  const ranges = bounds.evidenceRanges ?? bounds.evidenceIds?.map(id=>({id,offset:0,length:12000})) ?? [];
  const splitsPair=(text:string,at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);
  if(bounds.evidenceRanges&&!restricted)throw Error('Evidence ranges require explicit evidence IDs');
  if(restricted){
    if(!bounds.evidenceIds?.length||bounds.evidenceIds.length>100||ranges.length>100||ranges.some(r=>!bounds.evidenceIds!.includes(r.id)||!Number.isSafeInteger(r.offset)||r.offset<0||!Number.isSafeInteger(r.length)||r.length<1||r.length>100000)||ranges.reduce((n,r)=>n+r.length,0)>100000)throw Error('Invalid extraction evidence scope');
    for(const record of await reader.evidence({ids:bounds.evidenceIds}))if(bounds.evidenceIds.includes(record.id))permitted.set(record.id,bounds.skill==='calendar-extraction'?{...record,ocrText:actionEvidenceText(record)}:record);
    const scope=range({},bounds);
    for(const id of bounds.evidenceIds){
      const record=permitted.get(id);
      if(!record)throw Error('Extraction evidence is missing');
      const document=documentSchema.safeParse((record.provenance as Record<string,unknown>|undefined)?.document);
      const at=sourceContentTime({capturedAt:record.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});
      if((scope.deviceId&&record.deviceId!==scope.deviceId)||(scope.after&&Date.parse(at)<Date.parse(scope.after))||(scope.before&&Date.parse(at)>=Date.parse(scope.before)))throw Error('Extraction evidence is outside the selected scope');
      if(!ranges.some(r=>r.id===id))throw Error('Every extraction evidence ID requires a delivered range');
    }
    for(const r of ranges){const text=permitted.get(r.id)!.ocrText;
      if(bounds.evidenceRanges&&(r.offset+r.length>text.length||splitsPair(text,r.offset)||splitsPair(text,r.offset+r.length)))throw Error('Extraction range must stay inside original text and UTF-16 boundaries');
    }
  }
  const seedEvidence=ranges.flatMap(r=>{const record=permitted.get(r.id);return record?[project(record,r.offset,r.length,bounds.timeZone)]:[];});
  if(Buffer.byteLength(JSON.stringify(seedEvidence))>1_500_000)throw Error('Extraction evidence exceeds the byte budget');
  for(const record of seedEvidence)records.set(record.id,record);
  let calls = 0;
  let progressMessages=0;
  let ready = false;
  const server: Server = createServer(async (req, res) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    res.setHeader("Content-Type", "application/json");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(401).end('{"error":"Unauthorized"}');
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end('{"error":"Method not allowed"}');
      return;
    }
    try {
      let raw = "";
      for await (const part of req) {
        raw += part.toString();
        if (Buffer.byteLength(raw) > 65_536)
          throw new Error("Request too large");
      }
      const args: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      if (!args || Array.isArray(args) || typeof args !== "object")
        throw new Error("Expected object arguments");
      const tool = req.url?.slice(1) ?? "";
      if (tool === "_ready") {
        const exposed = args.tools;
        if (
          !Array.isArray(exposed) ||
          exposed.length !== TOOL_NAMES.length + 1 ||
          ![...TOOL_NAMES,'skill'].every((name) => exposed.includes(name))
        )
          throw new Error("Unsafe Harness tool composition");
        ready = true;
        res.end('{"ok":true}');
        return;
      }
      if (!TOOL_NAMES.includes(tool as (typeof TOOL_NAMES)[number])) {
        res.writeHead(404).end('{"error":"Unknown tool"}');
        return;
      }
      if(tool==='progress_update'){
        if(typeof args.message!=='string'||!args.message.trim()||args.message.length>600)throw new Error('Progress message must contain 1–600 characters');
        if(++progressMessages>16)throw new Error('Progress message limit reached');
        reportProgress(bounds,{stage:'model',message:args.message.trim()});
        res.end('{"ok":true}');return;
      }
      if (!['timeline','search_context','activity','media_activity'].includes(tool) && ['source','appId','collection'].some(field => args[field] !== undefined))
        throw new Error('App/source/collection filters require a context or activity tool');
      if (tool !== 'media_activity' && ['appVisibility','screenLocked','playbackType'].some(field => args[field] !== undefined))
        throw new Error('Media state filters require media_activity');
      if (++calls > maxToolCalls)
        throw new Error(
          "Tool call budget reached; finish using the evidence already retrieved",
        );
      reportProgress(bounds,{stage:'tool',tool,phase:'started'});
      if(bounds.skill==='working-memory')throw Error('Working memory uses only the supplied dialogue; retrieval is disabled');
      if(restricted){
        if(tool!=='evidence')throw Error('This extraction session uses only the supplied evidence ranges');
        if(!Array.isArray(args.ids)||!args.ids.length||args.ids.some(id=>typeof id!=='string'||!permitted.has(id)))throw Error('Evidence is outside this extraction batch');
        let data=seedEvidence.filter(record=>(args.ids as string[]).includes(record.id));
        if(args.offset!==undefined||args.length!==undefined){
          const offset=args.offset??0,length=args.length??2000;
          if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>10000000||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>12000)throw Error('Invalid extraction evidence range');
          data=(args.ids as string[]).map(id=>{
            const record=permitted.get(id)!;
            if(!ranges.some(r=>r.id===id&&Number(offset)>=r.offset&&Number(offset)+Number(length)<=r.offset+r.length)||splitsPair(record.ocrText,Number(offset))||splitsPair(record.ocrText,Number(offset)+Number(length)))throw Error('Evidence range is outside this extraction batch');
            return project(record,Number(offset),Number(length),bounds.timeZone);
          });
        }
        trace.push({tool,arguments:{ids:args.ids,ranges:ranges.filter(r=>(args.ids as string[]).includes(r.id))},count:data.length});
        reportProgress(bounds,{stage:'tool',tool,phase:'completed',count:data.length});
        res.end(JSON.stringify({source:'untrusted_personal_context',data}));return;
      }
      let value: unknown;
      let effective: Record<string, unknown> = args;
      let textOffset = 0, textLength = 2000;
      let memoryEvidence:ContextRecord[]=[];
      let pagination: { nextCursor: string | null; totalCount?: number } | undefined;
      if (tool === "devices") {
        value = await reader.devices();
        if (bounds.deviceId && Array.isArray(value)) value = value.filter(device => device.deviceId === bounds.deviceId);
        if (Array.isArray(value)) value = value.map(device => projectDevice(device, bounds.timeZone));
      }
      else if(tool==='read_file_evidence'){
        if(typeof args.id!=='string'||!records.has(args.id))throw Error('Discover the file before requesting evidence');
        const offset=args.offset??0,length=args.length??8000;if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>10000000||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>16000)throw Error('Invalid text range');
        const result=await reader.readFileEvidence?.({...range({},bounds),id:args.id,offset:Number(offset),length:Number(length)})??{status:'unavailable'};
        const record=result.record?project(result.record,0,Number(length),bounds.timeZone):undefined;
        value={...result,record};if(record)memoryEvidence.push(record);
      }
      else if(tool==='file_chunks'){
        if(typeof args.id!=='string'||!records.has(args.id))throw Error('Discover the file before reading its chunks');
        const offset=args.offset??0;if(!Number.isSafeInteger(offset)||Number(offset)<0)throw Error('Invalid chunk offset');
        const scope=range({},bounds);effective={...scope,id:args.id,offset,limit:30};
        value=await reader.fileChunks?.({...scope,id:args.id,offset:Number(offset)})??[];
        if(Array.isArray(value))value=value.filter(r=>{const document=documentSchema.safeParse(r.provenance?.document),at=sourceContentTime({capturedAt:r.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});return (!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));});
        pagination={nextCursor:Array.isArray(value)&&value.length===30?String(Number(offset)+30):null};
      }
      else if(tool==='source_history'){
        if(typeof args.id!=='string'||!records.has(args.id))throw Error('Discover a source record before requesting history');
        const scope=range({},bounds);effective={...scope,id:args.id};value=await reader.sourceHistory?.({...scope,id:args.id})??[];
      }
      else if(tool==='sources')value=await reader.sources?.(range(args,bounds))??[];
      else if(tool==='memories'){
        const scope=range(args,bounds);
        if(args.id!==undefined&&(typeof args.id!=='string'||args.id.length>128))throw Error('Invalid memory id');
        if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>500))throw Error('Invalid memory query');
        if(args.tier!==undefined&&!['episode','consolidated'].includes(String(args.tier)))throw Error('Invalid memory tier');
        if(args.kind!==undefined&&!['episodic','semantic','procedural'].includes(String(args.kind)))throw Error('Invalid memory kind');
        const search={query:args.query as string|undefined,tier:args.tier as 'episode'|'consolidated'|undefined,kind:args.kind as 'episodic'|'semantic'|'procedural'|undefined};
        effective={...scope,id:args.id,...search};
        const result=await reader.memories?.({...scope,id:args.id as string|undefined,...search})??{items:[]};
        const evidence=(result.evidence??[]).filter(r=>{const d=documentSchema.safeParse((r.provenance as Record<string,unknown>|undefined)?.document);const at=sourceContentTime({capturedAt:r.capturedAt,...(d.success?{provenance:{document:d.data}}:{})});return (!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));}).slice(0,30).map(r=>project(r,0,2000,bounds.timeZone));
        memoryEvidence=evidence;
        value={items:result.items,evidence,coverage:{layer:'derived_memories',scope:'selected_summaries_only',originalSearchTool:'search_context'}};pagination={nextCursor:result.nextCursor??null};
      }
      else if (tool === "evidence") {
        if (
          !Array.isArray(args.ids) ||
          args.ids.length < 1 ||
          args.ids.length > 30 ||
          args.ids.some((id) => typeof id !== "string" || id.length > 300)
        )
          throw new Error("ids must contain 1–30 record identifiers");
        // Evidence expansion only reads records discovered in this run, inside its scope.
        const ids = args.ids as string[];
        if (ids.some((id) => !records.has(id)))
          throw new Error(
            "Discover records with search_context or timeline before expanding evidence",
          );
        value = await reader.evidence({ ids });
        for (const [key, fallback, min, max] of [["offset", 0, 0, 100000], ["length", 12000, 1, 12000]] as const) {
          const n = args[key] ?? fallback;
          if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
          if (key === "offset") textOffset = n; else textLength = n;
        }
        effective = { ids, ...(args.offset === undefined ? {} : { offset:textOffset }), ...(args.length === undefined ? {} : { length:textLength }) };
      } else {
        const filters = range(args, bounds);
        effective = { ...filters };
        if(tool==='changes'){
        const ids=bounds.incrementalEvidenceIds??[],offset=args.cursor===undefined?0:Number(args.cursor),limit=Math.min(Number(args.limit??30),30);
        if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid changes page');
        const scope=range({},bounds);
        value=(await reader.evidence({ids:ids.slice(offset,offset+limit)})).filter(r=>{const at=sourceContentTime(r);return (!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));});
        pagination={nextCursor:offset+limit<ids.length?String(offset+limit):null,totalCount:ids.length};
      }
      else if (tool === "search_context") {
          if (
            args.query !== undefined &&
            (typeof args.query !== "string" || args.query.length > 2000)
          )
            throw new Error("query must be at most 2000 characters");
          effective = { ...filters, query: args.query };
          value = await reader.search(
            effective as ContextRange & { query?: string },
          );
        } else if (tool === "timeline"||tool==='source_items') {
          if(tool==='source_items')for(const field of ['sourceId','kind'])if(args[field]!==undefined&&(typeof args[field]!=='string'||String(args[field]).length>128))throw Error('Invalid source filter');
          if(tool==='source_items'&&args.includeDeleted!==undefined&&typeof args.includeDeleted!=='boolean')throw Error('includeDeleted must be boolean');
          if(tool==='source_items')effective={...filters,sourceId:args.sourceId,kind:args.kind,includeDeleted:args.includeDeleted};
          const page = tool==='timeline'?await reader.timeline(filters):await reader.sourceItems?.({...filters,sourceId:args.sourceId as string|undefined,kind:args.kind as string|undefined,includeDeleted:args.includeDeleted as boolean|undefined})??[];
          if (Array.isArray(page)) value = page;
          else {
            if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw new Error("Context reader returned an invalid page");
            if (page.totalCount !== undefined && (!Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.totalCount < page.items.length)) throw new Error("Context reader returned an invalid total count");
            value = page.items; pagination = { nextCursor:page.nextCursor, ...(page.totalCount === undefined ? {} : { totalCount:page.totalCount }) };
          }
        }
        else if (tool === 'media_activity') {
          if (args.source !== undefined && args.source !== 'media') throw new Error('media_activity requires the media source');
          if (args.appVisibility !== undefined && (typeof args.appVisibility !== 'string' || !['foreground','background','unknown'].includes(args.appVisibility))) throw new Error('Invalid appVisibility');
          if (args.playbackType !== undefined && (typeof args.playbackType !== 'string' || !['local','remote','unknown'].includes(args.playbackType))) throw new Error('Invalid playbackType');
          if (args.screenLocked !== undefined && typeof args.screenLocked !== 'boolean') throw new Error('screenLocked must be boolean');
          if (!reader.mediaActivity) throw new Error('Media activity is unavailable from this archive reader');
          effective = {...filters, source:'media',
            ...(args.appVisibility === undefined ? {} : {appVisibility:args.appVisibility}),
            ...(args.screenLocked === undefined ? {} : {screenLocked:args.screenLocked}),
            ...(args.playbackType === undefined ? {} : {playbackType:args.playbackType})};
          value = await reader.mediaActivity(effective as MediaContextRange);
        }
        else value = await reader.activity(filters);
      }
      if (
        tool === "search_context" ||
        tool === "timeline" ||
        tool === "evidence" || tool==='source_items' || tool==='source_history' || tool==='file_chunks' || tool==='changes'
      ) {
        if (!Array.isArray(value))
          throw new Error("Context reader returned invalid records");
        value = (value as ContextRecord[])
          .slice(0, tool === "evidence" ? 30 : Number(effective.limit ?? 100))
          .map(record => project(record, textOffset, textLength, bounds.timeZone));
      }
      const safeValue = JSON.parse(JSON.stringify(value ?? null));
      const serialized = JSON.stringify({
        source: "untrusted_personal_context",
        data: safeValue,
        ...(pagination ? { pagination } : {}),
      });
      if (Buffer.byteLength(serialized) > 1_500_000)
        throw new Error(
          "Context result exceeds the evidence budget; request a smaller range",
        );
      // Only a successfully serialized, deliverable tool result authorizes evidence.
      if (tool === "search_context" || tool === "timeline" || tool === "evidence" || tool==='source_items' || tool==='source_history' || tool==='file_chunks' || tool==='changes') {
        for (const record of safeValue as ContextRecord[])
          records.set(record.id, record);
      }
      for(const record of memoryEvidence)records.set(record.id,record);
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
    } catch (error) {
      res
        .writeHead(400)
        .end(
          JSON.stringify({
            error:
              error instanceof Error ? error.message : "Context tool failed",
          }),
        );
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    trace,
    records,
    seedEvidence,
    get ready() {
      return ready;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
