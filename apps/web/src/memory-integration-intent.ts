import {apiOwnerKey,type Api} from './api';
export type IntegrationIntent={operationId:string;recipe:{id:string;version:string};inputs:{id:string;version:number;fingerprint:string}[]};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const memoryIntegrationIntentKey=(api:Api)=>'mote.memory-integration.v1:'+apiOwnerKey(api);
/** Only an explicit command identity and exact selection pins survive reload.
 * No Memory body, credentials, provider binding or execution grant is retained. */
export function readIntegrationIntent(api:Api):IntegrationIntent|undefined{
 const raw=localStorage.getItem(memoryIntegrationIntentKey(api));if(!raw)return;
 const value=JSON.parse(raw);if(!value||typeof value!=='object'||!uuid.test(value.operationId)||Object.keys(value).sort().join(',')!=='inputs,operationId,recipe'||!value.recipe||Object.keys(value.recipe).sort().join(',')!=='id,version'||typeof value.recipe.id!=='string'||typeof value.recipe.version!=='string'||!Array.isArray(value.inputs)||!value.inputs.length||value.inputs.length>50||value.inputs.some((pin:any)=>!pin||Object.keys(pin).sort().join(',')!=='fingerprint,id,version'||!uuid.test(pin.id)||!Number.isSafeInteger(pin.version)||pin.version<1||typeof pin.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(pin.fingerprint))||new Set(value.inputs.map((pin:any)=>pin.id)).size!==value.inputs.length)throw Error('Invalid saved Memory integration');return value;
}
export function saveIntegrationIntent(api:Api,intent:IntegrationIntent){localStorage.setItem(memoryIntegrationIntentKey(api),JSON.stringify(intent));}
