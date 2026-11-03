import {useEffect,useRef,type ReactNode} from 'react';
import {moteText} from '@mote/shared/i18n';
import {containDialogFocus} from '../../dialog-focus';
export function ActionDialog({title,busy,onClose,children,className=''}:{title:string;busy:boolean;onClose:()=>void;children:ReactNode;className?:string}){
 const ref=useRef<HTMLElement>(null);useEffect(()=>ref.current?containDialogFocus(ref.current,document.activeElement as HTMLElement|null):undefined,[]);
 return <div className="action-final-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.stopPropagation();onClose();}}}><section className={'action-final-dialog '+className} ref={ref} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label={moteText('关闭')}>×</button></header>{children}</section></div>;
}
