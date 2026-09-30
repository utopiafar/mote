import {useEffect,useState} from 'react';
import {Eye,Folder,FileText,ChevronRight,ArrowLeft} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {Materials} from './Materials';
import {StartupPreview,RecordedInput} from './agent-view-input';

type Scope={deviceId?:string;after?:string;before?:string};
type Entry={path?:string;ref?:string;id?:string;title?:string;windowTitle?:string;appName?:string;preview?:string;expand?:string;layer?:string;revision?:string;status?:string;coverage?:string};
type Page={entries?:Entry[];items?:Entry[];nextCursor?:string|null};
type Detail=Entry&{statement?:string;uncertainty?:string;ocrText?:string;text?:string;members?:string[];evidence?:{id:string;quote:string}[];textRange?:{offset:number;total:number;nextOffset:number|null}};
type Details={items:Detail[];references?:{id:string}[];sourceCoverage?:{partial:boolean};sourceSpans?:{record:{id:string;ocrText:string};offset:number;length:number}[]};
const directories=[
 {path:'/context/memory',name:'memory',label:()=>moteText('精选记忆'),description:()=>moteText('记忆卡片、陈述、不确定性与支持证据'),layer:'L3 / L4'},
 {path:'/context/episodes',name:'episodes',label:()=>moteText('片段与理解'),description:()=>moteText('处理后的活动片段与语义产物'),layer:'L2'},
 {path:'/context/sources',name:'sources',label:()=>moteText('来源与原文'),description:()=>moteText('来源、当前条目与可读取的正文'),layer:'L0 / L1'},
];
function query(scope:Scope,values:Record<string,string|number|undefined>={}){
 return new URLSearchParams(Object.entries({...scope,...values}).filter(([,v])=>v!==undefined&&v!=='').map(([k,v])=>[k,String(v)])).toString();
}
function EntryDetail({api,entry,scope,onSelect}:{api:Api;entry:Entry;scope:Scope;onSelect:(entry:Entry)=>void}){
 const [offset,setOffset]=useState(0);
 const endpoint=entry.expand==='memories'?'memories':entry.expand==='segments'?'segments':'evidence';
 const id=endpoint==='segments'?entry.ref:entry.id;
 const page=useResource<Details>(api,`/api/agent-view/${endpoint}?`+query(scope,{id,includeEvidence:endpoint==='memories'?'true':undefined,offset:endpoint==='evidence'?offset:undefined}));
 return <section className="panel panel-pad agent-detail" aria-label={moteText('条目内容')}>
  <h2>{entry.title??entry.windowTitle??entry.appName??entry.layer??entry.id}</h2><p className="badge muted">{moteText('可访问 · 本次浏览展开')}</p>
  {page.loading&&!page.data&&<p role="status">{moteText('正在读取…')}</p>}{page.error!==undefined&&<p role="alert">{errorMessage(page.error)} <button className="text-button" onClick={page.refresh}>{moteText('重试')}</button></p>}
  {page.data&&!page.data.items.length&&<p>{moteText('当前范围内没有可读取的内容。')}</p>}
  {page.data?.items.map((item,i)=><div key={item.id??i}>
   <p className="fine-print">{item.status} {item.revision}</p><div className="agent-body">{item.statement??item.ocrText??item.text}</div>
   {item.uncertainty&&<p><strong>{moteText('不确定性')}</strong> · {item.uncertainty}</p>}
   {item.evidence?.map(e=><blockquote key={e.id}>{e.quote}<button className="text-button" onClick={()=>onSelect({id:e.id,expand:'evidence',title:moteText('原始证据')})}>{moteText('读取原始证据')}<ChevronRight size={14}/></button></blockquote>)}
   {item.members?.length&&<details><summary>{moteText('支持证据')} · {item.members.length}</summary>{item.members.map(id=><button className="agent-ref text-button" key={id} onClick={()=>onSelect({id,expand:'evidence',title:moteText('原始证据')})}>{id}<ChevronRight size={14}/></button>)}</details>}
   {item.textRange&&<><p className="fine-print">{moteText('已展开 {0}–{1} / {2} 个字符',item.textRange.offset,Math.min(item.textRange.offset+4000,item.textRange.total),item.textRange.total)}</p><div className="processing-actions">{offset>0&&<button className="button" onClick={()=>setOffset(0)}>{moteText('返回第一页')}</button>}{item.textRange.nextOffset!==null&&<button className="button" onClick={()=>setOffset(item.textRange!.nextOffset!)}>{moteText('继续展开')}</button>}</div></>}
  </div>)}
  {page.data?.sourceSpans?.map(span=><div className="agent-proof" key={span.record.id}><strong>{moteText('已核验的支持原文')}</strong><div className="agent-body">{span.record.ocrText.slice(span.offset,span.offset+span.length)}</div></div>)}
  {page.data?.sourceCoverage?.partial&&<p className="fine-print">{moteText('支持原文仅部分展开，请按需继续读取。')}</p>}
 </section>;
}
function Catalog({api,scope,onOpen}:{api:Api;scope:Scope;onOpen:(ref:string)=>void}){
 const [path,setPath]=useState('/context'),[source,setSource]=useState<Entry>(),[cursor,setCursor]=useState<string>(),[selected,setSelected]=useState<Entry>();
 const page=useResource<Page>(api,path==='/materials'?null:source?'/api/agent-view/source-items?'+query(scope,{sourceId:source.id,cursor}):'/api/agent-view/catalog?'+query(scope,{path,cursor}));
 const go=(next:string)=>{setPath(next);setSource(undefined);setCursor(undefined);setSelected(undefined);};
 const entries=page.data?.entries??page.data?.items??[];
 const select=(entry:Entry)=>{if(entry.path)go(entry.path);else if(entry.expand==='source_items'){setSource(entry);setCursor(undefined);setSelected(undefined);}else setSelected({...entry,expand:entry.expand??'evidence'});};
 return <div className="agent-browser">
  <nav className="agent-tree" aria-label={moteText('Agent 目录')}><button aria-current={path==='/context'?'page':undefined} onClick={()=>go('/context')}><Folder size={17}/>/context</button>{directories.map(dir=><button key={dir.path} aria-current={path===dir.path?'page':undefined} onClick={()=>go(dir.path)}><Folder size={16}/>{dir.name}<small>{dir.layer}</small></button>)}<button aria-current={path==='/materials'?'page':undefined} onClick={()=>go('/materials')}><FileText size={16}/>{moteText('正式资料')}</button><p>{moteText('这是只读虚拟目录，目录条目按需披露。')}</p></nav>
  <div className="agent-content"><div className="agent-breadcrumb"><button className="text-button" onClick={()=>go('/context')}>/context</button>{path!=='/context'&&<><ChevronRight size={14}/><button className="text-button" onClick={()=>go(path)}>{path.split('/').at(-1)}</button></>}{source&&<><ChevronRight size={14}/><span>{source.title}</span></>}</div>
   {path==='/materials'?<Materials api={api} agent scope={scope} onOpen={onOpen}/>:<>
    {path==='/context'&&<p>{moteText('从目录开始，逐层展开 Agent 可以读取的内容。')}</p>}
    {page.loading&&!page.data&&<p role="status">{moteText('正在读取…')}</p>}{page.error!==undefined&&<p role="alert">{errorMessage(page.error)} <button className="text-button" onClick={page.refresh}>{moteText('重试')}</button></p>}
    <div className="agent-entries">{entries.map((entry,i)=>{const dir=directories.find(d=>d.path===entry.path);return <button className="agent-entry source-item" key={entry.path??entry.ref??entry.id??i} onClick={()=>select(entry)}>{entry.path||entry.expand==='source_items'?<Folder size={19}/>:<FileText size={19}/>}<span><strong>{dir?dir.name:entry.title??entry.windowTitle??entry.appName??entry.layer??entry.id}</strong><small>{dir?dir.label()+' · '+dir.description():entry.preview??entry.status??entry.layer}</small>{!entry.path&&<code>{entry.ref??entry.id}</code>}</span><ChevronRight size={17}/></button>;})}</div>
    {page.data&&!entries.length&&<p>{moteText('当前范围内暂无条目。没有列出不代表不存在。')}</p>}
    <div className="processing-actions">{source&&<button className="button" onClick={()=>{setSource(undefined);setCursor(undefined);setSelected(undefined);}}><ArrowLeft size={14}/>{moteText('返回来源目录')}</button>}{cursor&&<button className="button" onClick={()=>{setCursor(undefined);setSelected(undefined);}}>{moteText('返回第一页')}</button>}{page.data?.nextCursor&&<button className="button" onClick={()=>{setCursor(page.data!.nextCursor!);setSelected(undefined);}}>{moteText('下一页')}</button>}</div>
    {selected&&<EntryDetail key={selected.ref??selected.id} api={api} entry={selected} scope={scope} onSelect={setSelected}/>}
   </>}
   <p className="fine-print">{moteText('可访问不代表已进入某次回答。原始 Coding 事件包和内部磁盘路径不在此目录公开。')}</p>
  </div>
 </div>;
}
export function AgentInspector({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
 const [tab,setTab]=useState('catalog'),[deviceId,setDeviceId]=useState(''),[after,setAfter]=useState(''),[before,setBefore]=useState('');
 const [runId,setRunId]=useState(()=>new URLSearchParams(location.hash.split('?')[1]).get('runId')??'');
 useEffect(()=>{if(runId)setTab('input');},[]);
 const scope:Scope={...(deviceId?{deviceId}:{}),...(after?{after:new Date(after).toISOString()}:{}),...(before?{before:new Date(before).toISOString()}:{})};
 return <div className="agent-inspector"><div className="page-heading"><div className="eyebrow"><Eye size={15}/> Mote / Agent</div><h1>{moteText('Agent 视角')}</h1><p>{moteText('打开它的目录，分清能访问什么、首次收到什么，以及实际读了什么。')}</p></div>
  <nav className="section-tabs" aria-label={moteText('Agent 视角')}>{[['catalog',moteText('可访问范围')],['startup',moteText('首次上下文')],['materials',moteText('正式资料')],['input',moteText('实际输入与读取轨迹')]].map(([id,label])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>setTab(id)}>{label}</button>)}</nav>
  {tab!=='input'&&<div className="agent-scope"><label>{moteText('设备范围')}<input value={deviceId} placeholder={moteText('全部设备')} onChange={e=>setDeviceId(e.target.value)}/></label><label>{moteText('开始时间')}<input type="datetime-local" value={after} onChange={e=>setAfter(e.target.value)}/></label><label>{moteText('结束时间')}<input type="datetime-local" value={before} onChange={e=>setBefore(e.target.value)}/></label></div>}
  {tab==='catalog'&&<Catalog key={JSON.stringify(scope)} api={api} scope={scope} onOpen={onOpen}/>}
  {tab==='startup'&&<StartupPreview api={api} scope={scope}/>}
  {tab==='materials'&&<Materials key={JSON.stringify(scope)} api={api} agent scope={scope} onOpen={onOpen}/>}
  {tab==='input'&&<RecordedInput api={api} runId={runId} setRunId={setRunId}/>}
 </div>;
}
