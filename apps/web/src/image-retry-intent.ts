import {apiOwnerKey,type Api} from './api';
const key=(api:Api,id:string)=>api.connection?.mode==='web'?'mote.image-retry.v1:'+JSON.stringify([apiOwnerKey(api),id]):undefined;
export function readImageRetry(api:Api,id:string):string|undefined{
 const name=key(api,id),body=name?localStorage.getItem(name):null;if(!body)return;
 const value=JSON.parse(body);
 if(!value||typeof value.operationId!=='string'||!/^[a-f0-9-]{36}$/.test(value.operationId)||!['complete','recompute'].includes(value.mode)||!/^[a-f0-9]{64}$/.test(value.proof)||typeof value.confirmUnknown!=='boolean'||Object.keys(value).some(k=>!['operationId','mode','proof','confirmUnknown'].includes(k)))throw Error('Invalid saved image retry');
 return body;
}
export function saveImageRetry(api:Api,id:string,body:string){const name=key(api,id);if(name)localStorage.setItem(name,body);}
export function clearImageRetry(api:Api,id:string,body:string){const name=key(api,id);if(name&&localStorage.getItem(name)===body)localStorage.removeItem(name);}
