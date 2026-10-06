import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,ApiError,errorMessage} from './api';
import {useResource} from './useResource';

type View={wait:'running'|'unknown'|null;original:{state:string};automatic:boolean;understandingEnabled:boolean;policy?:{profile:{name:string;processorId:string}};jobs:{name:string;state:string;error?:string}[];products:{id:string;name:string;kind:string;text:string;generatedAt:string}[];materials:{id:string;state:string}[];memory:{state:string;count:number;error?:string}[]};
const states:Record<string,string>={ready:'已就绪',indexed:'已就绪',succeeded:'已完成',completed:'已完成',pending:'等待处理',waiting:'等待处理',queued:'等待处理',running:'处理中',blocked:'等待配置或格式支持',failed:'处理失败',cancelled:'已取消',unavailable:'原件不可用',disabled:'未安排',not_scheduled:'未安排',waiting_for_input:'等待资料',waiting_for_model:'等待模型配置',paused:'已暂停',stale:'来源变化待重验'};
export function ImageProgress({api,id}:{api:Api;id:string}){
 const read=useResource<View>(api,'/api/images/'+encodeURIComponent(id),5000),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmUnknown,setConfirmUnknown]=useState(false);
 if(read.error instanceof ApiError&&read.error.status===404)return null;
 if(!read.data?.original)return read.error?<p role="alert">{errorMessage(read.error)}</p>:null;
 const value=read.data,archive=value.policy?.profile.processorId==='archive';
 const label=(state:string)=>moteText(states[state]??'处理未完成');
 const phase=(name:string)=>{const job=value.jobs.find(j=>j.name===name),product=value.products.find(p=>p.name===name);return product?moteText('已就绪'):archive||name==='understanding'&&!value.understandingEnabled?moteText('未安排'):!value.automatic?moteText('历史未安排'):job?label(job.state):value.automatic?moteText('等待处理'):moteText('历史未安排');};
 async function action(path:string,body:unknown){setBusy(true);setError('');try{await api.request('/api/images/'+id+'/'+path,{method:'POST',body:JSON.stringify(body)});read.refresh();}catch(error){setError(errorMessage(error));}finally{setBusy(false);}}
 return <section className="policy-card image-progress" aria-label={moteText('图片处理进度')}><h3>{moteText('图片处理进度')}</h3>{value.policy&&<p>{moteText('中央图片方案')} · {value.policy.profile.name}</p>}
 <dl><dt>{moteText('原件')}</dt><dd>{label(value.original.state)}</dd><dt>{moteText('文字识别')}</dt><dd>{phase('ocr')}</dd><dt>{moteText('内容理解')}</dt><dd>{phase('understanding')}</dd><dt>{moteText('资料索引')}</dt><dd>{value.materials.length?value.materials.map(m=>label(m.state)).join(' / '):moteText('等待资料')}</dd><dt>Memory</dt><dd>{value.memory.length?value.memory.map(m=>m.state==='completed'&&m.count===0?moteText('已完成，未生成新记忆'):label(m.state)).join(' / '):moteText('未安排')}</dd></dl>
 {value.products.filter(p=>p.kind!=='ocr').map(p=><details key={p.id}><summary>{p.name==='understanding'?moteText('查看图片理解'):p.name}</summary><p>{moteText('以下为模型解释，原图与 OCR 是原始证据。')}</p><pre className="library-original-text">{p.text}</pre></details>)}
 {value.jobs.filter(j=>j.error&&j.state!=='succeeded').map(j=><p key={j.name}>{j.name==='ocr'?moteText('文字识别'):j.name==='understanding'?moteText('内容理解'):j.name} · {label(j.state)} <code>{j.error}</code></p>)}
 {value.wait==='unknown'&&<label><input type="checkbox" checked={confirmUnknown} onChange={e=>setConfirmUnknown(e.target.checked)}/>{moteText('上次处理是否结束未知，重试可能重复执行。请确认后继续。')}</label>}{error&&<p role="alert">{error}</p>}<div className="source-toolbar"><button className="button" disabled={busy||value.wait==='running'||value.wait==='unknown'&&!confirmUnknown} onClick={()=>void action('retry',{mode:'complete',confirmUnknown})}>{moteText('补齐未完成步骤')}</button><button className="button" disabled={busy||value.wait==='running'||value.wait==='unknown'&&!confirmUnknown} onClick={()=>void action('retry',{mode:'recompute',confirmUnknown})}>{moteText('重新计算已有结果')}</button>{value.jobs.some(j=>['waiting','running','blocked','failed'].includes(j.state))&&<button className="button" disabled={busy} onClick={()=>void action('cancel',{})}>{moteText('停止处理')}</button>}</div></section>;
}
