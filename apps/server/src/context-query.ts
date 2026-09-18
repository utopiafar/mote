import {createHash} from 'node:crypto';
import {sourceContentTime,type CaptureRecord,type SourceConnection} from '@mote/shared';
import type {FileStore} from './files.js';
import {MemoryStore,type Memory} from './memory.js';
import type {SourceStore} from './sources.js';
import type {Store} from './store.js';
import {StoreError,type Range} from './store.js';

export type ContextQueryInput = Range & {
  query?:string;
  projectKey?:string;
  provider?:'claude'|'codex'|'kimi';
  sessionId?:string;
  cursor?:string;
  limit?:number;
  maxCharacters?:number;
  includeRecentSessions?:boolean;
  includeMemories?:boolean;
};

export type ContextOrigin = {
  source:string;
  sourceId?:string;
  deviceId:string;
  appName:string;
  capturedAt:string;
  receivedAt:string;
  provider?:'claude'|'codex'|'kimi';
  sessionId?:string;
  projectKey?:string;
};

export type ContextCard = {
  ref:string;
  id:string;
  kind:string;
  title:string;
  snippet:string;
  matchReasons:string[];
  origin:ContextOrigin;
  revision?:string;
  locator?:{offset:number;length:number;totalLength:number};
  evidenceRefs:string[];
  status?:string;
  applicability?:string;
};

export type ContextCoverage = {
  recordsScanned:number;
  recordsReturned:number;
  memoriesScanned:number;
  memoriesReturned:number;
  originalLatestAt:string|null;
  memoryLatestAt:string|null;
  sourceStates:Array<{id:string;name:string;state:string;lastSyncAt?:string}>;
  truncated:boolean;
};

export type ContextPage = {
  items:ContextCard[];
  coverage:ContextCoverage;
  nextCursor:string|null;
  truncated:boolean;
};

export type ContextReadItem = {
  ref:string;
  id:string;
  kind:string;
  text:string;
  textRange:{offset:number;total:number;nextOffset:number|null};
  title?:string;
  origin?:ContextOrigin;
  evidenceRefs?:string[];
  status?:string;
  applicability?:string;
};

export type ContextReadPage = {
  items:ContextReadItem[];
  missingRefs:string[];
  truncated:boolean;
};

export type ContextBundle = {
  stableMemories:ContextCard[];
  recentSessions:ContextCard[];
  recentRecords:ContextCard[];
  coverage:ContextCoverage;
  nextCursor:string|null;
  truncated:boolean;
};

type CodingScope={provider:'claude'|'codex'|'kimi';sessionId:string;projectKey:string};
type Cursor={kind:'browse'|'search';hash:string;inner?:string|null};

const MAX_SCAN=200;
const DEFAULT_LIMIT=20;
const MAX_LIMIT=100;
const DEFAULT_SNIPPET=480;
const MAX_RESPONSE_CHARACTERS=24000;

function codingScope(record:CaptureRecord):CodingScope|undefined {
  const value=record.provenance?.document?.coding;
  return value?{provider:value.provider,sessionId:value.sessionId,projectKey:value.projectKey}:undefined;
}

function hashQuery(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);}
function encodeCursor(value:Cursor){return Buffer.from(JSON.stringify(value)).toString('base64url');}
function decodeCursor(value:string|undefined,kind:'browse'|'search',query:unknown):Cursor|undefined {
  if(!value)return;
  try {
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString()) as Cursor;
    if(parsed.kind!==kind||parsed.hash!==hashQuery(query))throw Error();
    return parsed;
  } catch {throw new StoreError('Invalid context cursor');}
}

function boundLimit(value:number|undefined){return Math.max(1,Math.min(value??DEFAULT_LIMIT,MAX_LIMIT));}
function lower(value:string){return value.toLocaleLowerCase();}

function searchableText(record:CaptureRecord){
  const media=record.metadata?.media?.sessions.flatMap(session=>[session.appId,session.appName,session.title,session.artist,session.album,session.displaySubtitle,session.mediaId] as (string|undefined)[]).filter(Boolean)??[];
  return [record.appName,record.windowTitle,record.ocrText,record.mood,...media,record.metadata?JSON.stringify(record.metadata):''].filter(Boolean).join('\n');
}

function snippet(text:string,query:string|undefined,maxLength=DEFAULT_SNIPPET){
  const value=text||'';
  if(!value)return {text:'',locator:undefined};
  const terms=(query?.trim().split(/\s+/u).filter(Boolean)??[]).slice(0,12);
  const lowered=lower(value);
  let hit=-1,hitLength=0;
  for(const term of terms){const at=lowered.indexOf(lower(term));if(at>=0&&(hit<0||at<hit)){hit=at;hitLength=term.length;}}
  if(hit<0)return {text:value.slice(0,maxLength),locator:undefined};
  const radius=Math.max(40,Math.floor((maxLength-hitLength)/2));
  const start=Math.max(0,hit-radius),end=Math.min(value.length,start+maxLength);
  return {text:value.slice(start,end),locator:{offset:start,length:hitLength,totalLength:value.length}};
}

function recordOrigin(record:CaptureRecord):ContextOrigin {
  const scope=codingScope(record),p=record.provenance;
  return {source:record.source,deviceId:record.deviceId,appName:record.appName,capturedAt:record.capturedAt,receivedAt:record.receivedAt,
    ...(p?.sourceId?{sourceId:p.sourceId}:{}),...(scope?scope:{}),};
}

function matches(record:CaptureRecord,args:ContextQueryInput,requireText=false){
  const scope=codingScope(record),p=record.provenance;
  if(args.deviceId&&record.deviceId!==args.deviceId)return false;
  if(args.source&&record.source!==args.source)return false;
  if(args.appId&&record.appId!==args.appId)return false;
  if(args.after&&Date.parse(sourceContentTime(record))<Date.parse(args.after))return false;
  if(args.before&&Date.parse(sourceContentTime(record))>=Date.parse(args.before))return false;
  if(args.projectKey&&scope?.projectKey!==args.projectKey)return false;
  if(args.provider&&scope?.provider!==args.provider)return false;
  if(args.sessionId&&scope?.sessionId!==args.sessionId)return false;
  if(requireText&&args.query){
    const haystack=lower([searchableText(record),scope?.projectKey,scope?.sessionId,scope?.provider].filter(Boolean).join('\n'));
    for(const term of args.query.trim().split(/\s+/u).filter(Boolean).slice(0,12))if(!haystack.includes(lower(term)))return false;
  }
  if(p?.deleted)return false;
  return true;
}

function kind(record:CaptureRecord){
  if(record.provenance?.document?.coding)return 'conversation';
  if(record.source==='note')return 'note';
  if(record.source==='file')return 'file';
  return record.source;
}

function card(record:CaptureRecord,query?:string,extra?:Partial<ContextCard>):ContextCard {
  const scope=codingScope(record),body=record.ocrText||record.windowTitle||(record.metadata?.media?searchableText(record):record.appName);
  const match=snippet(body,query);
  const reasons:string[]=[];
  if(query)reasons.push(match.locator?'literal text match':'metadata or prefix match');
  if(scope?.projectKey)reasons.push(`projectKey=${scope.projectKey}`);
  if(scope?.sessionId)reasons.push(`sessionId=${scope.sessionId}`);
  return {ref:`capture:${record.id}`,id:record.id,kind:kind(record),title:record.windowTitle||record.appName||record.source,snippet:match.text,matchReasons:reasons,origin:recordOrigin(record),
    ...(record.provenance?.revision?{revision:record.provenance.revision}:{}),...(match.locator?{locator:match.locator}:{}),evidenceRefs:[record.id],...extra};
}

function pageCoverage(records:number,items:number,memories:number,sources:SourceConnection[],stats:{lastCaptureAt?:string|null},memoryLatestAt:string|null,truncated:boolean):ContextCoverage {
  return {recordsScanned:records,recordsReturned:items,memoriesScanned:memories,memoriesReturned:memories,originalLatestAt:stats.lastCaptureAt??null,memoryLatestAt,
    sourceStates:sources.map(source=>({id:source.id,name:source.name,state:source.status?.state??'unknown',...(source.status?.lastSyncAt?{lastSyncAt:source.status.lastSyncAt}:{})})),truncated};
}

export class ContextQuery {
  readonly memories:MemoryStore;
  constructor(private readonly store:Store,private readonly sources:SourceStore,private readonly files?:FileStore){this.memories=new MemoryStore(store,id=>this.evidence(id));}

  private evidence(ids:string[]){return [...this.store.evidence(ids),...(this.files?.evidence(ids)??[])];}
  private records(args:ContextQueryInput,queryRequired=false,innerCursor?:string|null){
    const limit=Math.min(MAX_SCAN,Math.max(boundLimit(args.limit)*4,50));
    const range={...args,limit,cursor:innerCursor??undefined};
    const searched=args.query&&queryRequired?this.store.searchPage({...range,query:args.query}):undefined;
    const listed=searched?undefined:this.store.list(range);
    const base=searched?.items??listed!.items;
    const fileRecords=args.query&&queryRequired?(this.files?.search({...range,query:args.query})??[]):[];
    const combined=[...base,...fileRecords].filter((record,index,array)=>array.findIndex(item=>item.id===record.id)===index).filter(record=>matches(record,args,!(!args.query||!queryRequired)));
    const pageLimit=boundLimit(args.limit),last=combined[pageLimit-1];
    const filteredCursor=searched&&!searched.nextCursor&&combined.length>pageLimit&&last?Buffer.from(JSON.stringify({t:new Date(sourceContentTime(last)).toISOString(),id:last.id})).toString('base64url'):null;
    return {items:combined,sourceCursor:searched?(searched.nextCursor??filteredCursor):listed!.nextCursor,scanned:base.length+fileRecords.length};
  }

  browse(raw:ContextQueryInput):ContextPage {
    const args={...raw,limit:boundLimit(raw.limit)},query=(()=>{const {cursor:_,...rest}=args;return {...rest,query:args.query??'',projectKey:args.projectKey??'',provider:args.provider??'',sessionId:args.sessionId??''};})();
    const cursor=decodeCursor(args.cursor,'browse',query),inner=cursor?.inner;
    const records=this.records(args,false,inner);
    const groups=new Map<string,{records:CaptureRecord[];scope?:CodingScope;source?:string}>();
    for(const record of records.items){
      const scope=codingScope(record),key=scope?`project:${scope.projectKey}`:record.provenance?.sourceId?`source:${record.provenance.sourceId}`:`source:${record.source}`;
      if(args.query&&!matches(record,args,true))continue;
      const group=groups.get(key)??{records:[],scope,source:record.provenance?.sourceId??record.source};group.records.push(record);groups.set(key,group);
    }
    const items=[...groups.entries()].sort((a,b)=>Date.parse(b[1].records[0]?.capturedAt??'')-Date.parse(a[1].records[0]?.capturedAt??'')||a[0].localeCompare(b[0])).slice(0,args.limit).map(([key,group])=>{
      const latest=group.records[0],scope=group.scope,refs=group.records.slice(0,20).map(r=>r.id),id=hashQuery([key,refs]);
      return {ref:`collection:${id}`,id:`collection-${id}`,kind:scope?'project-candidate':'source-collection',title:scope?.projectKey??group.source??key,snippet:`${group.records.length} related records; this is a query view, not a canonical project identity.`,matchReasons:[scope?'shared coding projectKey':'shared source kind','generated from current visible records'],origin:recordOrigin(latest),evidenceRefs:refs,applicability:'Candidate collection generated at query time; verify repository, branch, device and session before applying decisions.'} satisfies ContextCard;
    });
    const truncated=Boolean(records.sourceCursor)||groups.size>items.length;
    const sourceCursor=records.sourceCursor?encodeCursor({kind:'browse',hash:hashQuery(query),inner:records.sourceCursor}):null;
    const stats=this.store.stats() as {lastCaptureAt?:string|null};
    return {items,coverage:pageCoverage(records.scanned,items.length,0,this.sources.listSources(),stats,null,truncated),nextCursor:sourceCursor,truncated};
  }

  search(raw:ContextQueryInput):ContextPage {
    const args={...raw,limit:boundLimit(raw.limit)},query=(()=>{const {cursor:_,...rest}=args;return {...rest,query:args.query??'',projectKey:args.projectKey??'',provider:args.provider??'',sessionId:args.sessionId??''};})();
    const cursor=decodeCursor(args.cursor,'search',query);
    const records=this.records(args,Boolean(args.query),cursor?.inner);
    const items=records.items.slice(0,args.limit).map(record=>card(record,args.query));
    const truncated=records.items.length>items.length||Boolean(records.sourceCursor);
    const nextCursor=records.sourceCursor?encodeCursor({kind:'search',hash:hashQuery(query),inner:records.sourceCursor}):null;
    const stats=this.store.stats() as {lastCaptureAt?:string|null};
    return {items,coverage:pageCoverage(records.scanned,items.length,0,this.sources.listSources(),stats,null,truncated),nextCursor,truncated};
  }

  read(refs:string[],offset=0,length=4000):ContextReadPage {
    const result:ContextReadItem[]=[];const missing:string[]=[];
    for(const ref of refs.slice(0,50)){
      const raw=ref.startsWith('capture:')?ref.slice(8):ref;
      if(ref.startsWith('memory:')){
        try {const memory=this.memories.get(raw);const text=`${memory.title}\n\n${memory.statement}\n\nUncertainty: ${memory.uncertainty}`;const bounded=text.slice(offset,offset+length);result.push({ref,id:memory.id,kind:'memory',text:bounded,textRange:{offset,total:text.length,nextOffset:offset+bounded.length<text.length?offset+bounded.length:null},title:memory.title,evidenceRefs:memory.evidenceIds,status:memory.status,applicability:memory.coding?.applicability??memory.admission?.scope});} catch {missing.push(ref);}continue;
      }
      const record=this.evidence([raw])[0];if(!record){missing.push(ref);continue;}
      const text=record.ocrText||record.windowTitle||'';const bounded=text.slice(offset,offset+length);result.push({ref:`capture:${record.id}`,id:record.id,kind:kind(record),text:bounded,textRange:{offset,total:text.length,nextOffset:offset+bounded.length<text.length?offset+bounded.length:null},title:record.windowTitle||record.appName,origin:recordOrigin(record),evidenceRefs:[record.id]});
    }
    return {items:result,missingRefs:missing,truncated:refs.length>50};
  }

  context(raw:ContextQueryInput):ContextBundle {
    const args={...raw,limit:boundLimit(raw.limit),maxCharacters:Math.max(1000,Math.min(raw.maxCharacters??MAX_RESPONSE_CHARACTERS,MAX_RESPONSE_CHARACTERS))};
    const searchPage=this.search(args),memoryPage=args.includeMemories===false?{items:[],nextCursor:null}:{items:this.memories.page({query:args.query,status:'published',layer:'memory',includeStale:false,level:'detail',limit:args.limit}).items,nextCursor:null};
    const stableMemories=(memoryPage.items as Memory[]).filter(memory=>!args.projectKey||memory.scopeRefs?.some(scope=>scope.projectKey===args.projectKey)).map(memory=>cardFromMemory(memory));
    const recentRecords=searchPage.items.slice(0,args.limit);
    const recentSessions=args.includeRecentSessions===false?[]:this.sessionCards(recentRecords);
    let result:ContextBundle={stableMemories,recentSessions,recentRecords,coverage:{...searchPage.coverage,memoriesScanned:memoryPage.items.length,memoriesReturned:stableMemories.length,memoryLatestAt:stableMemories.map(item=>item.origin.capturedAt).sort().at(-1)??null},nextCursor:searchPage.nextCursor,truncated:searchPage.truncated};
    while(JSON.stringify(result).length>args.maxCharacters&&(result.recentRecords.length||result.stableMemories.length||result.recentSessions.length)){
      if(result.recentRecords.length)result.recentRecords.pop();else if(result.recentSessions.length)result.recentSessions.pop();else result.stableMemories.pop();
      result={...result,truncated:true};
    }
    return result;
  }

  private sessionCards(records:ContextCard[]):ContextCard[] {
    const map=new Map<string,ContextCard>();
    for(const record of records){const session=record.origin.sessionId;if(!session)continue;const prior=map.get(session);if(prior){prior.evidenceRefs=[...new Set([...prior.evidenceRefs,...record.evidenceRefs])].slice(0,20);continue;}map.set(session,{...record,ref:`session:${hashQuery([record.origin.projectKey,session])}`,id:`session-${hashQuery([record.origin.projectKey,session])}`,kind:'session',title:session,snippet:`Recent session for ${record.origin.projectKey??'an unscoped source'}.`,matchReasons:['same sessionId'],evidenceRefs:[...record.evidenceRefs]});}
    return [...map.values()];
  }

  status(){
    const stats=this.store.stats() as Record<string,unknown>,sources=this.sources.listSources();
    const latest=this.memories.page({level:'overview',limit:1,includeStale:true}).items[0] as {createdAt?:string}|undefined;
    return {archive:{captures:stats.captures??0,firstCaptureAt:stats.firstCaptureAt??null,lastCaptureAt:stats.lastCaptureAt??null,bytes:stats.bytes??0,logicalBytes:stats.logicalBytes??0},index:{counts:stats.indexing??[],mode:stats.indexing?'fts5-plus-optional-embeddings':'fts5'},memories:{latestAt:latest?.createdAt??null},sources:sources.map(source=>({id:source.id,name:source.name,kind:source.kind,enabled:source.enabled,state:source.status?.state??'unknown',lastSyncAt:source.status?.lastSyncAt??null})),limits:{maxItems:MAX_LIMIT,maxCharacters:MAX_RESPONSE_CHARACTERS}};
  }
}

function cardFromMemory(memory:Memory):ContextCard {
  const scope=memory.scopeRefs?.[0],capturedAt=memory.createdAt;
  return {ref:`memory:${memory.id}`,id:memory.id,kind:'memory',title:memory.title,snippet:memory.statement.slice(0,DEFAULT_SNIPPET),matchReasons:['published memory','evidence-linked'],origin:{source:'memory',deviceId:scope?.projectKey??'memory',appName:'Mote memory',capturedAt,receivedAt:capturedAt,...(scope??{})},evidenceRefs:memory.evidenceIds,status:memory.status,applicability:memory.coding?.applicability??memory.admission?.scope};
}
