import {parseEvidenceRef,formatEvidenceRef} from '@mote/shared';
export function readEvidenceRoute(hash:string):string|null {
 const value=new URLSearchParams(hash.split('?')[1]??'').get('evidence');
 return value&&value.length<=4096?value:null;
}
export function evidenceRoute(hash:string,id:string|null):string {
 const [base,search]=hash.split('?'),query=new URLSearchParams(search);
 if(id){const parsed=parseEvidenceRef(id);query.set('evidence',parsed?formatEvidenceRef(parsed.kind,parsed.id):id);}else query.delete('evidence');
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
