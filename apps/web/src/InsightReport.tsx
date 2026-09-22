import { moteText } from '@mote/shared/i18n';
import {useState} from 'react';
import {FileText,LayoutDashboard} from 'lucide-react';
import {AnswerMarkdown} from './AnswerMarkdown';
import {type Answer,dateTime} from './api';

// This document contains only the report. The authenticated application's state and
// controls stay outside the opaque-origin iframe.
export function reportDocument(html:string):string {
  const policy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><html lang="zh-CN"><head><meta http-equiv="Content-Security-Policy" content="'+policy+'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light}body{margin:0;padding:28px;font-family:system-ui,-apple-system,sans-serif;color:#253a2d;line-height:1.75;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}*{box-sizing:border-box}table{max-width:100%}a{pointer-events:none}</style></head><body>'+html+'</body></html>';
}

export function InsightReport({answer,onOpen}:{answer:Answer;onOpen:(id:string)=>void}){
  const [view,setView]=useState<'report'|'text'>('report');
  const artifact=answer.artifact,snapshot=answer.snapshot;
  return <article className="insight-report">
    <header className="report-controls"><div><h2>{artifact?.title||moteText("个人回顾")}</h2><p>{(artifact?.createdAt||answer.createdAt)&&dateTime(artifact?.createdAt||answer.createdAt!)} · {answer.citations.length}{' '}{moteText("条证据")}</p></div>{artifact&&<nav className="segmented-nav" aria-label={moteText("报告展示方式")}><button className={view==='report'?'active':''} onClick={()=>setView('report')}><LayoutDashboard size={14}/>{moteText("报告")}</button><button className={view==='text'?'active':''} onClick={()=>setView('text')}><FileText size={14}/>{moteText("文字")}</button></nav>}</header>
    {snapshot&&<section className="notice" aria-label={moteText('资料范围与覆盖')}><p>{moteText('洞察版本')} {snapshot.version} · {moteText('资料截止时间')} {dateTime(snapshot.asOf)}</p><p>{snapshot.scope.after?dateTime(snapshot.scope.after):moteText('全部已归档资料')} — {dateTime(snapshot.scope.before)} · {snapshot.coverage.records} {moteText('条记录')}</p><p>{moteText('跨设备去重后的采样时长')} {Math.round(snapshot.coverage.measured.observedDurationMs/1000)} {moteText('秒')} · {moteText('采样不能证明实际工作时长。')}</p>{snapshot.coverage.measured.unobservedDurationMs!==null&&snapshot.coverage.measured.unobservedDurationMs>0&&<p>{moteText('所选时段包含未采样时间，结论只覆盖已有记录。')}</p>}{(snapshot.coverage.referenceOnlyRecords>0||snapshot.coverage.pendingProcessing>0)&&<p>{moteText('部分资料仍未完成处理或仅保留来源引用，内容覆盖不完整。')}</p>}{snapshot.previousRunId&&<p>{moteText('此报告是同一范围的新版本，旧报告保留各自的资料快照。')}</p>}</section>}
    {artifact&&view==='report'?<iframe className="report-frame" title={artifact.title||moteText("洞察报告")} sandbox="" referrerPolicy="no-referrer" srcDoc={reportDocument(artifact.html)}/>:<div className="report-markdown"><AnswerMarkdown answer={answer} onOpen={onOpen}/></div>}
    <section className="report-evidence" aria-label={moteText("报告引用的证据")}><div className="section-heading"><div><h3>{moteText("回到证据")}</h3><p>{moteText("报告中的判断来自以下记录。点击查看完整原文。")}</p></div></div>{answer.citations.length?<div className="citation-grid">{answer.citations.map((citation,index)=><button key={citation.id} className="evidence-card" onClick={()=>onOpen(citation.id)}><span className="evidence-number">{index+1}</span><div><strong>{citation.appName||moteText("原始记录")}</strong><small>{citation.contentAt?moteText("资料时间"):moteText("观察时间")} · {dateTime(citation.contentAt??citation.capturedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</small><p>{citation.excerpt||moteText("查看原始记录")}</p></div></button>)}</div>:<p className="muted">{moteText("这份报告没有可引用的记录；内容需要进一步核实。")}</p>}</section>
    <details className="run-details"><summary>{moteText("生成信息与检索过程")}</summary><dl><dt>{moteText("运行编号")}</dt><dd>{answer.runId}</dd>{artifact&&<><dt>{moteText("使用的 Skill")}</dt><dd>{artifact.skillId} · {artifact.skillVersion}</dd></>}</dl>{answer.trace.length>0?<ol>{answer.trace.map((step,index)=><li key={index}><strong>{step.tool}</strong> · {step.count}{' '}{moteText("条结果")}<pre>{JSON.stringify(step.arguments,null,2)}</pre></li>)}</ol>:<p className="muted">{moteText("没有额外的检索步骤。")}</p>}</details>
  </article>;
}
