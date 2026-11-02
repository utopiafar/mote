import {sourceSchema} from '@mote/shared';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {originalEvidenceReceipt} from '../../bridge.js';
import {ContextToolError} from '../../tool-errors.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange, ContextRecord} from '../../context-contracts.js';

/** C10/A08B original-read pack. It owns the five original-facing tool schemas,
 * argument parsing and read request shape; the parent Host still owns discovery,
 * fresh grants, delivery receipts, ledger, citations and cancellation.
 *
 * The ports this pack may reach are exactly the operations it declares. It never
 * receives a reader, store, ledger, sender, confirm or discard. */

export interface OriginalReadPackOptions {
  /** Display time zone for projected timestamps. Defaults to UTC. */
  readonly timeZone?:string;
}

const invalid=(message:string,details:Record<string,unknown>={})=>new ContextToolError('invalid_tool_arguments',message,'correct_arguments',details);

function spec(name:string):readonly [string,string,ToolFields]{
  const entry=CONTEXT_TOOLS.find(([candidate])=>candidate===name);
  if(!entry)throw new Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string,string,ToolFields];
}

function dateValue(value:unknown,field:string):string|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw invalid(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

/** Merge model arguments with the parent scope exactly as the session does:
 * the narrower bound wins and a contradicted device/cursor fails before I/O. */
export function originalReadRange(args:Readonly<Record<string,unknown>>,scope:Readonly<ContextRange>,limitDefault=8):ContextRange{
  const after=dateValue(args.after,'after'),before=dateValue(args.before,'before'),lower=scope.after,upper=scope.before;
  const effectiveAfter=after&&lower?(after>lower?after:lower):(after??lower);
  const effectiveBefore=before&&upper?(before<upper?before:upper):(before??upper);
  if(effectiveAfter&&effectiveBefore&&effectiveAfter>effectiveBefore)throw invalid('Time range is outside the requested scope');
  if(args.deviceId!==undefined&&typeof args.deviceId!=='string')throw invalid('deviceId must be a string');
  if(scope.deviceId&&args.deviceId!==undefined&&args.deviceId!==scope.deviceId)throw invalid('Device is outside the requested scope');
  if(args.limit!==undefined&&(!Number.isInteger(args.limit)||Number(args.limit)<1))throw invalid('limit must be a positive integer');
  if(args.cursor!==undefined&&(typeof args.cursor!=='string'||!args.cursor||args.cursor.length>4096))throw invalid('cursor must be a pagination token returned by timeline');
  if(args.source!==undefined&&!sourceSchema.safeParse(args.source).success)throw invalid('Invalid source');
  if(args.appId!==undefined&&(typeof args.appId!=='string'||!args.appId.trim()||args.appId.length>300))throw invalid('Invalid appId');
  if(args.collection!==undefined&&args.collection!=='content'&&args.collection!=='activity')throw invalid('Invalid collection');
  return {
    ...(effectiveAfter===undefined?{}:{after:effectiveAfter}),
    ...(effectiveBefore===undefined?{}:{before:effectiveBefore}),
    ...(scope.deviceId??args.deviceId as string|undefined ? {deviceId:scope.deviceId??args.deviceId as string}:{}),
    limit:Math.min(Number(args.limit??scope.limit??limitDefault),12),
    ...(args.cursor===undefined?{}:{cursor:args.cursor as string}),
    ...(args.source===undefined?{}:{source:sourceSchema.parse(args.source)}),
    ...(args.appId===undefined?{}:{appId:args.appId as string}),
    ...(args.collection===undefined?{}:{collection:args.collection as 'content'|'activity'}),
  };
}

/** Literal lexical localization only; no intent or topic classification. */
function preview(record:ContextRecord,query:unknown,timeZone:string):ContextRecord{
  let offset=0;
  if(typeof query==='string'){
    const terms=query.match(/[\p{L}\p{N}_-]+/gu)??[];
    const positions=terms.map(term=>record.ocrText.search(new RegExp(term,'iu'))).filter(position=>position>=0);
    if(positions.length)offset=Math.max(0,Math.min(...positions)-120);
  }
  return originalEvidenceReceipt(record,offset,600,timeZone);
}

function assertRecords(value:unknown):ContextRecord[]{
  if(!Array.isArray(value))throw invalid('Context reader returned invalid records');
  return value as ContextRecord[];
}


/** The five original-facing descriptors. Versioning is explicit so a pinned
 * snapshot cannot silently inherit a schema change. */
export function createOriginalReadPack(options:OriginalReadPackOptions={}):readonly ToolDescriptor[]{
  const timeZone=options.timeZone??'UTC';
  const searchSpec=spec('search_context'),timelineSpec=spec('timeline'),evidenceSpec=spec('evidence'),contextEvidenceSpec=spec('context_evidence');
  const search=defineToolDescriptor({
    apiVersion:'1',name:'search_context',version:'1',description:searchSpec[1],fields:searchSpec[2],kind:'originals',exposure:'native',requires:['search'],
    parse(args){
      if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>2000))throw invalid('query must be at most 2000 characters');
      originalReadRange(args,{});
      return {...args};
    },
    async execute(args,port:HostSessionPort){
      const filters={...originalReadRange(args,port.scope), ...(args.query===undefined?{}:{query:args.query as string})};
      port.assertCurrent();
      const records=assertRecords(await port.read('search',filters));
      port.assertCurrent();
      const retrieval=(records as unknown as {retrieval?:unknown}).retrieval;
      return {source:'untrusted_personal_context',data:records.slice(0,Number(filters.limit??100)).map(record=>preview(record,args.query,timeZone)),...(retrieval?{retrieval}:{})};
    },
  });
  const timeline=defineToolDescriptor({
    apiVersion:'1',name:'timeline',version:'1',description:timelineSpec[1],fields:timelineSpec[2],kind:'originals',exposure:'native',requires:['timeline'],
    parse(args){originalReadRange(args,{});return {...args};},
    async execute(args,port:HostSessionPort){
      const filters=originalReadRange(args,port.scope);
      port.assertCurrent();
      const page=await port.read('timeline',filters);
      port.assertCurrent();
      if(!page||!Array.isArray(page.items)||(page.nextCursor!==null&&typeof page.nextCursor!=='string'))throw invalid('Context reader returned an invalid page');
      if(page.totalCount!==undefined&&(!Number.isSafeInteger(page.totalCount)||page.totalCount<0||page.totalCount<page.items.length))throw invalid('Context reader returned an invalid total count');
      const data=page.items.slice(0,Number(filters.limit??100)).map(record=>preview(record,undefined,timeZone));
      return {source:'untrusted_personal_context',data,pagination:{nextCursor:page.nextCursor,...(page.totalCount===undefined?{}:{totalCount:page.totalCount})}};
    },
  });
  const evidence=defineToolDescriptor({
    apiVersion:'1',name:'evidence',version:'1',description:evidenceSpec[1],fields:evidenceSpec[2],kind:'originals',exposure:'native',requires:['evidence'],
    parse(args){
      if(!Array.isArray(args.ids)||args.ids.length<1||args.ids.length>30||args.ids.some(id=>typeof id!=='string'||id.length>300))throw invalid('ids must contain 1–30 record identifiers');
      if(args.layer!==undefined&&!['ocr','semantic'].includes(String(args.layer)))throw invalid('Invalid derived layer');
      if(args.offset!==undefined&&(typeof args.offset!=='number'||!Number.isSafeInteger(args.offset)||args.offset<0))throw invalid('offset must be a nonnegative integer');
      if(args.length!==undefined&&(typeof args.length!=='number'||!Number.isSafeInteger(args.length)||args.length<1||args.length>12000))throw invalid('length must be an integer from 1 to 12000');
      return {...args};
    },
    async execute(args,port:HostSessionPort){
      const ids=args.ids as string[];
      // The parent binds this tool call to its own offset/length/layer and returns
      // the final allowed page (archive vs selected evidence). Only explicit
      // arguments are forwarded; the pack never fills shared defaults.
      const request={ids,...(args.offset===undefined?{}:{offset:args.offset}),...(args.length===undefined?{}:{length:args.length}),...(args.layer===undefined?{}:{layer:args.layer})};
      port.assertCurrent();
      const records=assertRecords(await port.read('evidence',request));
      port.assertCurrent();
      return {source:'untrusted_personal_context',data:records};
    },
  });
  const contextEvidence=defineToolDescriptor({
    apiVersion:'1',name:'context_evidence',version:'1',description:contextEvidenceSpec[1],fields:contextEvidenceSpec[2],kind:'originals',exposure:'native',requires:['evidence'],
    parse(args){
      if(typeof args.id!=='string'||!args.id)throw invalid('Use an original id from authorizedContextRanges');
      if(typeof args.offset!=='number'||!Number.isSafeInteger(args.offset)||args.offset<0)throw invalid('offset must be a nonnegative integer');
      if(args.length!==undefined&&(typeof args.length!=='number'||!Number.isSafeInteger(args.length)||args.length<1||args.length>12000))throw invalid('length must be an integer from 1 to 12000');
      return {...args};
    },
    async execute(args,port:HostSessionPort){
      const id=args.id as string;
      // The parent binds this tool call to its readRanges/originalPins and returns
      // records already projected to the granted UTF-16 page. The pack must not
      // re-slice, append readRange or serialize a second envelope.
      port.assertCurrent();
      const records=assertRecords(await port.read('evidence',{ids:[id]}));
      port.assertCurrent();
      return {source:'untrusted_personal_context',data:records};
    },
  });
  return Object.freeze([search,timeline,evidence,contextEvidence]);
}
