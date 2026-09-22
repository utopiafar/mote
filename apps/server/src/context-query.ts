import {navigationScope,navigationRef,parseNavigationRef,intersectNavigationScope,type NavigationExpansion} from './context-navigation.js';
import {createHash} from 'node:crypto';
import {sourceContentTime,formatEvidenceRef,parseArtifactRef,type CaptureRecord,type SourceConnection} from '@mote/shared';
import type {FileStore} from './files.js';
import {type MemoryStore,type Memory} from './memory.js';
import {EvidenceReader,parseEvidenceRef} from './evidence-reader.js';
import type {SourceStore} from './sources.js';
import type {Store} from './store.js';
import {StoreError,type Range} from './store.js';

export type ContextQueryInput = Range & {
  query?:string;
  projectKey?:string;
  repositoryKey?:string;
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
  repositoryKey?:string;
  projectName?:string;
  branch?:string;
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
  expansion?:NavigationExpansion;
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
  evidenceCount?:number;
  evidenceRefsTruncated?:boolean;
  expansion?:NavigationExpansion;
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

type CodingScope={provider:'claude'|'codex'|'kimi';sessionId:string;projectKey:string;repositoryKey?:string;projectName?:string;branch?:string};
type Cursor={kind:'browse'|'search';hash:string;inner?:string|null};
const position=(r:CaptureRecord)=>Buffer.from(JSON.stringify({t:new Date(sourceContentTime(r)).toISOString(),id:r.id})).toString('base64url');

const MAX_SCAN=200;
const DEFAULT_LIMIT=20;
const MAX_LIMIT=100;
const DEFAULT_SNIPPET=400;
const MAX_RESPONSE_CHARACTERS=16000;

function codingScope(record:CaptureRecord):CodingScope|undefined {
  const value=record.provenance?.document?.coding;
  return value?{provider:value.provider,sessionId:value.sessionId,projectKey:value.projectKey,...(value.repositoryKey?{repositoryKey:value.repositoryKey}:{}),...(value.projectName?{projectName:value.projectName}:{}),...(value.branch?{branch:value.branch}:{})}:undefined;
}

function hashQuery(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);}
function encodeCursor(value:Cursor){const {inner,...rest}=value;return Buffer.from(JSON.stringify({...rest,...(inner?{position:JSON.parse(Buffer.from(inner,'base64url').toString())}:{})})).toString('base64url');}
function decodeCursor(value:string|undefined,kind:'browse'|'search',query:unknown):Cursor|undefined {
  if(!value)return;
  try {
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString()) as Cursor;
    if(parsed.kind!==kind||parsed.hash!==hashQuery(query))throw Error();
    const position=(parsed as Cursor & {position?:unknown}).position;
    return {...parsed,...(position?{inner:Buffer.from(JSON.stringify(position)).toString('base64url')}:{})};
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
  if(requireText&&args.query){
    const haystack=lower([searchableText(record),scope?.projectKey,scope?.projectName,scope?.repositoryKey,scope?.sessionId,scope?.provider].filter(Boolean).join('\n'));
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
  return {ref:formatEvidenceRef('capture',record.id),id:record.id,kind:kind(record),title:(record.windowTitle||record.appName||record.source).slice(0,200),snippet:match.text,matchReasons:reasons,origin:recordOrigin(record),
    ...(record.provenance?.revision?{revision:record.provenance.revision}:{}),...(match.locator?{locator:match.locator}:{}),evidenceRefs:[record.id],...extra};
}

function pageCoverage(records:number,items:number,memories:number,sources:SourceConnection[],stats:{lastCaptureAt?:string|null},memoryLatestAt:string|null,truncated:boolean):ContextCoverage {
  return {recordsScanned:records,recordsReturned:items,memoriesScanned:memories,memoriesReturned:memories,originalLatestAt:stats.lastCaptureAt??null,memoryLatestAt,
    sourceStates:sources.map(source=>({id:source.id,name:source.name,state:source.status?.state??'unknown',...(source.status?.lastSyncAt?{lastSyncAt:source.status.lastSyncAt}:{})})),truncated};
}

export class ContextQuery {
  readonly memories:MemoryStore;
  readonly reader:EvidenceReader;
  constructor(private readonly store:Store,private readonly sources:SourceStore,private readonly files?:FileStore,reader?:EvidenceReader){this.reader=reader??new EvidenceReader(store,sources,files);this.memories=this.reader.memories;}

  private records(args:ContextQueryInput,queryRequired=false,innerCursor?:string|null,scanLimit=MAX_SCAN){
    return this.reader.records({...args,limit:Math.min(MAX_SCAN,scanLimit),cursor:innerCursor??undefined},queryRequired);
  }

  private page(raw:ContextQueryInput,mode:'browse'|'search'):ContextPage {
    const args={...raw,limit:boundLimit(raw.limit)}, {cursor:_,limit:_limit,maxCharacters:_max,includeRecentSessions:_sessions,includeMemories:_memory,...query}=args;
    const cursor=decodeCursor(args.cursor,mode,query),records=this.records(args,mode==='search'&&Boolean(args.query),cursor?.inner,mode==='search'?args.limit+1:MAX_SCAN);
    const max=Math.max(1000,Math.min(raw.maxCharacters??MAX_RESPONSE_CHARACTERS,MAX_RESPONSE_CHARACTERS));
    const items:ContextCard[]=[],groups=new Map<string,ContextCard>();let consumed:CaptureRecord|undefined,stopped=false;
    const makeCursor=()=>consumed?encodeCursor({kind:mode,hash:hashQuery(query),inner:position(consumed)}):raw.cursor??null;
    const result:ContextPage={items,coverage:pageCoverage(records.scanned,0,0,[],this.store.stats() as {lastCaptureAt?:string|null},null,false),nextCursor:null,truncated:false};
    for(const record of records.items){
      if(!matches(record,args,mode==='browse'&&Boolean(args.query))){consumed=record;continue;}
      const scope=codingScope(record),key=scope?`project:${hashQuery([record.provenance?.sourceId,record.deviceId,scope.provider,scope.projectKey])}`:`source:${record.provenance?.sourceId??record.source}`;
      // Collection references are navigation objects, never unreadable evidence IDs.
      if(mode==='browse'&&groups.has(key)){consumed=record;continue;}
      if(items.length>=args.limit){stopped=true;break;}
      const item=card(record,args.query);
      if(mode==='browse'){
        Object.assign(item,{ref:`collection:${hashQuery([key,record.id])}`,kind:scope?'project-candidate':'source-collection',title:scope?.projectName??scope?.projectKey??record.provenance?.sourceId??record.source,snippet:'Related records; this is a query view, not a canonical project identity.',expansion:{kind:'search',scope:{...(scope?{sourceId:record.provenance?.sourceId,deviceId:record.deviceId,provider:scope.provider,projectKey:scope.projectKey}:record.provenance?.sourceId?{sourceId:record.provenance.sourceId}:{source:record.source}),...(raw.deviceId?{deviceId:raw.deviceId}:{}),...(raw.repositoryKey?{repositoryKey:raw.repositoryKey}:{}),...(raw.after?{after:raw.after}:{}),...(raw.before?{before:raw.before}:{})},refs:[item.ref]}});
      }
      if(item.expansion){
        item.expansion.scope=navigationScope({...raw,...item.expansion.scope});
        item.ref=navigationRef('collection',record.id,item.expansion.scope);
      }
      const previous=consumed;consumed=record;items.push(item);result.nextCursor=makeCursor();result.coverage.recordsReturned=items.length;
      if(JSON.stringify(result).length>max-16){
        if(items.length===1){item.snippet=item.snippet.slice(0,40);item.title=item.title.slice(0,40);item.matchReasons=[];delete item.locator;item.evidenceRefs=[];}
        if(JSON.stringify(result).length>max-16){items.pop();consumed=previous;stopped=true;break;}
      }
      if(mode==='browse')groups.set(key,item);
    }
    result.truncated=stopped||records.more;
    result.nextCursor=result.truncated?makeCursor():null;
    result.coverage.recordsReturned=items.length;result.coverage.truncated=result.truncated;
    if(!items.length&&stopped&&!consumed)throw new StoreError('Context response budget too small for one card',413);
    return result;
  }

  browse(raw:ContextQueryInput):ContextPage {return this.page(raw,'browse');}
  search(raw:ContextQueryInput):ContextPage {return this.page(raw,'search');}

  /** Ranked retrieval shares the Agent's optional-vector/lexical fallback path. */
  async retrieve(raw:ContextQueryInput){
    if(raw.cursor)throw new StoreError('Ranked retrieval does not accept pagination cursors');
    const rows=await this.reader.search({...raw,limit:boundLimit(raw.limit)}),max=Math.max(1000,Math.min(raw.maxCharacters??MAX_RESPONSE_CHARACTERS,MAX_RESPONSE_CHARACTERS));
    const page={items:[] as ContextCard[],retrieval:rows.retrieval,truncated:rows.length>=boundLimit(raw.limit)};
    for(const row of rows){
      page.items.push(card(row,raw.query));
      if(JSON.stringify(page).length>max||Buffer.byteLength(JSON.stringify(page))>65536){page.items.pop();page.truncated=true;break;}
    }
    if(rows.length&&!page.items.length)throw new StoreError('Context response budget too small for one card',413);
    return page;
  }

  read(refs:string[],offset=0,length=4000,scope:Range={}):ContextReadPage {
    const result:ContextReadItem[]=[];const missing:string[]=[];
    let remaining=12000;
    offset=Math.max(0,Math.floor(offset));length=Math.max(1,Math.min(4000,Math.floor(length)));
    for(const ref of refs.slice(0,5)){
      const take=Math.min(length,Math.floor(remaining/(Math.min(refs.length,5)-result.length-missing.length)));
      const navigation=parseNavigationRef(ref);
      if(navigation){
        const narrowed=intersectNavigationScope(navigation.scope,scope),record=narrowed?this.reader.evidence([navigation.anchor],narrowed)[0]:undefined;
        if(!record||!narrowed){missing.push(ref);continue;}
        result.push({ref,id:ref,kind:navigation.kind,text:'',textRange:{offset:0,total:0,nextOffset:null},expansion:{kind:'search',scope:navigationScope(narrowed),refs:[navigation.anchor]}});
        continue;
      }
      if(parseArtifactRef(ref)){
        const artifact=this.reader.artifact(ref,scope);if(!artifact){missing.push(ref);continue;}
        const text=artifact.text.slice(offset,offset+take);remaining-=text.length;
        result.push({ref:artifact.ref,id:artifact.id,kind:'artifact',text,textRange:{offset,total:artifact.text.length,nextOffset:offset+text.length<artifact.text.length?offset+text.length:null},evidenceRefs:artifact.members.slice(0,30),evidenceCount:artifact.members.length,evidenceRefsTruncated:artifact.members.length>30});
        continue;
      }
      const parsed=parseEvidenceRef(ref);if(!parsed){missing.push(ref);continue;}const raw=parsed.id;
      if(parsed.kind==='memory'){
        try {const memory=this.reader.memory(ref,scope);if(!memory){missing.push(ref);continue;}const text=`${memory.title}\n\n${memory.statement}\n\nUncertainty: ${memory.uncertainty}`;const bounded=text.slice(offset,offset+take);remaining-=bounded.length;result.push({ref:formatEvidenceRef('memory',memory.id),id:memory.id,kind:'memory',text:bounded,textRange:{offset,total:text.length,nextOffset:offset+bounded.length<text.length?offset+bounded.length:null},title:memory.title,evidenceRefs:memory.evidenceIds,status:memory.status,applicability:memory.coding?.applicability??memory.admission?.scope});} catch {missing.push(ref);}continue;
      }
      const record=this.reader.evidence([raw],scope)[0];if(!record){missing.push(ref);continue;}
      const text=record.ocrText||record.windowTitle||'';const bounded=text.slice(offset,offset+take);remaining-=bounded.length;result.push({ref:formatEvidenceRef('capture',record.id),id:record.id,kind:kind(record),text:bounded,textRange:{offset,total:text.length,nextOffset:offset+bounded.length<text.length?offset+bounded.length:null},title:record.windowTitle||record.appName,origin:recordOrigin(record),evidenceRefs:[record.id]});
    }
    const page={items:result,missingRefs:missing,truncated:refs.length>5};
    // Metadata counts too. Preserve a resumable text offset for every shortened item.
    for(const item of [...result].reverse()){
      const excess=Math.max(JSON.stringify(page).length-MAX_RESPONSE_CHARACTERS,Math.ceil((Buffer.byteLength(JSON.stringify(page))-65536)/2));
      if(excess<=0)break;
      item.text=item.text.slice(0,Math.max(0,item.text.length-excess-64));item.textRange.nextOffset=item.textRange.offset+item.text.length<item.textRange.total?item.textRange.offset+item.text.length:null;page.truncated=true;
    }
    if(JSON.stringify(page).length>MAX_RESPONSE_CHARACTERS||Buffer.byteLength(JSON.stringify(page))>65536)throw new StoreError('Context metadata exceeds response budget; read fewer references',413);
    return page;
  }

  context(raw:ContextQueryInput):ContextBundle {
    const {cursor:_,limit:_limit,maxCharacters:_max,...scope}=raw,hash=hashQuery(scope),max=Math.max(1000,Math.min(raw.maxCharacters??MAX_RESPONSE_CHARACTERS,MAX_RESPONSE_CHARACTERS));
    type Position={kind:'context';hash:string;records?:string|null;memories?:string|null};
    let position:Position={kind:'context',hash};
    if(raw.cursor){try{position=JSON.parse(Buffer.from(raw.cursor,'base64url').toString());if(position.kind!=='context'||position.hash!==hash)throw Error();}catch{throw new StoreError('Invalid context cursor');}}
    const base:ContextBundle={stableMemories:[],recentSessions:[],recentRecords:[],coverage:pageCoverage(0,0,0,[],this.store.stats() as {lastCaptureAt?:string|null},null,false),nextCursor:null,truncated:false};
    const next:Position={...position};let total=0,budgetStopped=false;
    // Each item advances only its own channel. No hidden item can be skipped by a presentation trim.
    for(const channel of ['memories','records'] as const){
      if(next[channel]===null||channel==='memories'&&raw.includeMemories===false){next[channel]=null;continue;}
      for(let n=0;n<boundLimit(raw.limit)&&total<boundLimit(raw.limit);n++){
        let item:ContextCard|undefined,cursor:string|null;
        if(channel==='records'){
          const page=this.search({...raw,cursor:next.records??undefined,limit:1,maxCharacters:max});item=page.items[0];cursor=page.nextCursor;base.coverage.recordsScanned+=page.coverage.recordsScanned;
        }else{
          const page=this.reader.memoryPage({...raw,cursor:next.memories??undefined,status:'published',layer:'memory',includeStale:false,level:'detail',limit:1});item=page.items[0]?cardFromMemory(page.items[0]):undefined;cursor=page.nextCursor;base.coverage.memoriesScanned+=page.items.length;
        }
        if(!item){next[channel]=cursor;if(!cursor)break;continue;}
        const items=channel==='records'?base.recentRecords:base.stableMemories;items.push(item);
        const candidate={...next,[channel]:cursor};base.nextCursor=Buffer.from(JSON.stringify(candidate)).toString('base64url');
        if(JSON.stringify(base).length>max-32){items.pop();budgetStopped=true;break;}
        next[channel]=cursor;total++;if(!cursor)break;
      }
    }
    base.nextCursor=next.records!==null||next.memories!==null?Buffer.from(JSON.stringify(next)).toString('base64url'):null;
    base.truncated=Boolean(base.nextCursor);base.coverage.recordsReturned=base.recentRecords.length;base.coverage.memoriesReturned=base.stableMemories.length;base.coverage.truncated=base.truncated;
    if(raw.includeRecentSessions!==false)for(const session of this.sessionCards(base.recentRecords,raw)){base.recentSessions.push(session);if(JSON.stringify(base).length>max){base.recentSessions.pop();break;}}
    if(!total&&budgetStopped)throw new StoreError('Context response budget too small for one item',413);
    return base;
  }

  private sessionCards(records:ContextCard[],scope:ContextQueryInput):ContextCard[] {
    const map=new Map<string,ContextCard>();
    for(const record of records){const session=record.origin.sessionId;if(!session)continue;const identity=hashQuery([record.origin.sourceId,record.origin.deviceId,record.origin.provider,record.origin.projectKey,session]);const prior=map.get(identity);if(prior){prior.evidenceRefs=[...new Set([...prior.evidenceRefs,...record.evidenceRefs])].slice(0,20);continue;}map.set(identity,{...record,ref:`session:${identity}`,id:`session-${identity}`,expansion:{kind:'search',scope:{sourceId:record.origin.sourceId,deviceId:record.origin.deviceId,provider:record.origin.provider,projectKey:record.origin.projectKey,sessionId:session},refs:[record.ref]},kind:'session',title:session,snippet:`Recent session for ${record.origin.projectKey??'an unscoped source'}.`,matchReasons:['same sessionId'],evidenceRefs:[...record.evidenceRefs]});}
    return [...map.values()].map(item=>{item.expansion!.scope=navigationScope({...scope,...item.expansion!.scope});item.ref=navigationRef('session',item.expansion!.refs[0],item.expansion!.scope);return item;});
  }

  status(){
    const stats=this.store.stats() as Record<string,unknown>,sources=this.sources.listSources();
    const latest=this.memories.page({level:'overview',limit:1,includeStale:true}).items[0] as {createdAt?:string}|undefined;
    return {archive:{captures:stats.captures??0,firstCaptureAt:stats.firstCaptureAt??null,lastCaptureAt:stats.lastCaptureAt??null,bytes:stats.bytes??0,logicalBytes:stats.logicalBytes??0},index:{counts:stats.indexing??[],mode:stats.indexing?'fts5-plus-optional-embeddings':'fts5'},memories:{latestAt:latest?.createdAt??null},sources:sources.map(source=>({id:source.id,name:source.name,kind:source.kind,enabled:source.enabled,state:source.status?.state??'unknown',lastSyncAt:source.status?.lastSyncAt??null})),limits:{maxItems:MAX_LIMIT,maxCharacters:MAX_RESPONSE_CHARACTERS}};
  }
}

function cardFromMemory(memory:Memory):ContextCard {
  const scope=memory.scopeRefs?.[0],capturedAt=memory.createdAt;
  return {ref:formatEvidenceRef('memory',memory.id),id:memory.id,kind:'memory',title:memory.title,snippet:memory.statement.slice(0,DEFAULT_SNIPPET),matchReasons:['published memory','evidence-linked'],origin:{source:'memory',deviceId:scope?.deviceId??'memory',appName:'Mote memory',capturedAt,receivedAt:capturedAt,...(scope??{})},evidenceRefs:memory.evidenceIds,status:memory.status,applicability:memory.coding?.applicability??memory.admission?.scope};
}
