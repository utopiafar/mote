import {sha256} from './store.js';

export const uiPageCaptureSource=(deviceId:string)=>'ui-page:'+sha256(JSON.stringify(deviceId));
/** Source identity is a transport contract, never a content classifier. */
export function isCaptureMemorySource(sourceId:string,deviceId:unknown){
  if(typeof deviceId!=='string')return false;
  const hash=sha256(JSON.stringify(deviceId));
  return sourceId==='screen:'+hash||sourceId==='ui-page:'+hash;
}
