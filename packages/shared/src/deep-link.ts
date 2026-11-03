import {connectionServerUrl} from './connection.js';
import {parseEvidenceId,parseEvidenceRef,formatEvidenceRef,parseArtifactRef} from './evidence-ref.js';

/** Instance scope one deep link is bound to: the canonical origin of the
 * central node that owns the addressed state. Mote keeps one instance per
 * owner, so the origin is the whole owner/instance scope. */
export interface MoteLinkScope {
  readonly origin:string;
}

/** A plugin-contributed native view route. The pinned reference stays on the
 * route so an unknown or deactivated view still resolves into the generic
 * reader for the same object instead of vanishing. */
export interface MoteViewRoute {
  readonly packageId:string;
  readonly routeId:string;
  readonly ref:string;
}

/** The addressable committed state of one instance. Deep links carry route
 * data only — never credentials, tokens, drafts or body text — and
 * uncommitted drafts stay under each end's local scope policy. */
export type MoteRoute =
  | {readonly kind:'conversation';readonly id:string}
  | {readonly kind:'run';readonly id:string}
  | {readonly kind:'reference';readonly ref:string;readonly conversation?:string}
  | {readonly kind:'view';readonly view:MoteViewRoute};

export interface MoteLink {
  readonly scope:MoteLinkScope;
  readonly route:MoteRoute;
}

/** Facts the resolving end contributes: which instance is answering, which
 * plugin routes are registered right now, whether access is still granted
 * and whether the addressed record still exists. */
export interface MoteLinkFacts {
  readonly origin:string;
  readonly knownRoute?:(view:MoteViewRoute)=>boolean;
  readonly granted?:boolean;
  readonly exists?:boolean;
}

/** Resolution either keeps the exact route, falls back to the generic reader
 * for the same pinned reference, or refuses the link without retargeting. */
export type MoteLinkResolution =
  | {readonly status:'route';readonly route:MoteRoute}
  | {readonly status:'reader';readonly ref:string}
  | {readonly status:'foreign-scope'}
  | {readonly status:'denied'}
  | {readonly status:'missing'};

/** Typed public references shared by all three ends: capture and memory
 * originals, material snapshots and revision-pinned artifacts. */
export function parseMoteReference(value:unknown):string|undefined {
  if(typeof value!=='string'||value.length>1600)return;
  const trimmed=value.trim();
  const parsed=parseEvidenceRef(trimmed);
  if(parsed)return formatEvidenceRef(parsed.kind,parsed.id);
  if(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/.test(trimmed))return trimmed;
  const artifact=parseArtifactRef(trimmed);
  return artifact?trimmed:undefined;
}

/** Run (work) identities are opaque server ids: non-blank text without
 * control characters, bounded so a link cannot smuggle oversized data. */
export function isMoteRunId(value:unknown):value is string {
  return typeof value==='string'&&value.trim().length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
}

function token(value:unknown):value is string {
  return typeof value==='string'&&/^[\x21-\x7e]{1,256}$/.test(value);
}

/** Validate a route before serialization; invalid identity throws instead of
 * producing a link that would parse to a different object elsewhere. */
export function moteRoute(route:MoteRoute):MoteRoute {
  switch(route.kind){
    case 'conversation':if(!parseEvidenceId(route.id))break;return route;
    case 'run':if(!isMoteRunId(route.id))break;return route;
    case 'reference':if(parseMoteReference(route.ref)!==route.ref||(route.conversation!==undefined&&!parseEvidenceId(route.conversation)))break;return route;
    case 'view':if(!token(route.view.packageId)||!token(route.view.routeId)||parseMoteReference(route.view.ref)!==route.view.ref)break;return route;
  }
  throw new TypeError('Invalid Mote route');
}

function params(entries:Record<string,string>):string {
  return new URLSearchParams(entries).toString();
}

/** Canonical hash form consumed by the central web surface; the same
 * vocabulary every end emits inside a serialized link. */
export function deepLinkHash(route:MoteRoute):string {
  const checked=moteRoute(route);
  switch(checked.kind){
    case 'conversation':return '#/ask?'+params({conversation:checked.id});
    case 'run':return '#/activity?'+params({work:checked.id});
    case 'reference':return '#/ask?'+params(checked.conversation?{evidence:checked.ref,conversation:checked.conversation}:{evidence:checked.ref});
    case 'view':return '#/view?'+params({package:checked.view.packageId,route:checked.view.routeId,evidence:checked.view.ref});
  }
}

/** Parse the canonical hash vocabulary. Defining keys must appear once and be
 * well formed; transport extras such as login tickets may ride along and are
 * not part of the route identity. */
export function parseDeepLinkHash(hash:unknown):MoteRoute|undefined {
  if(typeof hash!=='string'||!hash.startsWith('#'))return;
  let target=hash.slice(1);
  if(target&&!target.startsWith('/'))target='/'+target;
  const at=target.indexOf('?'),path=at<0?target:target.slice(0,at);
  const query=new URLSearchParams(at<0?'':target.slice(at+1));
  if(query.getAll('evidence').length>1||query.getAll('conversation').length>1||query.getAll('work').length>1||query.getAll('package').length>1||query.getAll('route').length>1)return;
  const evidence=query.get('evidence'),conversation=query.get('conversation');
  switch(path){
    case '/ask':
      if(evidence!==null){
        const ref=parseMoteReference(evidence);
        if(!ref)return;
        if(conversation!==null){const id=parseEvidenceId(conversation);return id?{kind:'reference',ref,conversation:id}:undefined;}
        return {kind:'reference',ref};
      }
      if(conversation!==null){const id=parseEvidenceId(conversation);return id?{kind:'conversation',id}:undefined;}
      return;
    case '/activity':{
      const work=query.get('work');
      return isMoteRunId(work)?{kind:'run',id:work}:undefined;
    }
    case '/view':{
      const packageId=query.get('package'),routeId=query.get('route');
      if(!token(packageId)||!token(routeId)||evidence===null)return;
      const ref=parseMoteReference(evidence);
      return ref?{kind:'view',view:{packageId,routeId,ref}}:undefined;
    }
  }
}

function canonicalOrigin(value:unknown):string|undefined {
  if(typeof value!=='string')return;
  try{return connectionServerUrl(value);}catch{return;}
}

/** Serialize one scope-bound link: a canonical https (or loopback http)
 * origin followed by the shared hash vocabulary. */
export function serializeMoteLink(scope:MoteLinkScope,route:MoteRoute):string {
  const origin=canonicalOrigin(scope.origin);
  if(!origin)throw new TypeError('Mote links need an https or loopback http origin');
  return origin+'/'+deepLinkHash(route);
}

/** Strictly parse a serialized link: canonical origin, root path, no query
 * outside the hash and a well formed route. Anything else returns undefined
 * rather than guessing at another object. */
export function parseMoteLink(input:unknown):MoteLink|undefined {
  if(typeof input!=='string'||input.trim()!==input||input.length>2048)return;
  let url:URL;
  try{url=new URL(input);}catch{return;}
  const origin=canonicalOrigin(url.origin);
  if(!origin||url.origin!==origin||url.pathname!=='/'||url.search!==''||url.username!==''||url.password!=='')return;
  const route=parseDeepLinkHash(url.hash);
  return route?{scope:{origin},route}:undefined;
}

/** Resolve a parsed link against the answering end's live registries. Scope
 * mismatch stays foreign, revoked access carries no route or reference, a
 * deleted record stays missing, and an unknown or deactivated plugin view
 * falls back to the generic reader for the same pinned reference. */
export function resolveMoteLink(link:MoteLink,facts:MoteLinkFacts):MoteLinkResolution {
  if(canonicalOrigin(facts.origin)!==link.scope.origin)return{status:'foreign-scope'};
  if(facts.granted===false)return{status:'denied'};
  if(facts.exists===false)return{status:'missing'};
  const {route}=link;
  if(route.kind==='view'&&facts.knownRoute&&!facts.knownRoute(route.view))return{status:'reader',ref:route.view.ref};
  return{status:'route',route};
}
