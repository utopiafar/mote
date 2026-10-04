import {parseEvidenceRef,formatEvidenceRef,parseArtifactRef} from '@mote/shared';
function normalizePublicReference(value:string):string|null {
 const parsed=parseEvidenceRef(value);
 if(parsed)return formatEvidenceRef(parsed.kind,parsed.id);
 if(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/.test(value)||parseArtifactRef(value))return value;
 return null;
}
export function readEvidenceRoute(hash:string):string|null {
 const value=new URLSearchParams(hash.split('?')[1]??'').get('evidence');
 return value?normalizePublicReference(value):null;
}
export function evidenceRoute(hash:string,id:string|null):string {
 const [base,search]=hash.split('?'),query=new URLSearchParams(search);
 if(id){const ref=normalizePublicReference(id);if(!ref)throw new Error('A typed evidence reference is required');query.set('evidence',ref);}else query.delete('evidence');
 return (base||'#/today')+(query.size?'?'+query:'');
}
/** One reversible detail entry retains its origin route and other query filters. */
export function changeEvidenceRoute(browser:Pick<Window,'location'|'history'>,id:string|null):string|null {
 const current=browser.location.hash,next=evidenceRoute(current,id),state=browser.history.state;
 if(next===current)return readEvidenceRoute(next);
 if(id){
  if(readEvidenceRoute(current))browser.history.replaceState(state,'',next);
  else browser.history.pushState({...state,moteEvidenceReturn:current},'',next);
 }else if(typeof state?.moteEvidenceReturn==='string'&&evidenceRoute(current,null)===state.moteEvidenceReturn){browser.history.back();}
 else browser.history.replaceState(state,'',next);
 return readEvidenceRoute(next);
}
