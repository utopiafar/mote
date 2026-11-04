import {deepLinkHash,resolveMoteLink,type MoteLink,type MoteLinkFacts,type MoteLinkResolution} from '@mote/shared';

export type DesktopDeepLinkTarget =
  | {readonly status:'open';readonly url:string}
  | {readonly status:'foreign-scope'|'denied'|'missing'};

/** Desktop serves no plugin view routes yet, so an addressed view always
 * resolves into the generic reader for its pinned reference. The open URL is
 * built from the shared hash vocabulary and never carries credentials. */
export function desktopDeepLinkTarget(link:MoteLink,origin:string,facts:Pick<MoteLinkFacts,'granted'|'exists'>={}):DesktopDeepLinkTarget {
  const resolution:MoteLinkResolution=resolveMoteLink(link,{...facts,origin,knownRoute:()=>false});
  if(resolution.status==='route')return{status:'open',url:link.scope.origin+'/'+deepLinkHash(resolution.route)};
  if(resolution.status==='reader')return{status:'open',url:link.scope.origin+'/'+deepLinkHash({kind:'reference',ref:resolution.ref})};
  return{status:resolution.status};
}
