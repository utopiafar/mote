import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {InsightReport} from '../../src/plugins/discovery/InsightReport';
import {EvidenceDialog} from '../../src/shell-components';
import {createApi,type Api,type Answer} from '../../src/api';
import {webAppearance} from '../../src/appearance';
import '../../src/styles.css';
declare global {interface Window {reportSizing:{render:(html:string,scheme?:'light'|'dark')=>void;connect:(token:string,noteId:string)=>void;changeOwner:()=>void;opened:string[]};untrustedMessages:unknown[]}}
window.untrustedMessages=[];window.addEventListener('message',event=>{if(event.data?.type==='generated-model-executed')window.untrustedMessages.push(event.data);});
const opened:string[]=[];
function Fixture(){
 const [value,setValue]=useState({html:'<p>Generated short report.</p>',scheme:'light' as 'light'|'dark'}),[connection,setConnection]=useState<{token:string;api:Api;noteId:string}>(),[original,setOriginal]=useState<string>();
 window.reportSizing={render:(html,scheme='light')=>{webAppearance.save(scheme);document.documentElement.dataset.colorScheme=scheme;setValue({html,scheme});},connect:(token,noteId)=>setConnection({token,noteId,api:createApi({token})}),changeOwner:()=>{setOriginal(undefined);setConnection(current=>current&&({...current,api:createApi({token:current.token})}));},opened};
 const citations:Answer['citations']=connection?[{id:connection.noteId,appName:'Generated original',capturedAt:'2026-10-01T00:00:00Z',excerpt:'Generated exact original'}]:[];
 const answer:Answer={runId:'generated-report',answer:'Generated standard report',citations,trace:[],artifact:{id:'generated-artifact',title:'Generated report',createdAt:'2026-10-01T00:00:00Z',skillId:'insight',skillVersion:'1',html:value.html}};
 const open=(ref:string)=>{opened.push(ref);setOriginal(ref);};
 return <><InsightReport owner={connection?.api} answer={answer} onOpen={open}/>{original&&connection&&<EvidenceDialog id={original} api={connection.api} onOpen={open} onClose={()=>setOriginal(undefined)} onDeleted={()=>{}}/>}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
