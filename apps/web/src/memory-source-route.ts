import {parseEvidenceRef} from '@mote/shared';
/** Explicit capture selection is separate from the list's rolling time window. */
export function memorySourceRoute(id:string){
 const parsed=parseEvidenceRef(id);
 if(parsed?.kind!=='capture')throw new Error('A capture reference is required');
 return '#/library/memories?'+new URLSearchParams({memorySource:parsed.id});
}
export function readMemorySource(hash:string){return new URLSearchParams(hash.split('?')[1]??'').get('memorySource');}
export function memorySourceId(value:string|null){const parsed=value?parseEvidenceRef(value):null;return parsed?.kind==='capture'?parsed.id:null;}
export function subscribeMemorySource(listener:()=>void){window.addEventListener('hashchange',listener);return()=>window.removeEventListener('hashchange',listener);}
export function currentMemorySource(){return readMemorySource(window.location.hash);}
