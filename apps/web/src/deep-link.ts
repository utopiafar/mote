import {parseMoteLink,resolveMoteLink,type MoteLink,type MoteLinkFacts,type MoteLinkResolution,type MoteViewRoute} from '@mote/shared';
import {webFeatures} from './features/registry';

/** The page entry id a plugin-contributed view registered under, if this
 * build serves that route. Checked live so a deactivated contribution falls
 * back instead of staying bound. */
export function webViewPage(view:MoteViewRoute):string|undefined {
  return webFeatures.page(view.routeId)?.id;
}

/** Parse one serialized link; the shared schema rejects every URL shape that
 * is not a canonical scope origin plus hash route vocabulary. */
export function webDeepLink(input:unknown):MoteLink|undefined {
  return parseMoteLink(input);
}

/** Resolve a parsed link against this build's registries: a foreign scope
 * stays foreign, revoked access resolves denied and an unregistered plugin
 * view lands on the generic reader for the pinned reference. */
export function resolveWebDeepLink(link:MoteLink,facts:MoteLinkFacts):MoteLinkResolution {
  return resolveMoteLink(link,{...facts,knownRoute:facts.knownRoute??(view=>webViewPage(view)!==undefined)});
}
