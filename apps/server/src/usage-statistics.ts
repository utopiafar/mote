import type {QueryInput} from '@mote/agent';
import {
  usageCaptureKinds, type MeasuredCount, type UsageActivity, type UsageActivityKind, type UsageCaptureKind,
  type UsageFailure, type UsageFailureKind, type UsageRetryResult, type UsageStatisticsCounts,
  type UsageStatisticsPage, type UsageStatisticsSummary, type UsageToolResult, type UsageTurnResult,
} from '@mote/shared';
import {dayBuckets, type CivilDay} from './civil-dates.js';
import type {EvidenceStore} from './evidence-store.js';
import {installSchemaPlan, type SchemaInstallation} from './schema-installation.js';

type ToolObservation = Parameters<NonNullable<QueryInput['onHostToolAttempt']>>[0];
type RunObservation = Parameters<NonNullable<QueryInput['onHostRunEvent']>>[0];
type Range = {from:string;to:string;timeZone:string};
export type StatisticsCursor = {at:string;key:string};
type PageQuery = {limit:number;cursor?:StatisticsCursor};
type Window = Pick<CivilDay,'after'|'before'>;
const dayMs = 86_400_000;
const iso = (at:number) => new Date(at).toISOString();

export const usageStatisticsSchemaInstallation = {
  owner:'usage-statistics', requires:[],
  prerequisites:[
    {owner:'conversation-turn-storage',objects:[{type:'table',name:'conversation_turns'}]},
    {owner:'execution',objects:[{type:'table',name:'execution_failures'}]},
  ],
  install(db) { db.exec(`
    CREATE INDEX IF NOT EXISTS statistics_turn_created ON conversation_turns(json_extract(json,'$.createdAt'),id);
    CREATE INDEX IF NOT EXISTS statistics_failure_at ON execution_failures(json_extract(json,'$.at'),step_id);
    CREATE TABLE IF NOT EXISTS usage_tool_coverage(id INTEGER PRIMARY KEY CHECK(id=1),started_at TEXT NOT NULL,missing_since TEXT,missing_until TEXT);
    CREATE TABLE IF NOT EXISTS usage_tool_attempts(
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, tool TEXT NOT NULL,
      started_at TEXT NOT NULL, result TEXT NOT NULL, duration_ms INTEGER, reason TEXT, retry TEXT
    );
    CREATE INDEX IF NOT EXISTS statistics_tool_at ON usage_tool_attempts(started_at,id);
    CREATE INDEX IF NOT EXISTS statistics_tool_run ON usage_tool_attempts(run_id) WHERE result='failed';
  `); },
} as const satisfies SchemaInstallation;

const captureKind = `CASE
  WHEN json_extract(captures.json,'$.source')='screen' THEN CASE
    WHEN json_extract(captures.json,'$.platform')='android' THEN CASE
      WHEN json_extract(captures.json,'$.metadata.collector.method')='media_projection' THEN 'projection'
      WHEN json_extract(captures.json,'$.metadata.collector.method') IS NULL THEN 'unknownScreen'
      ELSE 'screen' END
    ELSE 'screen' END
  WHEN json_extract(captures.json,'$.source')='ui_page' THEN 'page'
  WHEN json_extract(captures.json,'$.source') IN ('notification','device_event') THEN 'system'
  ELSE 'other' END`;
// Capture activity covers collected observations and notes. Connector file
// revisions and evidence excerpts belong to their own archive surfaces.
const visibleCapture = `json_extract(captures.json,'$.source') IN ('screen','ui_page','notification','device_event','activity','media','note','event')
  AND (NOT EXISTS(SELECT 1 FROM source_versions v WHERE v.capture_id=captures.id)
    OR EXISTS(SELECT 1 FROM source_heads h WHERE h.capture_id=captures.id AND h.deleted=0))
  AND NOT EXISTS(SELECT 1 FROM file_versions v WHERE v.capture_id=captures.id)
  AND NOT EXISTS(SELECT 1 FROM file_evidence_links l JOIN file_versions v ON v.capture_id=l.parent_id WHERE l.capture_id=captures.id)`;
const turnAt = "json_extract(t.json,'$.createdAt')";
const turnState = "coalesce(json_extract(t.json,'$.status'),'completed')";
const processingAt = "json_extract(f.json,'$.at')";
const processingFrom = `FROM execution_failures f JOIN execution_steps e ON e.id=f.step_id
  JOIN captures ON captures.id=substr(e.operation_id,7)
  WHERE e.kind IN ('images.ocr','images.understanding','images.derived')
  AND json_extract(f.json,'$.state') IN ('failed','waiting')
  AND json_extract(f.json,'$.category') IN ('permanent','transient')
  AND coalesce(json_extract(f.json,'$.admissionWaiting'),0)=0
  AND coalesce(json_extract(f.json,'$.executionStarted'),1)=1`;

function dates({from,to,timeZone}:Range) {
  return dayBuckets(iso(Date.parse(from)-dayMs),iso(Date.parse(to)+2*dayMs),timeZone).filter(day=>day.day>=from&&day.day<=to);
}
function emptyCaptureCounts():UsageStatisticsCounts['captures'] {
  return Object.fromEntries(usageCaptureKinds.map(kind=>[kind,0])) as UsageStatisticsCounts['captures'];
}
function safeCode(value:unknown) {return typeof value==='string'&&/^[a-z][a-z0-9_.:-]{0,99}$/.test(value)?value:null;}
const keyOf = (item:{kind:string;id:string}) => `${item.kind}:${item.id}`;
function seek(cursor?:StatisticsCursor) {return [cursor?.at??null,cursor?.at??null,cursor?.at??null,cursor?.key??null];}
function page<T extends {at:string;kind:string;id:string}>(rows:T[],limit:number):UsageStatisticsPage<T> {
  rows.sort((a,b)=>a.at===b.at?(keyOf(a)<keyOf(b)?1:-1):a.at<b.at?1:-1);
  const items=rows.slice(0,limit),last=items.at(-1);
  return {items,nextCursor:last&&rows.length>limit?Buffer.from(JSON.stringify({at:last.at,key:keyOf(last)})).toString('base64url'):null};
}

/** Owner-only read model. Captures and turns retain their domain deletion and
 * visibility rules; tool measurements store only Host execution metadata. */
export class UsageStatistics {
  private readonly startedAt:string;
  private missingSince:string|null;
  private missingUntil:string|null;
  private pendingCoverage=false;
  constructor(private readonly store:EvidenceStore,private readonly now=Date.now) {
    installSchemaPlan(store.db,[usageStatisticsSchemaInstallation]);
    store.db.prepare('INSERT OR IGNORE INTO usage_tool_coverage(id,started_at) VALUES(1,?)').run(iso(now()));
    const coverage=store.db.prepare('SELECT started_at,missing_since,missing_until FROM usage_tool_coverage WHERE id=1').get()!;
    this.startedAt=String(coverage.started_at);
    this.missingSince=typeof coverage.missing_since==='string'?coverage.missing_since:null;
    this.missingUntil=typeof coverage.missing_until==='string'?coverage.missing_until:null;
    // Interrupted deliveries have a measured start and an unknown outcome.
    store.db.prepare("UPDATE usage_tool_attempts SET result='unknown' WHERE result='running'").run();
  }

  private record(write:()=>void) {
    try {write();}
    catch {
      // A full vault must not fail the owner action or turn lost observations
      // into exact zeroes. Preserve the first coverage gap when writing resumes.
      this.missingUntil=iso(this.now());
      this.missingSince??=this.missingUntil;
      this.pendingCoverage=true;
    }
    if(!this.pendingCoverage)return;
    try {
      this.store.db.prepare('UPDATE usage_tool_coverage SET missing_since=?,missing_until=? WHERE id=1').run(this.missingSince,this.missingUntil);
      this.pendingCoverage=false;
    }catch {/* The live view reports the gap until the vault can write it. */}
  }

  observeTool(event:ToolObservation) {
    this.record(()=>{
      if(event.kind==='started'){
        const tool=/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(event.tool)?event.tool:'unknown_tool';
        this.store.db.prepare("INSERT INTO usage_tool_attempts(id,run_id,attempt_id,tool,started_at,result) VALUES(?,?,?,?,?,'running') ON CONFLICT(id) DO NOTHING")
          .run(event.id,event.runId,event.attemptId,tool,iso(this.now()));
      }else this.store.db.prepare("UPDATE usage_tool_attempts SET result=?,duration_ms=?,reason=? WHERE id=? AND result='running'")
        .run(event.result,event.durationMs,safeCode(event.reason),event.id);
    });
  }

  observeRun(envelope:RunObservation) {
    if(envelope.event.type!=='run.terminal'||envelope.attemptId===null)return;
    const {kind}=envelope.event.terminal;
    if(kind==='yielded')return;
    const result=kind==='completed'?'completed':kind==='cancelled'?'cancelled':'failed';
    // The same Host run issued a different attempt. This records the run's
    // retry outcome, independent of which tools a later attempt invoked.
    this.record(()=>{this.store.db.prepare("UPDATE usage_tool_attempts SET retry=? WHERE run_id=? AND attempt_id<>? AND result='failed'")
      .run(result,envelope.identity.runId,envelope.attemptId);});
  }

  summary(range:Range):UsageStatisticsSummary {
    const days=dates(range),window=days.length?{after:days[0].after,before:days.at(-1)!.before}:undefined;
    const tools=window?this.store.db.prepare(`SELECT tool AS name,count(*) AS calls,sum(result='failed') AS failures FROM usage_tool_attempts
      WHERE started_at>=? AND started_at<? GROUP BY tool ORDER BY calls DESC,tool LIMIT 10`).all(window.after,window.before)
      .map(row=>({name:String(row.name),calls:Number(row.calls),failures:Number(row.failures)})):[];
    return {total:this.counts(window),days:days.map(({day,after,before})=>({day,...this.counts({after,before})})),tools};
  }

  private counts(window:Window|undefined):UsageStatisticsCounts {
    const captures=emptyCaptureCounts(),db=this.store.db;
    const unknown:MeasuredCount={value:null,partial:true};
    if(!window)return {captures,turns:0,turnFailures:0,processingFailures:0,toolCalls:unknown,toolFailures:unknown};
    const {after,before}=window;
    for(const row of db.prepare(`SELECT ${captureKind} AS kind,count(*) AS total FROM captures
      WHERE captured_at>=? AND captured_at<? AND ${visibleCapture} GROUP BY kind`).all(after,before))captures[row.kind as UsageCaptureKind]=Number(row.total);
    const turns=db.prepare(`SELECT count(*) AS total,sum(${turnState}='failed') AS failed FROM conversation_turns t
      WHERE ${turnAt}>=? AND ${turnAt}<?`).get(after,before)!;
    const processingFailures=Number(db.prepare(`SELECT count(*) AS n ${processingFrom} AND ${processingAt}>=? AND ${processingAt}<?`).get(after,before)!.n);
    const beforeCoverage=window.before<=this.startedAt;
    const attempts=beforeCoverage?undefined:db.prepare(`SELECT count(*) AS total,sum(result='failed') AS failed,
      sum(result IN ('running','unknown')) AS unknown FROM usage_tool_attempts WHERE started_at>=? AND started_at<?`).get(after,before);
    const gap=window.after<this.startedAt||Boolean(this.missingSince&&this.missingUntil&&window.before>this.missingSince&&window.after<=this.missingUntil);
    const toolCalls=attempts?{value:Number(attempts.total),partial:gap}:unknown;
    const toolFailures=attempts?{value:Number(attempts.failed??0),partial:gap||Boolean(attempts.unknown)}:unknown;
    return {captures,turns:Number(turns.total),turnFailures:Number(turns.failed??0),processingFailures,toolCalls,toolFailures};
  }

  day(date:string,timeZone:string,query:PageQuery&{kind?:UsageActivityKind}):UsageStatisticsPage<UsageActivity> {
    const window=dates({from:date,to:date,timeZone})[0];
    if(!window)return page([],query.limit);
    const db=this.store.db,rows:UsageActivity[]=[],{kind,limit,cursor}=query,{after,before}=window;
    const params=[after,before,...seek(cursor),limit+1];
    if(!kind||kind==='capture'){
      for(const row of db.prepare(`SELECT id,captured_at AS at,${captureKind} AS kind,blob_hash IS NOT NULL AS image,
        json_extract(json,'$.appName') AS app,json_extract(json,'$.deviceName') AS device
        FROM captures WHERE captured_at>=? AND captured_at<? AND ${visibleCapture}
        AND (? IS NULL OR captured_at<? OR (captured_at=? AND 'capture:' || captures.id<?))
        ORDER BY captured_at DESC,id DESC LIMIT ?`).all(...params)){
        rows.push({kind:'capture',id:String(row.id),at:String(row.at),captureKind:row.kind as UsageCaptureKind,
          hasImage:Boolean(row.image),appName:String(row.app??''),deviceName:String(row.device??'')});
      }
    }
    if(!kind||kind==='turn'){
      for(const row of db.prepare(`SELECT t.id,${turnAt} AS at,${turnState} AS state FROM conversation_turns t
        WHERE ${turnAt}>=? AND ${turnAt}<? AND (? IS NULL OR ${turnAt}<? OR (${turnAt}=? AND 'turn:' || t.id<?))
        ORDER BY at DESC,t.id DESC LIMIT ?`).all(...params)){
        rows.push({kind:'turn',id:String(row.id),at:String(row.at),state:row.state as UsageTurnResult});
      }
    }
    if(!kind||kind==='tool'){
      for(const row of db.prepare(`SELECT id,started_at AS at,tool,result,duration_ms FROM usage_tool_attempts
        WHERE started_at>=? AND started_at<? AND (? IS NULL OR started_at<? OR (started_at=? AND 'tool:' || id<?))
        ORDER BY started_at DESC,id DESC LIMIT ?`).all(...params)){
        rows.push({kind:'tool',id:String(row.id),at:String(row.at),name:String(row.tool),state:row.result as UsageToolResult,
          durationMs:typeof row.duration_ms==='number'?row.duration_ms:null});
      }
    }
    return page(rows,limit);
  }

  failures(range:Range,query:PageQuery&{kind:UsageFailureKind}):UsageStatisticsPage<UsageFailure> {
    const days=dates(range),window=days.length?{after:days[0].after,before:days.at(-1)!.before}:undefined;
    if(!window)return page([],query.limit);
    const {kind,cursor,limit}=query,db=this.store.db;
    const params=[window.after,window.before,...seek(cursor),limit+1];
    if(kind==='tool'){
      const rows=db.prepare(`SELECT id,started_at AS at,tool,reason,retry FROM usage_tool_attempts
        WHERE result='failed' AND started_at>=? AND started_at<? AND (? IS NULL OR started_at<? OR (started_at=? AND 'tool:' || id<?))
        ORDER BY started_at DESC,id DESC LIMIT ?`).all(...params);
      return page(rows.map(row=>({kind,id:String(row.id),at:String(row.at),tool:String(row.tool),reason:safeCode(row.reason),retry:(row.retry??'unrecorded') as UsageRetryResult})),limit);
    }
    if(kind==='turn'){
      const rows=db.prepare(`SELECT t.id,${turnAt} AS at,coalesce(json_extract(t.json,'$.error.code'),json_extract(r.json,'$.error.code')) AS reason
        FROM conversation_turns t LEFT JOIN query_runs r ON r.id=json_extract(t.json,'$.runId')
        WHERE ${turnState}='failed' AND ${turnAt}>=? AND ${turnAt}<? AND (? IS NULL OR ${turnAt}<? OR (${turnAt}=? AND 'turn:' || t.id<?))
        ORDER BY at DESC,t.id DESC LIMIT ?`).all(...params);
      // A retained failed turn has no persisted link to a later owner resend.
      return page(rows.map(row=>({kind,id:String(row.id),at:String(row.at),reason:safeCode(row.reason),retry:'unrecorded'})),limit);
    }
    const rows=db.prepare(`SELECT f.step_id AS id,${processingAt} AS at,json_extract(f.json,'$.code') AS reason,e.state,e.attempts,
      json_extract(f.json,'$.attempt') AS failed_attempt ${processingFrom}
      AND ${processingAt}>=? AND ${processingAt}<? AND (? IS NULL OR ${processingAt}<? OR (${processingAt}=? AND 'processing:' || f.step_id<?))
      ORDER BY at DESC,f.step_id DESC LIMIT ?`).all(...params);
    return page(rows.map(row=>({kind,id:String(row.id),at:String(row.at),reason:safeCode(row.reason),retry:processingRetry(row)})),limit);
  }
}

function processingRetry(row:{[key:string]:unknown}):UsageRetryResult {
  if(row.state==='succeeded')return 'completed';
  if(row.state==='waiting'||row.state==='running'||row.state==='cancelled')return row.state;
  return row.state==='failed'&&Number(row.attempts)>1&&row.failed_attempt===row.attempts?'failed':'unrecorded';
}
