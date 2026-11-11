import {moteText,cjkLocale} from '@mote/shared/i18n';
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {type Api,errorMessage} from '../../api';
import {RecordingTools} from '../sources/RecordingTools';
import {installRecordingStyles,recordingSpeaker} from '../../recording-presentation';
import { Loading } from '../../Loading';

export async function downloadFileExport(api:Api,id:string){const response=await api.raw('/api/files/'+id+'/export'),url=URL.createObjectURL(await response.blob());try{const a=document.createElement('a');a.href=url;a.download='mote-recording-'+id+'.tar.gz';a.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}}

/** One shared player; only an explicit sample selection reads an existing asset. */
function SpeakerSample({api,id,artifactId,speaker,selection}:{api:Api;id:string;artifactId:string;speaker?:string;selection:number}){
 const [attempt,setAttempt]=useState(0),[loaded,setLoaded]=useState<{api:Api;id:string;artifactId:string;speaker:string;url?:string;error?:string}>(),player=useRef<HTMLAudioElement>(null);
 useEffect(()=>{
  if(!speaker)return;setLoaded(undefined);const controller=new AbortController();let created='';
  void api.raw('/api/files/'+id+'/assets?'+new URLSearchParams({artifactId,name:'speaker_samples/'+speaker+'.wav'}),{signal:controller.signal}).then(r=>r.blob()).then(blob=>{
   if(controller.signal.aborted)return;created=URL.createObjectURL(blob);setLoaded({api,id,artifactId,speaker,url:created});
  }).catch(error=>{if(!controller.signal.aborted)setLoaded({api,id,artifactId,speaker,error:errorMessage(error)});});
  return()=>{controller.abort();if(created)URL.revokeObjectURL(created);};
 },[api,id,artifactId,speaker,attempt]);
 const current=loaded?.api===api&&loaded.id===id&&loaded.artifactId===artifactId&&loaded.speaker===speaker?loaded:undefined;
 useEffect(()=>{const audio=player.current;return()=>{audio?.pause();audio?.removeAttribute('src');audio?.load();};},[current?.url]);
 useEffect(()=>{if(current?.error){setAttempt(value=>value+1);return;}const audio=player.current;if(audio&&audio.readyState>=1){audio.currentTime=0;void audio.play().catch(()=>{});}},[selection]);
 if(!speaker)return null;
 return <div className="recording-sample-region"><div className="recording-sample-label">{recordingSpeaker(speaker,true)}</div>{current?.url?<audio ref={player} className="recording-sample-player" aria-label={moteText('说话人试听样例')} controls preload="none" src={current.url} onLoadedMetadata={event=>{if(event.currentTarget.isConnected)void event.currentTarget.play().catch(()=>{});}}/>:current?.error?<p role="alert">{current.error}</p>:<Loading/>}</div>;
}

type Props={api:Api;id:string;artifacts:any[];onChanged:()=>Promise<void>;initialSection?:'review'|'speakers';onClose?:()=>void;initialSpeaker?:string;speakerDraft?:Record<string,string>;onSpeakerDraft?:(value:Record<string,string>)=>void;speakers?:string[]};
export function FileReview({api,id,artifacts,onChanged,initialSection,onClose,initialSpeaker,speakerDraft,onSpeakerDraft,speakers=[]}:Props){
 const [reviewState,setReviews]=useState<{api:Api;id:string;items:any[]}>(),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[selected,setSelected]=useState<Record<string,boolean>>({}),[replacements,setReplacements]=useState<Record<string,string>>({}),[localNames,setLocalNames]=useState<{api:Api;id:string;values:Record<string,string>}>(),[sample,setSample]=useState<{api:Api;id:string;artifactId:string;speaker:string;sequence:number}>();
 const diarization=artifacts.find(a=>a.kind==='diarization'),dialogue=artifacts.find(a=>a.kind==='corrected-dialogue')??artifacts.find(a=>a.kind==='dialogue'),nameArtifact=artifacts.find(a=>a.kind==='speaker-names'),names:Record<string,string>=speakerDraft??(localNames?.api===api&&localNames.id===id?localNames.values:nameArtifact?.names??{}),formId=useId();
 const reviews=reviewState?.api===api&&reviewState.id===id?reviewState.items:[],selectedSample=sample?.api===api&&sample.id===id&&sample.artifactId===diarization?.id?sample:undefined;
 const visit=useRef({api,id,diarization:diarization?.id,dialogue:dialogue?.id}),alive=useRef(true),focusName=useRef<HTMLInputElement>(null);
 if(visit.current.api!==api||visit.current.id!==id||visit.current.diarization!==diarization?.id||visit.current.dialogue!==dialogue?.id)visit.current={api,id,diarization:diarization?.id,dialogue:dialogue?.id};
 useEffect(()=>{alive.current=true;installRecordingStyles();return()=>{alive.current=false;};},[]);
 useEffect(()=>{setLocalNames({api,id,values:nameArtifact?.names??{}});},[api,id,nameArtifact?.id]);
 useLayoutEffect(()=>{setSample(undefined);setMessage('');setBusy(false);setSelected({});setReplacements({});},[api,id,diarization?.id,dialogue?.id,initialSpeaker]);
 useEffect(()=>{focusName.current?.focus();},[api,id,initialSpeaker]);
 const current=(ticket:typeof visit.current)=>alive.current&&visit.current===ticket;
 async function load(ticket=visit.current,signal?:AbortSignal){const result=await api.request<any>('/api/files/'+id+'/reviews',{signal});if(current(ticket)&&!signal?.aborted)setReviews({api,id,items:result.items});}
 useEffect(()=>{setReviews(undefined);if(initialSection==='speakers')return;const controller=new AbortController(),ticket=visit.current;void load(ticket,controller.signal).catch(error=>{if(current(ticket)&&!controller.signal.aborted)setMessage(errorMessage(error));});return()=>controller.abort();},[api,id,diarization?.id,dialogue?.id,initialSection]);
 async function action(fn:(isCurrent:()=>boolean)=>Promise<void>){if(busy)return;const ticket=visit.current,isCurrent=()=>current(ticket);setBusy(true);setMessage('');try{await fn(isCurrent);if(isCurrent()&&initialSection!=='speakers')await load(ticket);}catch(error){if(isCurrent())setMessage(errorMessage(error));}finally{if(isCurrent())setBusy(false);}}
 async function propose(kind:string,offset=0){await api.request('/api/files/'+id+'/reviews',{method:'POST',body:JSON.stringify({kind,offset})});}
 async function confirm(review:any,accept:boolean){const ids=review.suggestions?.filter((s:any)=>selected[s.id]).map((s:any)=>s.id)??[],ticket=visit.current;await api.request('/api/files/'+id+'/reviews/'+review.id,{method:'POST',body:JSON.stringify({action:accept?'accept':'reject',selected:ids,replacements:Object.fromEntries(ids.filter((x:string)=>replacements[x]).map((x:string)=>[x,replacements[x]]))})});if(current(ticket))await onChanged();}
 const speakerLabels=[...new Set<string>([...speakers,...(Array.isArray(diarization?.segments)?diarization.segments:[]).map((s:any)=>s.speaker),...(diarization?.samples??[]).map((s:any)=>s.speaker)].filter((s:unknown):s is string=>typeof s==='string'&&/^SPEAKER_[0-9]{1,5}$/.test(s)))];
 const saveNames=()=>action(async isCurrent=>{
  const savedNames=Object.fromEntries(Object.entries(names).map(([key,value])=>[key,value.trim()]).filter(([,value])=>value));
  await api.request('/api/files/'+id+'/speakers',{method:'POST',body:JSON.stringify({artifactId:dialogue.id,names:savedNames})});
  if(!isCurrent())return;setLocalNames({api,id,values:savedNames});onSpeakerDraft?.(savedNames);await onChanged();if(isCurrent()){setMessage(moteText('说话人名称已保存。'));onClose?.();}
 });
 const speakerEditor=diarization&&<form id={formId} className="recording-speakers-form" onSubmit={event=>{event.preventDefault();if(dialogue)void saveNames();}}>
  <p>{moteText('试听后填写名称，仅用于这份录音。不确定的片段仍可逐段回听。')}</p>
  <SpeakerSample api={api} id={id} artifactId={diarization.id} speaker={selectedSample?.speaker} selection={selectedSample?.sequence??0}/>
  {speakerLabels.map(label=><div className="recording-speaker-row" key={label}><div><strong>{recordingSpeaker(label,true)}</strong><button type="button" className="text-button" disabled={!diarization.samples?.some((s:any)=>s.speaker===label)} onClick={()=>setSample(value=>({api,id,artifactId:diarization.id,speaker:label,sequence:(value?.sequence??0)+1}))}>▷ {moteText('试听片段')}</button>{!diarization.samples?.some((s:any)=>s.speaker===label)&&<small>{moteText('暂无可试听片段')}</small>}</div><label>{moteText('名称（选填）')}<input ref={label===initialSpeaker?focusName:undefined} data-recording-name={label} maxLength={100} placeholder={moteText('保留匿名也可以')} value={names[label]??''} disabled={busy} onChange={event=>{const next={...names,[label]:event.target.value};setLocalNames({api,id,values:next});onSpeakerDraft?.(next);}}/></label></div>)}
  {(diarization.declaredRange||diarization.estimate||diarization.warnings?.length>0)&&<details className="recording-speaker-quality"><summary>{moteText('声学候选与版本')}</summary>{diarization.declaredRange&&<p>{moteText('声明范围：{0}–{1}；模型输出 {2} 个匿名标签，需试听确认。',diarization.declaredRange.min,diarization.declaredRange.max,diarization.observedSpeakers)}</p>}{diarization.estimate&&<><p>{moteText('候选评分是轮廓系数，不是概率或身份置信度。')}</p><pre>{JSON.stringify({model:diarization.modelProvenance,selectedClusters:diarization.estimate.selectedClusters,scoreGap:diarization.estimate.scoreGap,candidates:diarization.estimate.candidates.map(({segments,...candidate}:any)=>({...candidate,segments:segments.length}))},null,2)}</pre></>}{diarization.warnings?.map((warning:string,index:number)=><p key={index}>{moteText(warning)}</p>)}</details>}
  {!(initialSection==='speakers'&&onClose)&&<button className="button primary" disabled={busy||!dialogue}>{moteText('确认说话人名称')}</button>}
  {busy&&<p role="status">{moteText('正在处理…')}</p>}{message&&<p role="status">{message}</p>}
 </form>;
 if(initialSection==='speakers'&&onClose)return <RecordingTools title={moteText('说话人')} onClose={onClose} footer={<><button className="button" onClick={onClose}>{moteText('返回')}</button><button form={formId} type="submit" className="button primary" disabled={busy||!dialogue}>{moteText('保存名称')}</button></>}>{speakerEditor}</RecordingTools>;
 return <>{initialSection!=='review'&&<><div className="source-toolbar"><button className="button" disabled={busy} onClick={()=>void action(async()=>downloadFileExport(api,id))}>{moteText("导出转写与说话人记录")}</button></div>{diarization&&<details><summary>{moteText("说话人试听与命名")}</summary>{speakerEditor}</details>}</>}
 <details open={initialSection==='review'||undefined}><summary>{moteText("场次关联与术语复核")}</summary><p>{moteText("模型只提出建议，确认后生成单独的校正版；未校正原文始终保留。本地多人录音使用已配置的本地语言模型。")}</p><div className="source-toolbar"><button className="button primary" disabled={busy} onClick={()=>void action(()=>propose('calendar'))}>{moteText("建议匹配日程场次")}</button><button className="button primary" disabled={busy} onClick={()=>void action(()=>propose('terms'))}>{moteText("检查可能的识别错误")}</button></div>
 {reviews.map(r=><div className="source-item" key={r.id}><strong>{r.kind==='calendar'?moteText("场次关联"):moteText("术语复核")} · {{proposed:moteText("待确认"),accepted:moteText("已确认"),rejected:moteText("已忽略"),stale:moteText("原文已变化")}[r.status as string]??r.status}</strong>{r.reason&&<p>{r.reason}</p>}{r.calendar?.map((c:any)=><p key={c.captureId}>{c.title}</p>)}{r.suggestions?.map((s:any)=><label key={s.id}><span><input type="checkbox" disabled={r.status!=='proposed'} checked={!!selected[s.id]} onChange={e=>setSelected(v=>({...v,[s.id]:e.target.checked}))}/>{s.original} → </span><input disabled={r.status!=='proposed'} value={replacements[s.id]??s.replacement} onChange={e=>setReplacements(v=>({...v,[s.id]:e.target.value}))}/><span>{s.reason}</span></label>)}{r.suggestions?.length===0&&<p>{moteText("本批未提出需要校正的词。")}</p>}{r.status==='proposed'&&<div className="source-toolbar"><button className="button primary" disabled={busy||(r.kind==='calendar'?!r.calendarId:!r.suggestions?.some((s:any)=>selected[s.id]))} onClick={()=>void action(()=>confirm(r,true))}>{moteText("确认")}{cjkLocale()?'':' '}{r.kind==='calendar'?moteText("关联"):moteText("所选校正")}</button><button className="button" disabled={busy} onClick={()=>void action(()=>confirm(r,false))}>{moteText("忽略本次建议")}</button></div>}{r.scope?.nextOffset!=null&&<button className="button" disabled={busy} onClick={()=>void action(()=>propose(r.kind,r.scope.nextOffset))}>{moteText("检查下一批片段")}</button>}</div>)}</details>{busy&&<p role="status">{moteText("正在处理…")}</p>}{message&&<p role="status">{message}</p>}</>;
}
