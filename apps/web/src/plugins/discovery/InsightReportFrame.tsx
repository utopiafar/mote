import {useLayoutEffect,useMemo,useRef,useState} from 'react';
import {formatEvidenceRef} from '@mote/shared';
import type {Answer} from '../../api';
import {reportDocument} from './report-document';
import {acceptedReportHeight,acceptedReportSource,newReportSizeToken} from './report-sizing';

/** Opaque content keeps all owner controls and credentials outside the frame.
 * The sole host script reports height and current citation indexes; model scripts remain denied. */
export function InsightReportFrame({html,citations,scheme,title,owner,onOpen}:{html:string;citations:Answer['citations'];scheme:'light'|'dark';title:string;owner?:object;onOpen?:(ref:string)=>void}){
 const frame=useRef<HTMLIFrameElement>(null),updates=useRef({token:'',width:0,count:0,height:-1}),[size,setSize]=useState<{token:string;height:number}>();
 const citationIds=JSON.stringify(citations.map(citation=>citation.id));
 const document=useMemo(()=>{const token=newReportSizeToken(),parentOrigin=typeof window==='undefined'?'http://localhost':window.location.origin;return {token,source:reportDocument(html,citations,scheme,{token,parentOrigin})};},[html,citationIds,scheme,owner]);
 const current=useRef({owner,token:document.token,citations,onOpen});current.current={owner,token:document.token,citations,onOpen};
 useLayoutEffect(()=>{const receive=(event:MessageEvent)=>{
  // A queued old listener cannot navigate after a new owner/document renders,
  // including the commit boundary before listener cleanup.
  const active=current.current;if(active.owner!==owner||active.token!==document.token)return;
  const source=frame.current?.contentWindow??null,index=acceptedReportSource(event,source,document.token,active.citations.length);
  if(index!==undefined){active.onOpen?.(formatEvidenceRef('capture',active.citations[index].id));return;}
  const height=acceptedReportHeight(event,source,document.token);if(height!==undefined){const width=frame.current?.clientWidth??0;if(updates.current.token!==document.token||updates.current.width!==width)updates.current={token:document.token,width,count:0,height:-1};if(updates.current.height===height||updates.current.count>=32)return;updates.current.height=height;updates.current.count++;setSize({token:document.token,height});}
 };window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[document.token,owner]);
 const height=size?.token===document.token?size.height:450;
 return <iframe ref={frame} className="report-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document.source} style={{height}}/>;
}
