import {parseEvidenceRef,formatEvidenceRef} from '@mote/shared';
/** Explicit capture selection is separate from the list's rolling time window. */
export function memorySourceRoute(id:string){
 const parsed=parseEvidenceRef(id);
 if(parsed?.kind!=='capture')throw new Error('A capture reference is required');
 return '#/library?view=memories&'+new URLSearchParams({memorySource:formatEvidenceRef('capture',parsed.id)});
}
const materialPattern=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/;
export function memoryMaterialRoute(ref:string){
 if(!materialPattern.test(ref))throw new Error('A pinned Material reference is required');
 return '#/library?view=memories&'+new URLSearchParams({memoryMaterial:ref});
}
export function readMemorySource(hash:string){return new URLSearchParams(hash.split('?')[1]??'').get('memorySource');}
export function memorySourceId(value:string|null){const parsed=value?parseEvidenceRef(value):null;return parsed?.kind==='capture'?parsed.id:null;}
export function readMemoryMaterial(hash:string){return new URLSearchParams(hash.split('?')[1]??'').get('memoryMaterial');}
export function memoryMaterialId(value:string|null){return value?.match(materialPattern)?.[1]??null;}
export function subscribeMemorySource(listener:()=>void){window.addEventListener('hashchange',listener);return()=>window.removeEventListener('hashchange',listener);}
export function currentMemorySource(){return readMemorySource(window.location.hash);}
export function currentMemoryMaterial(){return readMemoryMaterial(window.location.hash);}
