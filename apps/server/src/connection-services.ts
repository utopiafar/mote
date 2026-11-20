import {createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {ConnectionJob,ServiceAction,ServiceItem,ServiceState,ServicesView,SourceConnection} from '@mote/shared';
import {bundledConnectors} from './bundled-connectors.js';
import type {Connections} from './connections.js';
import type {EvidenceStore as Store} from './evidence-store.js';

/** Read-only projection used by the Connections page. It never starts a
 * provider, changes source state or authorizes a page action: actions name the
 * existing owner operations, and the client must call those exact endpoints. */
export interface ConnectionServicesDependencies {
  readonly store:Pick<Store,'db'>;
  readonly connections:Pick<Connections,'inventory'>;
  readonly connectorConfig?:{readonly syncIntervalMs?:number};
  readonly now?:()=>number;
}

type BuildRecord={
  id:string;
  kind?:'native'|'package'|'instance';
  packageId?:string;
  desired?:unknown;
  observed?:string;
  blockers?:string[];
  package?:{view?:{state?:string};manifest?:PackageManifestView};
  instance?:{view?:{packageId?:string;desired?:boolean;observed?:string;issues?:string[];capabilities?:{id?:string;state?:string}[]}};
};
type PackageManifestView={
  id?:string;
  name?:string;
  sourceCatalog?:readonly {id?:string;title?:string;kinds?:readonly string[]}[];
  actionCapabilities?:readonly {id?:string}[];
};
type TokenView={id?:string;label?:string;scope?:string;revokedAt?:string;expiresAt?:string};

/** The connector source kinds are fixed by the built-in manifests. Unknown
 * kinds still get a card from their source rows, without a connector-owned
 * action or tool declaration. */
const builtinKinds:Readonly<Record<string,readonly string[]>>={
  gmail:['gmail'],
  'google-calendar':['google-calendar'],
  lark:['lark-docs','lark-calendar'],
  'feishu-recordings':['feishu.recordings'],
  'dingtalk-recordings':['dingtalk.recordings'],
};
/** Action capabilities actually declared by the built-in calendar connectors'
 * `actionProviders()`. They are not inferred from the connector name. */
const builtinTools:Readonly<Record<string,readonly string[]>>={
  'google-calendar':['calendar.manage'],
  lark:['calendar.manage'],
};
const aiScopes=new Set(['mcp-read','mcp-write','mcp-calendar']);
const controlChars=/[\u0000-\u001f\u007f]/;
const pageName=(value:string,max=80)=>{const text=value.replace(controlChars,' ').trim();return (text|| 'unknown').slice(0,max);};
const safeCount=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
const validTime=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:undefined;

function rows(store:Pick<Store,'db'>,sql:string){
  try{return store.db.prepare(sql).all() as {json:string}[];}catch{return [];}
}
function readSources(store:Pick<Store,'db'>):SourceConnection[]{
  return rows(store,'SELECT json FROM source_connections ORDER BY id').flatMap(row=>{
    try{return [JSON.parse(row.json) as SourceConnection];}catch{return [];}
  });
}
function readBuilds(store:Pick<Store,'db'>):BuildRecord[]{
  return rows(store,'SELECT json FROM plugin_build_instances ORDER BY rowid').flatMap(row=>{
    try{return [JSON.parse(row.json) as BuildRecord];}catch{return [];}
  });
}
function readPluginRevision(store:Pick<Store,'db'>){
  try{return Number((store.db.prepare('SELECT revision FROM plugin_center WHERE id=1').get() as {revision?:number}|undefined)?.revision??0);}catch{return 0;}
}
function everyLabel(intervalMs:number|undefined){
  if(!intervalMs||!Number.isFinite(intervalMs)||intervalMs<1000)return;
  const seconds=Math.round(intervalMs/1000);
  const label=seconds%60===0?`${seconds/60}m`:`${seconds}s`;
  return label.length<=40?label:undefined;
}
function jobsFor(serviceKinds:ReadonlySet<string>,sources:readonly SourceConnection[],enabled:boolean,every:string|undefined):ConnectionJob[]{
  if(!enabled)return [];
  const grouped=new Map<string,ConnectionJob>();
  for(const source of sources){
    if(!source.enabled||!serviceKinds.has(source.kind))continue;
    const kind=source.kind.slice(0,40);
    const lastAt=validTime(source.status?.lastSyncAt);
    const lastCount=safeCount(source.status?.coverage?.processed);
    const prior=grouped.get(kind);
    const next:ConnectionJob={kind,...(every?{every}:{}),...((lastAt??prior?.lastAt)?{lastAt:lastAt??prior!.lastAt}:{}),
      ...((lastCount!==undefined||prior?.lastCount!==undefined)?{lastCount:(prior?.lastCount??0)+(lastCount??0)}:{})};
    grouped.set(kind,next);
  }
  return [...grouped.values()].sort((left,right)=>left.kind.localeCompare(right.kind));
}
function actionsFor(kind:'service'|'ai-access',state:ServiceState):ServiceAction[]{
  if(kind==='ai-access')return state==='reauth'?['reauth','remove']:['remove'];
  if(state==='connected')return ['sync','dry-run','pause','remove'];
  if(state==='reauth')return ['reauth','remove'];
  if(state==='error')return ['reauth','sync','remove'];
  return ['resume','remove'];
}
function stateFor(sources:readonly SourceConnection[],enabled:boolean,blocked:boolean):ServiceState{
  if(!enabled)return 'paused';
  if(blocked)return 'error';
  if(sources.some(source=>source.status?.state==='permission_required'))return 'reauth';
  if(sources.some(source=>source.status?.state==='error'))return 'error';
  return 'connected';
}
function serviceItem(input:{id:string;name:string;state:ServiceState;kinds:ReadonlySet<string>;sources:readonly SourceConnection[];
  enabled:boolean;tools:readonly string[];every?:string;kind?:'service'|'ai-access'}):ServiceItem{
  const kind=input.kind??'service';
  const jobs=jobsFor(input.kinds,input.sources,input.enabled,input.every);
  return {
    id:input.id.slice(0,128),
    name:pageName(input.name,80),
    kind,
    state:input.state,
    jobs,
    tools:[...new Set(input.tools.map(tool=>tool.trim()).filter(Boolean))].slice(0,100).map(tool=>tool.slice(0,512)),
    actions:actionsFor(kind,input.state),
  };
}

/** Build the current owner-facing card list from durable state only. */
export function buildConnectionServices(dependencies:ConnectionServicesDependencies):ServicesView{
  const {store,connections,connectorConfig}=dependencies,now=dependencies.now?.()??Date.now();
  const sources=readSources(store),builds=readBuilds(store),every=everyLabel(connectorConfig?.syncIntervalMs);
  const usedKinds=new Set<string>(),services:ServiceItem[]=[];

  for(const catalog of bundledConnectors){
    const kinds=builtinKinds[catalog.id]??[],related=sources.filter(source=>kinds.includes(source.kind));
    if(!related.length)continue;
    kinds.forEach(kind=>usedKinds.add(kind));
    const record=builds.find(value=>value.id==='bundled:'+catalog.id);
    const enabled=record?Boolean(record.desired):true;
    const blocked=Boolean(record&&(record.observed==='blocked'||record.blockers?.length));
    const state=stateFor(related,enabled,blocked);
    services.push(serviceItem({id:catalog.id,name:catalog.name,state,kinds:new Set(kinds),sources:related,enabled,
      tools:state==='connected'?(builtinTools[catalog.id]??[]):[],...(every?{every}:{})}));
  }

  for(const record of builds){
    const manifest=record.kind==='package'?record.package?.manifest:undefined;
    if(!manifest?.sourceCatalog?.length)continue;
    const instances=builds.filter(value=>value.kind==='instance'&&value.instance?.view?.packageId===record.packageId);
    for(const entry of manifest.sourceCatalog){
      if(!entry.id||!entry.kinds?.length)continue;
      const related=sources.filter(source=>entry.kinds!.includes(source.kind));
      if(!related.length)continue;
      entry.kinds.forEach(kind=>usedKinds.add(kind));
      const enabled=instances.some(value=>value.instance?.view?.desired);
      const blocked=record.package?.view?.state==='failed'||instances.some(value=>value.instance?.view?.observed==='blocked'||Boolean(value.instance?.view?.issues?.length));
      const state=stateFor(related,enabled,blocked);
      const verified=new Set(instances.flatMap(value=>value.instance?.view?.capabilities?.flatMap(capability=>capability.state==='verified'&&capability.id?[capability.id]:[])??[]));
      const tools=state==='connected'&&enabled?(manifest.actionCapabilities??[]).flatMap(value=>value.id&&verified.has(value.id)?[value.id]:[]):[];
      services.push(serviceItem({id:entry.id,name:entry.title??entry.id,state,kinds:new Set(entry.kinds),sources:related,enabled,tools,
        ...(every?{every}:{})}));
    }
  }

  // A generated or installed connector can publish a source before its
  // connector build becomes visible here. Keep its durable job card instead of
  // guessing a name, tool list or action from the kind string.
  const unknownKinds=[...new Set(sources.map(source=>source.kind))].filter(kind=>!usedKinds.has(kind));
  for(const kind of unknownKinds.sort()){
    const related=sources.filter(source=>source.kind===kind),enabled=related.some(source=>source.enabled);
    const state=stateFor(related,enabled,false);
    services.push(serviceItem({id:kind,name:kind,state,kinds:new Set([kind]),sources:related,enabled,tools:[],...(every?{every}:{})}));
  }

  const tokens=(connections.inventory().items as TokenView[]).filter(token=>Boolean(token.id&&token.scope&&aiScopes.has(token.scope))&&!token.revokedAt);
  for(const token of tokens){
    const expired=Boolean(token.expiresAt&&Date.parse(token.expiresAt)<=now);
    services.push(serviceItem({id:token.id!,name:token.label??token.scope!,state:expired?'reauth':'connected',kinds:new Set(),sources:[],enabled:true,tools:[],kind:'ai-access'}));
  }

  const revision=createHash('sha256').update(JSON.stringify({
    control:readPluginRevision(store),
    services:services.map(service=>[service.id,service.kind,service.state,service.jobs,service.tools,service.actions]),
    sources:sources.map(source=>[source.id,source.enabled,source.status?.state??null,source.status?.lastSyncAt??null,source.status?.coverage?.processed??null,source.updatedAt]),
  })).digest('base64url');
  return {revision,services};
}

/** A dry run is a read of the last bounded fetch result. It never writes a
 * source item, queue row, status or credential. */
export function connectionServiceDryRun(view:ServicesView,id:string):{count:number}{
  const service=view.services.find(value=>value.id===id);
  if(!service||service.kind!=='service'||!service.actions.includes('dry-run'))throw Object.assign(Error('Connection service cannot run a dry run'),{statusCode:409});
  return {count:service.jobs.reduce((total,job)=>total+(job.lastCount??0),0)};
}

export function registerConnectionServiceRoutes(app:FastifyInstance,dependencies:ConnectionServicesDependencies){
  app.get('/api/connections/services',async(_request,reply)=>{
    reply.header('Cache-Control','no-store');
    return buildConnectionServices(dependencies);
  });
  app.post('/api/connections/services/:id/dry-run',async request=>{
    const id=(request.params as {id:string}).id;
    return connectionServiceDryRun(buildConnectionServices(dependencies),id);
  });
}
