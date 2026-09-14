import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { displayTime } from './time.js';
import {recordMetadataSchema, sourceMetadataSchema, sourceSchema} from '@mote/shared';
import type {
  ContextReader,
  ContextRecord,
  ContextRange,
  QueryInput,
  ToolTrace,
} from "./types.js";

export const TOOL_NAMES = [
  "search_context",
  "timeline",
  "evidence",
  "activity",
  "devices",
  "sources",
  "source_items",
  "source_history",
  "memories",
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
  return {
    id: record.id,
    capturedAt: record.capturedAt,
    displayCapturedAt: displayTime(record.capturedAt, timeZone),
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
  let calls = 0;
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
          exposed.length !== TOOL_NAMES.length ||
          !TOOL_NAMES.every((name) => exposed.includes(name))
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
      if (!['timeline','search_context','activity'].includes(tool) && ['source','appId','collection'].some(field => args[field] !== undefined))
        throw new Error('App/source/collection filters are supported only by timeline, search_context and activity');
      if (++calls > maxToolCalls)
        throw new Error(
          "Tool call budget reached; finish using the evidence already retrieved",
        );
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
      else if(tool==='source_history'){
        if(typeof args.id!=='string'||!records.has(args.id))throw Error('Discover a source record before requesting history');
        const scope=range({},bounds);effective={...scope,id:args.id};value=await reader.sourceHistory?.({...scope,id:args.id})??[];
      }
      else if(tool==='sources')value=await reader.sources?.(range(args,bounds))??[];
      else if(tool==='memories'){
        const scope=range(args,bounds);
        if(args.id!==undefined&&(typeof args.id!=='string'||args.id.length>128))throw Error('Invalid memory id');
        effective={...scope,id:args.id};
        const result=await reader.memories?.({...scope,id:args.id as string|undefined})??{items:[]};
        const evidence=(result.evidence??[]).filter(r=>(!scope.deviceId||r.deviceId===scope.deviceId)&&(!scope.after||r.capturedAt>=scope.after)&&(!scope.before||r.capturedAt<scope.before)).slice(0,30).map(r=>project(r,0,2000,bounds.timeZone));
        memoryEvidence=evidence;
        value={items:result.items,evidence};
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
        if (tool === "search_context") {
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
        else value = await reader.activity(filters);
      }
      if (
        tool === "search_context" ||
        tool === "timeline" ||
        tool === "evidence" || tool==='source_items' || tool==='source_history'
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
      if (tool === "search_context" || tool === "timeline" || tool === "evidence" || tool==='source_items' || tool==='source_history') {
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
