import {useEffect,useRef} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {Api} from './api';
import {containDialogFocus} from './dialog-focus';
import {Notes} from './Notes';

export function QuickNoteDialog({api,namespace,revision,onSaved,onClose}: {
 api:Api;namespace:string;revision:number;onSaved:()=>void;onClose:()=>void;
}){
 const panel=useRef<HTMLDivElement>(null);
 const opener=useRef(document.activeElement as HTMLElement|null);
 useEffect(()=>{
  if(!panel.current)return;
  const restoreFocus=containDialogFocus(panel.current,opener.current,panel.current.querySelector('textarea'));
  const overflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();onClose();}};
  panel.current.addEventListener('keydown',escape);
  return()=>{panel.current?.removeEventListener('keydown',escape);document.body.style.overflow=overflow;restoreFocus();};
 },[onClose]);
 return createPortal(<div className="quick-note-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><div ref={panel} className="quick-note-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-note-title">
  <header><h2 id="quick-note-title">{moteText('随手记')}</h2><button className="icon-button" aria-label={moteText('收起随手记')} onClick={onClose}><X size={18}/></button></header>
  <Notes api={api} namespace={namespace} revision={revision} onOpen={()=>{}} onSaved={onSaved} composerOnly onSubmitted={onClose} onClose={onClose}/>
 </div></div>,document.body);
}
