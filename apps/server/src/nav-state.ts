import {createHash} from 'node:crypto';
import type {Context} from '@deepseek-ai/cordis';
import type {FastifyInstance} from 'fastify';
import type {StatementSync} from 'node:sqlite';
import type {NavRevisionKey,NavState} from '@mote/shared';
import type {EvidenceStore as Store} from './evidence-store.js';

type NavBadgeRead=()=>number|boolean;
type RevisionReader=()=>string;

/** Live badge readers owned by the features that can answer them. A stopped
 * feature removes its reader; a stale reader must never answer a newer app. */
const navBadges=new Map<string,NavBadgeRead>();

export function registerNavBadge(id:string,read:NavBadgeRead):()=>void{
  if(!id||typeof read!=='function')throw new TypeError('Invalid navigation badge');
  navBadges.set(id,read);
  let active=true;
  return ()=>{if(!active)return;active=false;if(navBadges.get(id)===read)navBadges.delete(id);};
}

const scalar=(statement:StatementSync):RevisionReader=>()=>String(Number((statement.get() as {value:number|bigint}).value));
const composite=(statement:StatementSync):RevisionReader=>()=>{
  const row=statement.get() as {count:number|bigint;total:number|bigint|null};
  return `${Number(row.count)}:${Number(row.total??0)}`;
};
const sourced=(statement:StatementSync):RevisionReader=>()=>{
  const row=statement.get() as {count:number|bigint;latest:string|null};
  return `${Number(row.count)}:${row.latest??''}`;
};

export interface NavStateDependencies {
  readonly store:Pick<Store,'db'>;
  readonly onError?:(error:unknown)=>void;
}

/** All revision reads are constant-cost aggregates. They never enumerate or
 * validate individual resource rows; the SQLite planner owns that cost. */
export class NavStateReader {
  private readonly revisions:readonly (readonly [NavRevisionKey,RevisionReader])[];
  private readonly connections:StatementSync;
  constructor(private readonly dependencies:NavStateDependencies){
    const db=dependencies.store.db;
    this.revisions=Object.freeze([
      ['library',scalar(db.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM changes'))],
      ['cards',composite(db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(revision),0) AS total FROM assistant_cards'))],
      ['commitments',composite(db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(revision),0) AS total FROM assistant_commitments'))],
      ['matters',composite(db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(revision),0) AS total FROM assistant_matters'))],
      ['memory',composite(db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(json_extract(json,'$.version')),0) AS total FROM memories"))],
      ['sources',sourced(db.prepare("SELECT COUNT(*) AS count,MAX(json_extract(json,'$.updatedAt')) AS latest FROM source_connections"))],
      ['plugins',scalar(db.prepare('SELECT COALESCE(MAX(revision),0) AS value FROM plugin_center WHERE id=1'))],
    ]);
    this.connections=db.prepare("SELECT EXISTS(SELECT 1 FROM source_connections WHERE COALESCE(json_extract(json,'$.enabled'),1)=1 AND json_extract(json,'$.status.state') IN ('permission_required','error')) AS value");
  }
  private report(error:unknown){try{this.dependencies.onError?.(error);}catch{/* A diagnostic observer cannot suppress the remaining badges. */}}
  private assign(badges:NavState['badges'],id:string,value:number|boolean){
    if(id==='ideas'&&typeof value!=='number')throw new TypeError('Ideas badge must be a count');
    if(id==='connections'&&typeof value!=='boolean')throw new TypeError('Connections badge must be a flag');
    if(typeof value==='boolean'||typeof value==='number'&&Number.isSafeInteger(value)&&value>=0){badges[id]=value;return;}
    throw new TypeError(`Invalid navigation badge value: ${id}`);
  }
  /** Read once per poll. A failing feature badge is omitted; the others stay
   * available so one plugin cannot blank the whole navigation. */
  read():{body:string;etag:string}{
    const revisions={} as Record<NavRevisionKey,string>;
    for(const [key,read] of this.revisions)revisions[key]=read();
    const badges=Object.create(null) as NavState['badges'];
    try{badges.connections=Boolean(Number((this.connections.get() as {value:number|bigint}).value));}
    catch(error){this.report(error);}
    for(const [id,read] of [...navBadges].sort(([left],[right])=>left.localeCompare(right))){
      if(id==='connections')continue;
      try{this.assign(badges,id,read());}
      catch(error){this.report(error);}
    }
    const body=JSON.stringify({revisions,badges});
    return {body,etag:`"${createHash('sha256').update(body).digest('base64url')}"`};
  }
}

export function createNavState(dependencies:NavStateDependencies){return new NavStateReader(dependencies);}

/** `features/index.ts` receives only the Cordis root, not host locals. Resolve
 * the selected storage foundation's published port instead of constructing a
 * second store; the contribution id is fixed for this build. */
function storagePortName(root:Context){
  for(const name of Object.keys(root.reflect.props)){
    if(!name.startsWith('motePluginPort:'))continue;
    try{
      const [provider]=JSON.parse(name.slice('motePluginPort:'.length)) as [{contributionId?:string}|undefined];
      if(provider?.contributionId==='mote.platform.storage')return name;
    }catch{
      // A declared non-port property may share the prefix; it is not a storage port.
    }
  }
}

export function navStateFromContext(root:Context,onError?:(error:unknown)=>void){
  const name=storagePortName(root);
  if(!name)return;
  const storage=root.get(name) as {store?:Pick<Store,'db'>}|undefined;
  if(!storage?.store?.db)return;
  return createNavState({store:storage.store,...(onError?{onError}:{})});
}

function ifNoneMatch(header:string|string[]|undefined,etag:string){
  const values=Array.isArray(header)?header:header===undefined?[]:[header];
  for(const value of values)for(const candidate of value.split(',')){
    const tag=candidate.trim();
    if(tag==='*'||tag===etag||tag===`W/${etag}`)return true;
  }
  return false;
}

/** Owner-only by construction: the Central owner hook authenticates every
 * `/api` route and rejects scoped Agent credentials before this handler. */
export function registerNavStateRoutes(app:FastifyInstance,navState:Pick<NavStateReader,'read'>){
  app.get('/api/nav-state',async(request,reply)=>{
    const value=navState.read();
    reply.header('Cache-Control','no-store').header('ETag',value.etag);
    if(ifNoneMatch(request.headers['if-none-match'],value.etag))return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(value.body);
  });
}
