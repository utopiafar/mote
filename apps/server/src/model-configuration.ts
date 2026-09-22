import {createHash} from 'node:crypto';
import type {ModelSettings} from '@mote/shared/models';
/** Public receipt only. Credentials affect identity but never leave the host as fields. */
export type ModelConfiguration=import('@mote/shared/models').ModelConfigurationReceipt;
export function modelConfiguration(profileId:string,settings:ModelSettings,revision:number):ModelConfiguration {
 const fingerprint=createHash('sha256').update(JSON.stringify({profileId,settings},(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)).digest('hex');
 return {owner:'models',fingerprint,revision,profileId,provider:settings.provider,model:settings.model};
}
