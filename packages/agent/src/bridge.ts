import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
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
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) || Number(args.limit) < 1)
  )
    throw new Error("limit must be a positive integer");
  return {
    after: effectiveAfter,
    before: effectiveBefore,
    deviceId: args.deviceId as string | undefined,
    limit: Math.min(Number(args.limit ?? 30), 100),
  };
}

/** Deliberately projects public evidence fields; no file paths, tokens, or images reach the model. */
function project(record: ContextRecord): ContextRecord {
  return {
    id: record.id,
    capturedAt: record.capturedAt,
    appName: record.appName,
    ocrText: String(record.ocrText ?? "").slice(0, 12_000),
    ...(record.summary === undefined
      ? {}
      : { summary: String(record.summary).slice(0, 4000) }),
    ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
    ...(record.sourceType === undefined
      ? {}
      : { sourceType: record.sourceType }),
    ...(typeof record.mood === "string"
      ? { mood: record.mood.slice(0, 80) }
      : {}),
  };
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
      if (++calls > maxToolCalls)
        throw new Error(
          "Tool call budget reached; finish using the evidence already retrieved",
        );
      let value: unknown;
      let effective: Record<string, unknown> = args;
      if (tool === "devices") value = await reader.devices();
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
        effective = { ids };
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
        } else if (tool === "timeline") value = await reader.timeline(filters);
        else value = await reader.activity(filters);
      }
      if (
        tool === "search_context" ||
        tool === "timeline" ||
        tool === "evidence"
      ) {
        if (!Array.isArray(value))
          throw new Error("Context reader returned invalid records");
        value = (value as ContextRecord[])
          .slice(0, tool === "evidence" ? 30 : Number(effective.limit ?? 100))
          .map(project);
        for (const record of value as ContextRecord[])
          records.set(record.id, record);
      }
      const safeValue = JSON.parse(JSON.stringify(value ?? null));
      const serialized = JSON.stringify({
        source: "untrusted_personal_context",
        data: safeValue,
      });
      if (Buffer.byteLength(serialized) > 1_500_000)
        throw new Error(
          "Context result exceeds the evidence budget; request a smaller range",
        );
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
