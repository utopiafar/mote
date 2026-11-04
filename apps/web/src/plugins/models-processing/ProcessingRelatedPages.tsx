import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {ProcessingServices} from '../../ProcessingServices';
import {ModelAssignments} from './ModelAssignments';
import {ModelProfiles} from './ModelProfiles';
import type {FileSettingsView} from '../../processing-settings-view';

type Panel={owner:Api;kind:string;page:'service'|'models'|'profiles';id?:string;sequence:number};
const ignoreDetail=()=>{};
/** Keep related settings mounted in the same editor, as the source's return
 * path requires. Drafts never cross an Api owner or leave this page instance. */
export function useProcessingRelatedPages(api:Api,kind:'images'|'audio'|'documents',onDetailChange?:(value:boolean)=>void,onFileSaved?:(next:FileSettingsView,previousRevision:string)=>void){
 const [panel,setPanel]=useState<Panel>(),[visited,setVisited]=useState({service:false,models:false,profiles:false}),[revision,setRevision]=useState(0),[profileDetail,setProfileDetail]=useState(false);
 const sequence=useRef(0),current=panel?.owner===api&&panel.kind===kind?panel:undefined;
 const origin=useRef<{owner:Api;kind:string;x:number;y:number;focus:HTMLElement|null}|undefined>(undefined),previous=useRef<Panel|undefined>(undefined);
 useLayoutEffect(()=>{
  let frame:number|undefined;
  if(current)window.scrollTo(0,0);
  else if(previous.current&&origin.current?.owner===api&&origin.current.kind===kind){const saved=origin.current;frame=window.requestAnimationFrame(()=>{if(saved.focus?.isConnected)saved.focus.focus({preventScroll:true});window.scrollTo(saved.x,saved.y);origin.current=undefined;});}
  previous.current=current;return()=>{if(frame!==undefined)window.cancelAnimationFrame(frame);};
 },[current?.sequence,api,kind]);
 useEffect(()=>{setPanel(undefined);setVisited({service:false,models:false,profiles:false});setRevision(0);setProfileDetail(false);origin.current=undefined;previous.current=undefined;},[api,kind]);
 useLayoutEffect(()=>{onDetailChange?.(Boolean(current));return()=>onDetailChange?.(false);},[Boolean(current),onDetailChange]);
 const open=(page:Panel['page'],id?:string)=>{if(!current)origin.current={owner:api,kind,x:window.scrollX,y:window.scrollY,focus:document.activeElement as HTMLElement|null};setVisited(value=>({...value,[page]:true}));setPanel({owner:api,kind,page,id,sequence:++sequence.current});};
 const label=moteText(kind==='images'?'图片':kind==='audio'?'录音':'文档与其他文件');
 const back=<button type="button" className="text-button model-profile-back" onClick={()=>setPanel(undefined)}>← {label}</button>;
 const pages=<>
  {visited.service&&<div hidden={current?.page!=='service'}><ProcessingServices api={api} initialServiceId={current?.page==='service'?current.id:undefined} selectionSequence={current?.sequence} returnLabel={label} onSaved={onFileSaved} onReturn={()=>setPanel(undefined)} onDetailChange={ignoreDetail} onProcessing={()=>setPanel(undefined)}/></div>}
  {visited.models&&<div hidden={current?.page!=='models'}>{back}<div className="page-heading model-profile-heading"><h1>{moteText('模块与模型')}</h1></div><ModelAssignments api={api} revision={revision} onApplied={()=>setRevision(value=>value+1)} onManage={()=>open('profiles')}/></div>}
  {visited.profiles&&<div hidden={current?.page!=='profiles'}><div hidden={profileDetail}>{back}<div className="page-heading model-profile-heading"><h1>{moteText('服务连接')}</h1></div></div><ModelProfiles api={api} revision={revision} onApplied={()=>setRevision(value=>value+1)} onDetailChange={setProfileDetail}/></div>}
 </>;
 return {active:Boolean(current),openService:(id:string)=>open('service',id),openModels:()=>open('models'),pages};
}
