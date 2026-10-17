import {apiOwnerKey,type Api} from './api';
const key=(api:Api,id:string)=>api.connection?.mode==='web'?'mote.file-retry.v1:'+JSON.stringify([apiOwnerKey(api),id]):undefined;
/** Only the admitted command identity/options are retained, never original bytes,
 * credentials or a grant. M06 repeats current-source/unknown-result checks. */
export function readFileRetry(api:Api,id:string):string|undefined{
 const name=key(api,id);if(!name)return;const body=localStorage.getItem(name);if(!body)return;
 const value=JSON.parse(body);if(!value||typeof value!=='object'||typeof value.operationId!=='string'||!/^[a-f0-9-]{36}$/.test(value.operationId)||!['transcribe','diarize','summary'].includes(value.stage)||Object.keys(value).some(k=>!['operationId','stage','confirmUnknown','diarization'].includes(k)))throw Error('Invalid saved file retry');
 return body;
}
export function saveFileRetry(api:Api,id:string,body:string){const name=key(api,id);if(name)localStorage.setItem(name,body);}
export function clearFileRetry(api:Api,id:string,body:string){const name=key(api,id);if(name&&localStorage.getItem(name)===body)localStorage.removeItem(name);}
