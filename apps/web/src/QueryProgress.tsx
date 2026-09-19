import { moteText, getLocale } from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import {LoaderCircle,CheckCircle2,AlertCircle} from 'lucide-react';
export interface QueryRun {id:string;status:'running'|'completed'|'failed'|'cancelled';createdAt:string;updatedAt:string;conversationId?:string;turnId?:string;events:{stage:'starting'|'model'|'tool'|'validating';at:string;tool?:string;message?:string;count?:number;phase?:'started'|'completed';step?:number}[];error?:{message:string};execution?:import('@mote/shared').ExecutionEnvelope}
const tools:Record<string,string>={search_context:moteText("检索上下文"),timeline:moteText("浏览时间线"),evidence:moteText("展开原始证据"),activity:moteText("核对采样时长"),media_activity:moteText("核对媒体活动"),devices:moteText("查看设备"),sources:moteText("查看资料来源"),source_items:moteText("读取来源记录"),source_history:moteText("查阅历史版本"),memories:moteText("检索记忆"),file_chunks:moteText("读取文件片段")};
export function progressLabel(e:QueryRun['events'][number]):string {
  if(e.message)return e.message;
  if(e.stage==='tool')return `${tools[e.tool??'']??moteText("读取资料")}${e.phase==='started'?moteText(" · 正在执行"):moteText(" · 返回 {0} 项", e.count??0)}`;
  return {starting:moteText("准备只读查询"),model:moteText("模型正在分析{0}，决定下一步检索或组织回答", e.step!==undefined?moteText(" · 第 {0} 步", e.step+1):''),validating:moteText("校验回答格式和证据引用")}[e.stage];
}
export function QueryProgress({run,error}:{run:QueryRun;error:string}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(run.status!=='running')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[run.status]);
  const seconds=Math.max(0,Math.floor(((run.status==='running'?now:Date.parse(run.updatedAt))-Date.parse(run.createdAt))/1000));
  return <section className="panel query-progress" aria-label={moteText("对话执行进度")}><div className="section-heading"><h3>{run.status==='running'?<LoaderCircle size={18} className="spin"/>:run.status==='completed'?<CheckCircle2 size={18}/>:<AlertCircle size={18}/>} {run.status==='running'?moteText("正在处理"):run.status==='completed'?moteText("回答已归档"):moteText("此次未完成")}</h3><span className="badge muted">{Math.floor(seconds/60)}{' '}{moteText("分")}{' '}{seconds%60}{' '}{moteText("秒")}</span></div>
    <p role={run.status==='failed'?'alert':'status'}>{run.status==='running'?(run.events.length?progressLabel(run.events.at(-1)!):moteText("正在启动 Agent…")):run.status==='cancelled'?moteText("已停止"):run.error?.message??moteText("可继续提问。")}</p>
    {run.status==='running'&&<p className="fine-print">{moteText("可以切换页面或刷新，中央节点会继续执行。")}</p>}
    {error&&<p className="notice error" role="alert">{error}{' '}{moteText("正在自动重新连接；请勿重复发送。")}</p>}
    <details open={run.status==='running'}><summary>{moteText("执行记录 ·")}{' '}{run.events.length}{' '}{moteText("条")}</summary><ol className="query-steps">{run.events.map((e,i)=><li key={`${e.at}-${i}`}><time>{new Date(e.at).toLocaleTimeString(getLocale())}</time><span>{progressLabel(e)}</span></li>)}</ol></details>
    <p className="fine-print">{moteText("展示实际执行阶段与工具进度，不展示模型内部思维链。")}</p>
  </section>;
}
