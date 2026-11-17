import {readFileSync} from 'node:fs';
import type {ManifestContribution} from '@mote/plugin-api';
import type {CentralDomainPlugin} from '../domain-activation.js';
import {healthFeature} from '../features/system.js';

export const systemHealthContribution={id:'system-health',version:'1.0.0',surface:'data',runtime:'host'} as const satisfies ManifestContribution;
export const systemHealthDeclaration={id:systemHealthContribution.id,apiVersion:'1'} as const;

/** The selected build owns only liveness/version/protocol HTTP. No vault,
 * observer, timer or separate service container is needed by this surface. */
export const systemHealthPlugin=Object.freeze<CentralDomainPlugin>({
  contribution:systemHealthContribution,declaration:systemHealthDeclaration,replacement:'restart',
  activation:{featureId:'mote.system',requires:{},create(){
    // src/plugins and dist/plugins have the same path to this build's package.
    // Read only when selected; an omitted activation opens no factory input.
    const {version}=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')) as {version:string};
    return {route:healthFeature(version),prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
  }},
});

/** Domain-owned default selection, consumed directly by the distribution. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([systemHealthPlugin]);
