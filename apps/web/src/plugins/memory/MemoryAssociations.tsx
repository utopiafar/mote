import {useEffect,useRef,useState} from 'react';
import {formatEvidenceRef,type QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,type Range,dateTime,errorMessage} from '../../api';
import {Loading} from '../../Loading';
import {useResource} from '../../useResource';
import type {Memory} from './Memories';
import {refreshMemoryResources} from './memory-resources';

/** Fields consumed from the existing commitment projection. Identity is the
 * exact personMemoryId; titles never participate in association or dedup. */
interface Commitment {
  id:string;revision:number;title:string;personMemoryId:string|null;matterId:string|null;
  status:'pending_confirmation'|'confirmed'|'completed'|'cancelled';
  deadline:{text:string;at:string|null}|null;dueState:'none'|'unknown'|'closed'|'overdue'|'upcoming';
  evidenceDependencies:{version:1;complete:true;ids:string[]};
  timeline:{eventId:string;origin:'proposal'|'owner';kind?:'commitment'|'progress'|'status'|'reminder';occurredAt:string|null;createdAt:string;summary:string;evidence:{id:string;offset:number;quote:string}[]}[];
}
interface CommitmentPage {items:Commitment[];nextCursor:string|null}

function path(range:Range,personMemoryId?:string,cursor?:string){
  const scope:QueryScope={kind:'all',...range};
  return '/api/assistant/commitments?'+new URLSearchParams({scope:JSON.stringify(scope),limit:'30',...(personMemoryId?{personMemoryId}:{}),...(cursor?{cursor}:{})});
}
function PageButtons({cursor,next,onChange}:{cursor?:string;next?:string|null;onChange:(cursor?:string)=>void}){
  return <div className="memory-actions">{cursor&&<button className="button subtle" onClick={()=>onChange()}>{moteText('返回第一页')}</button>}{next&&<button className="button subtle" onClick={()=>onChange(next)}>{moteText('下一页')}</button>}</div>;
}
function Person({api,id,range,selected,commitments,onSelect}:{api:Api;id:string;range:Range;selected?:string|null;commitments:Commitment[];onSelect:(id:string)=>void}){
  const read=useResource<Memory>(api,'/api/memories/'+encodeURIComponent(id)+'?'+new URLSearchParams({...range}));
  const item=read.error===undefined&&read.data?.id===id?read.data:undefined;
  if(!item)return read.loading?<Loading/>:<p role="alert">{read.error!==undefined?errorMessage(read.error):moteText('中央响应格式无效，请刷新后重试。')}<button className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>;
  return <button className={'workspace-select '+(selected===id?'active':'')} data-person-memory={id} onClick={()=>onSelect(id)}>
    <span className="memory-row-copy"><strong>{item.title}</strong>{item.statement&&<span className="memory-row-excerpt">{item.statement}</span>}{item.admission?.scope&&<small>{item.admission.scope}</small>}<small>{moteText('本页 {0} 条承诺',commitments.length)} · {moteText('本页关联 {0} 个事项',new Set(commitments.flatMap(item=>item.matterId?[item.matterId]:[])).size)}</small></span>
  </button>;
}

/** People are references supplied by Memory and commitments, not entities inferred from
 * strings. A person with no goal, deadline or matter remains a valid row. */
export function MemoryPeople({api,range,selected,onSelect}:{api:Api;range:Range;selected?:string|null;onSelect:(id:string)=>void}){
  const selection=JSON.stringify(range),[page,setPage]=useState<{api:Api;selection:string;cursor?:string}>();
  const cursor=page?.api===api&&page.selection===selection?page.cursor:undefined;
  const read=useResource<CommitmentPage>(api,path(range,undefined,cursor),10000);
  const items=read.error===undefined?read.data?.items:undefined;
  const groups=new Map<string,Commitment[]>();
  for(const item of items??[])if(item.personMemoryId){const values=groups.get(item.personMemoryId)??[];values.push(item);groups.set(item.personMemoryId,values);}
  return <aside className="workspace-list memory-people" aria-label={moteText('人物')}>
    <div className="workspace-list-heading"><h2>{moteText('人物')}</h2></div>
    <p className="muted">{moteText('按已关联的记忆身份浏览；同名人物分别保留。')}</p>
    {read.loading&&!read.data&&<Loading/>}
    {read.error!==undefined&&<p role="alert">{errorMessage(read.error)}<button className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {items&&!groups.size&&<p role="status" className="muted">{moteText('本页暂无已关联的人物。可继续浏览记忆或主题。')}</p>}
    {[...groups].map(([id,commitments])=><Person key={id} api={api} id={id} range={range} selected={selected} commitments={commitments} onSelect={onSelect}/>)}
    <PageButtons cursor={cursor} next={read.error===undefined?read.data?.nextCursor:undefined} onChange={cursor=>setPage({api,selection,cursor})}/>
  </aside>;
}

export function MemoryCommitments({api,memory,range,onOpen}:{api:Api;memory:Memory;range:Range;onOpen:(ref:string)=>void}){
  return <CommitmentList api={api} memories={[memory]} personMemoryId={memory.id} range={range} onOpen={onOpen}/>;
}

/** Topic membership is supplied by the scoped Memory reader. Only explicit
 * person/dependency references connect a commitment to these members. */
export function MemoryTopicCommitments({api,memories,range,onOpen}:{api:Api;memories:Memory[];range:Range;onOpen:(ref:string)=>void}){
  return <CommitmentList api={api} memories={memories} range={range} onOpen={onOpen}/>;
}

function CommitmentList({api,memories,personMemoryId,range,onOpen}:{api:Api;memories:Memory[];personMemoryId?:string;range:Range;onOpen:(ref:string)=>void}){
  const selection=JSON.stringify([memories.map(item=>[item.id,item.version,item.fingerprint]),personMemoryId,range]),[page,setPage]=useState<{api:Api;selection:string;cursor?:string}>();
  const cursor=page?.api===api&&page.selection===selection?page.cursor:undefined;
  const readPath=memories.length?path(range,personMemoryId,cursor):null,read=useResource<CommitmentPage>(api,readPath,readPath?10000:undefined);
  const ids=new Set(memories.map(item=>item.id));
  const matches=(item:Commitment)=>personMemoryId?item.personMemoryId===personMemoryId:
    Boolean(item.personMemoryId&&ids.has(item.personMemoryId))||item.evidenceDependencies.ids.some(id=>ids.has(id));
  const [proofError,setProofError]=useState(''),request=useRef<AbortController|undefined>(undefined),owner=useRef({api,selection});owner.current={api,selection};
  useEffect(()=>{setProofError('');return()=>request.current?.abort();},[api,selection]);
  async function openProof(item:Commitment,eventId:string,proof:Commitment['timeline'][number]['evidence'][number]){
    if(!readPath)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;setProofError('');
    const current=()=>!controller.signal.aborted&&owner.current.api===api&&owner.current.selection===selection;
    try{
      const latest=await api.request<CommitmentPage>(readPath,{signal:controller.signal});
      const verified=latest.items.find(value=>value.id===item.id&&value.revision===item.revision&&matches(value))?.timeline
        .find(value=>value.eventId===eventId)?.evidence.some(value=>value.id===proof.id&&value.offset===proof.offset&&value.quote===proof.quote);
      if(!verified)throw Error(moteText('请求的操作或资源已失效，请重新读取后再确认。'));
      if(current())onOpen(formatEvidenceRef('capture',proof.id));
    }catch(error){if(current()){setProofError(errorMessage(error));refreshMemoryResources(api,true);}}
  }
  const items=read.error===undefined?(readPath?read.data?.items.filter(matches):[]):undefined;
  const statuses={pending_confirmation:moteText('待确认'),confirmed:moteText('已确认'),completed:moteText('已完成'),cancelled:moteText('已取消')};
  return <section className="memory-associations" aria-label={moteText('相关承诺与互动')}>
    <h3>{moteText('相关承诺与互动')}</h3>
    {!personMemoryId&&<p className="muted">{moteText('仅汇总本页记忆与本页承诺的显式关联。')}</p>}
    {proofError&&<p role="alert">{proofError}</p>}
    {read.loading&&!read.data&&<Loading/>}
    {read.error!==undefined&&<p role="alert">{errorMessage(read.error)}<button className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {items&&!items.length&&<p className="muted">{personMemoryId?moteText('当前范围内暂无关联的承诺或互动。'):moteText('本页暂无关联的承诺或互动。')}</p>}
    {!!items?.length&&<p className="muted">{moteText('本页关联 {0} 个事项',new Set(items.flatMap(item=>item.matterId?[item.matterId]:[])).size)}</p>}
    {items?.map(item=><article className="review-notes" key={item.id} data-commitment={item.id}>
      <h4>{item.title}</h4><p>{statuses[item.status]}{item.deadline&&<> · {item.deadline.text} · {item.deadline.at?dateTime(item.deadline.at):moteText('期限未明确')}</>}{item.dueState==='overdue'&&<> · {moteText('已到期，履行情况以证据为准。')}</>}</p>
      <details><summary>{moteText('互动与进展')}</summary>{item.timeline.map(event=><article key={event.eventId}>
        <small>{event.origin==='owner'?moteText('用户纠正'):moteText('模型生成')} · {event.occurredAt?dateTime(event.occurredAt):moteText('发生时间未知')} · {moteText('归档时间')}{' '}{dateTime(event.createdAt)}</small>
        <p>{event.summary}</p>{event.evidence.map((proof,index)=><button className="text-button" key={proof.id+':'+index} onClick={()=>void openProof(item,event.eventId,proof)}>{moteText('查看原始记录')}{' · '}{proof.quote}</button>)}
      </article>)}</details>
    </article>)}
    <PageButtons cursor={cursor} next={read.error===undefined?read.data?.nextCursor:undefined} onChange={cursor=>setPage({api,selection,cursor})}/>
  </section>;
}
