import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,ApiError,errorMessage} from './api';
import {useResource} from './useResource';
import {FeatureView} from './features/runtime';
import {AnswerMarkdown} from './AnswerMarkdown';
import {memoryMaterialRoute} from './memory-source-route';
export type Material={id:string;ref:string;revision:string;kind:string;schemaVersion:number;title:string;sequence:number;textLength:number;blockCount:number;coverage:{state:string;reason?:string};origin:{sourceId:string;provider?:string;sessionId?:string};artifacts?:{key:string;state:string;reason?:string}[];retention:{original:string};memorySource?:{status:'ready'|'waiting'|'unavailable'|'too_large';evidenceIds:string[]}};
type ReadPage={material:Material;text:string;textRange:{offset:number;total:number;nextOffset:number|null}};
type Scope={deviceId?:string;after?:string;before?:string};
export function MaterialDetail({api,material,onOpen,agent=false,scope={}}:{api:Api;material:Material;onOpen:(ref:string)=>void;agent?:boolean;scope?:Scope}){
  const [offset,setOffset]=useState(0),[tab,setTab]=useState('body');
  // Each range is pinned to the selected revision. Identity is also the React key.
  const scopeQuery=new URLSearchParams(scope).toString();
  const read=useResource<ReadPage>(api,agent?`/api/agent-view/material-read?ref=${encodeURIComponent(material.ref)}&offset=${offset}&${scopeQuery}`:`/api/materials/${encodeURIComponent(material.id)}/read?revision=${material.revision}&offset=${offset}&length=4000`,5000);
  const current=useResource<Material>(api,agent?null:`/api/materials/${encodeURIComponent(material.id)}`,5000);
  const members=useResource<{items:{id:string;kind:string;ref:string}[];nextOffset:number|null}>(api,!agent&&tab==='origin'?`/api/materials/${encodeURIComponent(material.id)}/members?revision=${material.revision}&offset=${offset}&limit=20`:null);
  const selected=current.error===undefined&&current.data?.revision===material.revision?current.data:read.error===undefined?read.data?.material??material:material;
  const rebuilding=selected.coverage.reason==='source_evidence_changed'||read.error instanceof ApiError&&read.error.status===409;
  const historical=current.error===undefined&&current.data&&current.data.revision!==material.revision;
  const memorySource=!agent&&!historical&&current.error===undefined&&current.data?.ref===material.ref?current.data.memorySource:undefined;
  const retry=()=>{read.refresh();current.refresh();};
  return <article className="panel panel-pad material-detail"><h2>{selected.title}</h2><p><code>{selected.kind}</code> · {moteText('版本 {0}',selected.sequence)} · {selected.coverage.state}</p>
    {historical&&<p role="status">{moteText('这是历史版本，当前资料已更新。')} <button className="button" onClick={()=>onOpen(current.data!.ref)}>{moteText('查看当前版本')}</button></p>}
    {memorySource?.status==='ready'&&<a className="button" href={memoryMaterialRoute(selected.ref)}>{moteText('仅从这份正式资料提取记忆')}</a>}
    {memorySource&&memorySource.status!=='ready'&&<p role="status">{moteText('这份正式资料暂不能单独提取记忆，请查看来源与处理状态。')}</p>}
    <nav className="section-tabs">{[['body',moteText('正文')],['origin',moteText('来源与处理')]].map(([id,label])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>{setTab(id);setOffset(0);}}>{label}</button>)}</nav>
    {rebuilding?<p role="status">{moteText('来源已更正，正在重新整理资料。完成后可继续查看。')} <button onClick={retry}>{moteText('刷新')}</button></p>:read.error!==undefined&&<p role="alert">{errorMessage(read.error)} <button onClick={retry}>{moteText('重试')}</button></p>}
    {current.error!==undefined&&<p role="alert">{errorMessage(current.error)} <button onClick={retry}>{moteText('重试')}</button></p>}
    {tab==='body'&&!rebuilding&&read.error===undefined&&current.error===undefined&&read.data&&<FeatureView api={api} onOpen={onOpen} value={{...selected,representation:agent?'markdown':'owner-material',text:read.data.text}} fallback={<><AnswerMarkdown onOpen={onOpen} answer={{answer:read.data.text,runId:selected.ref,trace:[],citations:[]}}/><p className="fine-print">{moteText('从第 {0} 个字符开始',offset+1)} · {read.data.textRange.total}</p><div className="processing-actions">{offset>0&&<button className="button" onClick={()=>setOffset(0)}>{moteText('返回第一页')}</button>}{read.data.textRange.nextOffset!==null&&<button className="button" onClick={()=>setOffset(read.data!.textRange.nextOffset!)}>{moteText('继续展开')}</button>}</div></>}/>}
    {tab==='origin'&&<><dl><dt>{moteText('来源')}</dt><dd>{selected.origin.sourceId}</dd><dt>{moteText('原始记录')}</dt><dd>{selected.retention.original}</dd><dt>{moteText('覆盖状态')}</dt><dd>{selected.coverage.state} {selected.coverage.reason}</dd></dl><h3>{moteText('已记录的处理产物')}</h3>{selected.artifacts?.map(a=><p key={a.key}>{a.key} · {a.state} {a.reason}</p>)}{!agent&&<><h3>{moteText('来源与定位')}</h3>{members.error!==undefined&&<p role="alert">{errorMessage(members.error)}</p>}{members.data?.items.map(m=><p key={m.id}><code>{m.kind} · {m.ref}</code></p>)}{members.data?.nextOffset!=null&&<button className="button" onClick={()=>setOffset(members.data!.nextOffset!)}>{moteText('下一页')}</button>}</>}</>}
  </article>;
}
export function Materials({api,onOpen,kind,sourceId,agent=false,scope={}}:{api:Api;onOpen:(ref:string)=>void;kind?:string;sourceId?:string;agent?:boolean;scope?:Scope}){
  const [cursor,setCursor]=useState<string>(),[selected,setSelected]=useState<Material>();
  const query=new URLSearchParams({limit:'12',...(cursor?{cursor}:{}),...(kind?{kind}:{}),...(sourceId?{sourceId}:{}),...scope});
  const page=useResource<{items:Material[];nextCursor:string|null}>(api,(agent?'/api/agent-view/materials':'/api/materials')+'?'+query);
  return <section className="materials-browser"><div className="page-heading"><h1>{moteText('正式资料')}</h1><p>{moteText('查看中央端发布的正文、版本、来源和处理产物。')}</p></div><button className="button" onClick={()=>{setSelected(undefined);page.refresh();}}>{moteText('刷新')}</button>{page.error!==undefined&&<p role="alert">{errorMessage(page.error)}</p>}{page.loading&&!page.data&&<p role="status">{moteText('正在读取…')}</p>}
    {page.data&&<><div className="feature-cards">{page.data.items.map(m=><button className="panel source-item" key={m.ref} onClick={()=>setSelected(m)}><strong>{m.title}</strong><p>{m.kind} · {m.coverage.state} · {m.textLength}</p></button>)}</div>{!page.data.items.length&&<p>{moteText('当前范围内暂无已发布资料。')}</p>}<div className="processing-actions">{cursor&&<button className="button" onClick={()=>{setCursor(undefined);setSelected(undefined);}}>{moteText('返回第一页')}</button>}{page.data.nextCursor&&<button className="button" onClick={()=>{setCursor(page.data!.nextCursor!);setSelected(undefined);}}>{moteText('下一页')}</button>}</div></>}
    {selected&&page.error===undefined&&<MaterialDetail key={selected.ref} api={api} material={selected} onOpen={onOpen} agent={agent} scope={scope}/>}
  </section>;
}
