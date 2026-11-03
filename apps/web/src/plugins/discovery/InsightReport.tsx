import {formatEvidenceRef} from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import {Ellipsis} from 'lucide-react';
import {AnswerMarkdown} from '../ask/AnswerMarkdown';
import {type Answer,dateTime} from '../../api';
import {webAppearance} from '../../appearance';
import {createPortal} from 'react-dom';
import {InsightReportFrame} from './InsightReportFrame';
export {reportDocument} from './report-document';

export function InsightReport({answer,onOpen,onAsk,controlsTarget,owner,onAutomaticSettings}:{answer:Answer;onOpen:(id:string)=>void;onAsk?:()=>void;controlsTarget?:HTMLElement|null;owner?:object;onAutomaticSettings?:()=>void}){
  const {scheme}=useSyncExternalStore(webAppearance.subscribe,webAppearance.getSnapshot,webAppearance.getSnapshot);
  const [view,setView]=useState<'report'|'text'>('report');
  const [moreOpen,setMoreOpen]=useState(false),menuId=useId();
  const more=useRef<HTMLDivElement>(null),moreButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!moreOpen)return;
    more.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const closeOutside=(event:PointerEvent)=>{if(event.target instanceof Node&&!more.current?.contains(event.target))setMoreOpen(false);};
    document.addEventListener('pointerdown',closeOutside);
    return()=>document.removeEventListener('pointerdown',closeOutside);
  },[moreOpen]);
  function chooseView(next:'report'|'text'){setView(next);setMoreOpen(false);moreButton.current?.focus();}
  const artifact=answer.artifact,snapshot=answer.snapshot;
  const tools=<div className="report-top-tools">{onAsk&&<button className="button discovery-ask" onClick={onAsk}>{moteText("继续追问")} ↗</button>}{(artifact||onAutomaticSettings)&&<div className="report-more" ref={more} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setMoreOpen(false);}} onKeyDown={event=>{
      if(event.key==='Escape'&&moreOpen){event.preventDefault();setMoreOpen(false);moreButton.current?.focus();}
    }}>
      <button ref={moreButton} type="button" className="button secondary" aria-haspopup="menu" aria-expanded={moreOpen} aria-controls={menuId} onClick={()=>setMoreOpen(open=>!open)}>{moteText('更多')}<Ellipsis size={16} aria-hidden="true"/></button>
      {moreOpen&&<div id={menuId} className="report-more-menu" role="menu" aria-label={moteText('显示方式')} onKeyDown={event=>{
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        event.preventDefault();
        const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"],[role="menuitem"]')),index=items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
      }}>
        {artifact&&<><div className="report-menu-label" role="presentation">{moteText('显示方式')}</div>
        <button type="button" role="menuitemradio" aria-checked={view==='report'} onClick={()=>chooseView('report')}>{moteText('排版结果')}</button>
        <button type="button" role="menuitemradio" aria-checked={view==='text'} onClick={()=>chooseView('text')}>{moteText('标准阅读')}</button></>}{onAutomaticSettings&&<button type="button" role="menuitem" onClick={()=>{setMoreOpen(false);onAutomaticSettings();}}>{moteText('自动生成设置')}</button>}
      </div>}
    </div>}</div>;
  return <article className="insight-report">
    {controlsTarget?createPortal(tools,controlsTarget):tools}
    <header className="report-controls"><div><small className="discovery-kicker">{moteText("AI 发现")}</small><h2>{artifact?.title||moteText("个人回顾")}</h2><p>{(artifact?.createdAt||answer.createdAt)&&dateTime(artifact?.createdAt||answer.createdAt!)} · {answer.citations.length}{' '}{moteText("条证据")}</p></div></header>

    {artifact&&view==='report'?<InsightReportFrame html={artifact.html} citations={answer.citations} scheme={scheme} title={artifact.title||moteText("洞察报告")} owner={owner} onOpen={onOpen}/>:<div className="report-markdown"><AnswerMarkdown answer={answer} onOpen={onOpen}/></div>}
    <details className="report-evidence" aria-label={moteText("报告引用的证据")}><summary><span>{moteText("查看依据")}</span><small>{answer.citations.length}</small></summary>{answer.citations.length?<div className="citation-grid">{answer.citations.map((citation,index)=><button key={citation.id} className="evidence-card" onClick={()=>onOpen(formatEvidenceRef('capture',citation.id))}><span className="evidence-number">{index+1}</span><div><strong>{citation.appName||moteText("原始记录")}</strong><small>{citation.contentAt?moteText("资料时间"):moteText("观察时间")} · {dateTime(citation.contentAt??citation.capturedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</small><p>{citation.excerpt||moteText("查看原始记录")}</p></div></button>)}</div>:<p className="muted">{moteText("这份报告没有可引用的记录；内容需要进一步核实。")}</p>}</details>
    <details className="run-details"><summary>{moteText("资料范围与生成信息")}</summary>{snapshot&&<div className="report-coverage" aria-label={moteText('资料范围与覆盖')}><p>{moteText('版本')} {snapshot.version} · {moteText('资料截止时间')} {dateTime(snapshot.asOf)}</p><p>{snapshot.scope.after?dateTime(snapshot.scope.after):moteText('全部已归档资料')} — {dateTime(snapshot.scope.before)} · {snapshot.coverage.records} {moteText('条记录')} · {snapshot.coverage.materialRecords??0} {moteText('正式资料')}</p><p>{moteText('跨设备去重后的采样时长')} {Math.round(snapshot.coverage.measured.observedDurationMs/1000)} {moteText('秒')} · {moteText('采样不能证明实际工作时长。')}</p>{snapshot.coverage.measured.unobservedDurationMs!==null&&snapshot.coverage.measured.unobservedDurationMs>0&&<p>{moteText('所选时段包含未采样时间，结论只覆盖已有记录。')}</p>}{(snapshot.coverage.referenceOnlyRecords>0||snapshot.coverage.pendingProcessing>0)&&<p>{moteText('部分资料仍未完成处理或仅保留来源引用，内容覆盖不完整。')}</p>}{snapshot.previousRunId&&<p>{moteText('此报告是同一范围的新版本，旧报告保留各自的资料快照。')}</p>}</div>}<dl><dt>{moteText("运行编号")}</dt><dd>{answer.runId}</dd>{artifact&&<><dt>{moteText("使用的 Skill")}</dt><dd>{artifact.skillId} · {artifact.skillVersion}</dd></>}</dl>{answer.trace.length>0?<ol>{answer.trace.map((step,index)=><li key={index}><strong>{step.tool}</strong> · {step.count}{' '}{moteText("条结果")}<pre>{JSON.stringify(step.arguments,null,2)}</pre></li>)}</ol>:<p className="muted">{moteText("没有额外的检索步骤。")}</p>}</details>
  </article>;
}
