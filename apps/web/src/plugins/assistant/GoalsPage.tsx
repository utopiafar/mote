import {goalsViewSchema,pageHash,type AboutRef,type GoalGroup,type GoalItem,type GoalsView,type Matter,type MatterTemplate} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {Ban,Check,FileText,MessageCircle,Plus,X} from 'lucide-react';
import React,{useContext,useEffect,useMemo,useRef,useState} from 'react';
import {ActionDialog} from '../work/ActionDialog';
import {ApiError,ago,errorMessage,type Api} from '../../api';
import {chatHref} from '../../chat-link';
import {Loading} from '../../Loading';
import {resources} from '../../resource-cache';
import {useForegroundResources} from '../../useForegroundResources';
import {useResource} from '../../useResource';
import {NavStateContext} from '../../use-nav-state';
import {useUnsavedChanges} from '../../unsaved';
import {all,scoped,useAssistantCapabilities} from './common';

type Grouping='matter'|'person';
type Draft={title:string;due:string};
type Edit={matterId:string;revision:number;goal:string};
type MatterPage={items:Matter[];nextCursor:string|null};
type Section='theirs'|'mine'|'unconfirmed';

const emptyDraft=():Draft=>({title:'',due:''});
const itemCount=(group:GoalGroup)=>group.theirs.length+group.mine.length+group.unconfirmed.length;
const templateLabels:Record<MatterTemplate,string>={project:'项目',travel:'旅行',reading:'阅读'};
const matterHref=(id:string,template?:MatterTemplate)=>'#/assistant/workbench?'+new URLSearchParams({matter:id,...(template?{template}:{})});
const libraryHref=(id:string)=>pageHash('library',{matter:id});
const groupTitle=(group:GoalGroup)=>group.key.kind==='matter'?group.key.title:group.key.kind==='person'?group.key.name:moteText('其他');
const groupId=(group:GoalGroup)=>group.key.kind==='matter'?'matter:'+group.key.id:group.key.kind==='person'?'person:'+group.key.name:'none';
const sectionLabels:Record<Section,string>={theirs:'等别人',mine:'我要做',unconfirmed:'待确认'};

/** One page over the existing goal projection. Every write is a precise
 * revision-carrying command from the item or matter; the page never infers an
 * available action or rewrites a conflict. */
export function GoalsPage({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
  const [grouping,setGrouping]=useState<Grouping>('matter');
  const [addOpen,setAddOpen]=useState(false);
  const [draft,setDraft]=useState<Draft>(emptyDraft);
  const [edit,setEdit]=useState<Edit>();
  const [busy,setBusy]=useState(false);
  const [commandError,setCommandError]=useState('');
  const request=useRef<AbortController|null>(null);
  const nav=useContext(NavStateContext);
  const can=useAssistantCapabilities(api);
  const canReadMatters=can('http:GET:/api/assistant/matters');
  const canCreate=can('http:POST:/api/assistant/goals');
  const canEditMatters=can('http:POST:/api/assistant/matter-commands');
  const revision=nav?nav.revisions.matters+':'+nav.revisions.commitments:undefined;
  const goalsPath=scoped('/api/assistant/goals',all,{group:grouping,tz:Intl.DateTimeFormat().resolvedOptions().timeZone});
  const mattersPath=scoped('/api/assistant/matters',all,{limit:'100'});
  const read=useResource<unknown>(api,goalsPath,undefined,revision);
  const mattersRead=useResource<MatterPage>(api,canReadMatters?mattersPath:null,undefined,nav?.revisions.matters);
  useForegroundResources(api,[goalsPath,canReadMatters?mattersPath:null]);
  useEffect(()=>()=>{request.current?.abort();request.current=null;},[api]);
  const parsed=useMemo(()=>{
    if(read.data===undefined||read.error!==undefined)return undefined;
    const value=goalsViewSchema.safeParse(read.data);
    return value.success?value.data:null;
  },[read.data,read.error]);
  const matters=useMemo(()=>new Map((mattersRead.data?.items??[]).map(matter=>[matter.id,matter])),[mattersRead.data]);
  const view:GoalsView|undefined=parsed??undefined;
  const groups=useMemo(()=>view?.groups.filter(group=>itemCount(group)>0)??[],[view]);
  const total=groups.reduce((count,group)=>count+itemCount(group),0);
  const loading=read.loading&&read.data===undefined;
  const invalid=parsed===null;
  useUnsavedChanges(Boolean(addOpen&&(draft.title.trim()||draft.due)||edit));

  const refresh=()=>resources(api).invalidate(key=>key.startsWith('/api/assistant/goals?')||key.startsWith('/api/assistant/matters?'));
  const run=async(path:string,body:unknown,onSaved?:()=>void)=>{
    if(request.current)return false;
    const controller=new AbortController(),owner=api;
    request.current=controller;setBusy(true);setCommandError('');
    try{
      await api.request(path,{method:'POST',body:JSON.stringify(body),signal:controller.signal});
      if(controller.signal.aborted||owner!==api)return false;
      refresh();onSaved?.();return true;
    }catch(error){
      if(controller.signal.aborted||owner!==api)return false;
      setCommandError(error instanceof ApiError&&error.status===409?moteText('事项已变化，需重新读取'):errorMessage(error));
      if(error instanceof ApiError&&[403,404,409,410].includes(error.status))refresh();
      return false;
    }finally{
      if(request.current===controller){request.current=null;setBusy(false);}
    }
  };
  const add=async()=>{
    const title=draft.title.trim(),due=draft.due?new Date(draft.due):undefined;
    if(!title)return;
    const saved=await run('/api/assistant/goals',{title,...(due&&Number.isFinite(due.getTime())?{due:{text:draft.due.replace('T',' '),at:due.toISOString()}}:{})});
    if(saved){setAddOpen(false);setDraft(emptyDraft());}
  };
  const saveMatter=(current:Matter)=>{
    if(!edit||edit.matterId!==current.id)return;
    void run('/api/assistant/matter-commands',{type:'edit',matterId:current.id,expectedRevision:edit.revision,goal:edit.goal},()=>setEdit(undefined));
  };
  const row=(group:GoalGroup,item:GoalItem)=>{
    const about:AboutRef|undefined=item.kind==='commitment'?{kind:'commitment',id:item.id}
      :group.key.kind==='matter'?{kind:'matter',id:group.key.id}
      :item.lastProgress?.evidenceId?{kind:'evidence',id:item.lastProgress.evidenceId}
      :item.kind==='todo'?{kind:'todo',id:item.id}
      :undefined;
    const who=item.direction==='mine'?moteText('我'):group.key.kind==='person'?group.key.name:moteText('别人');
    const follow=item.followup;
    return <article className="goals-row" data-item-id={item.id} data-kind={item.kind} key={item.kind+':'+item.id}>
      <div className="goals-row-line">
        <span className="goals-who">{who}</span>
        {item.due&&<span className="goals-due" data-state={item.dueState??'none'}>{item.due.text}
          {item.dueState==='overdue'&&<span className="visually-hidden">{moteText('已逾期')}</span>}
          {item.dueState==='today'&&<span className="visually-hidden">{moteText('今天')}</span>}
        </span>}
        <span className="goals-title">{item.title}</span>
        {item.actions.includes('reject')&&<button type="button" className="goals-inferred" disabled={busy}
          aria-label={moteText('否定推断')} onClick={()=>void run('/api/assistant/goals/'+encodeURIComponent(item.id)+'/action',{kind:item.kind,action:'reject',expectedRevision:item.revision})}>
          {moteText('推断')}<X size={12} aria-hidden="true"/>
        </button>}
      </div>
      {item.lastProgress&&<p className="goals-progress"><time dateTime={item.lastProgress.at}>{ago(item.lastProgress.at)}</time>
        <span> · {item.lastProgress.summary}</span>
        {item.lastProgress.evidenceId&&<button type="button" className="text-button" disabled={busy} onClick={()=>onOpen('capture:'+item.lastProgress!.evidenceId!)}>{moteText('查看原文')}</button>}
      </p>}
      {follow&&(follow.followed||item.actions.includes('follow'))&&<p className="goals-follow" role="status">
        {follow.followed?<span>{moteText('已交给 Mote')}</span>:<><span>{moteText('交给 Mote 盯着')}</span>
          {item.actions.includes('follow')&&<button type="button" className="button subtle" disabled={busy}
            onClick={()=>void run('/api/assistant/goals/'+encodeURIComponent(item.id)+'/follow',{expectedRevision:item.revision})}>{moteText('照做')}</button>}</>}
      </p>}
      <div className="goals-row-actions">
        {item.actions.includes('complete')&&<button type="button" className="goals-action" disabled={busy}
          aria-label={moteText('完成 {0}',item.title)} title={moteText('完成')}
          onClick={()=>void run('/api/assistant/goals/'+encodeURIComponent(item.id)+'/action',{kind:item.kind,action:'complete',expectedRevision:item.revision})}><Check size={17} aria-hidden="true"/></button>}
        {item.actions.includes('dismiss')&&<button type="button" className="goals-action" disabled={busy}
          aria-label={moteText('不需要')} title={moteText('不需要')}
          onClick={()=>void run('/api/assistant/goals/'+encodeURIComponent(item.id)+'/action',{kind:item.kind,action:'dismiss',expectedRevision:item.revision})}><Ban size={17} aria-hidden="true"/></button>}
        <a className="goals-action" aria-label={moteText('去聊')} title={moteText('去聊')} href={about?chatHref(about):pageHash('chat')}><MessageCircle size={17} aria-hidden="true"/></a>
      </div>
    </article>;
  };
  const head=(group:GoalGroup)=>{
    const matter=group.key.kind==='matter'?matters.get(group.key.id):undefined;
    const template=matter?.template??(group.key.kind==='matter'?group.key.template:undefined);
    return <header className="goals-group-head">
      {group.key.kind==='matter'?<a className="goals-group-title" href={matterHref(group.key.id,template)}>{groupTitle(group)}</a>:<h2 className="goals-group-title">{groupTitle(group)}</h2>}
      <span className="goals-count">{moteText('{0} 件',itemCount(group))}</span>
      {matter&&<div className="goals-group-actions">
        <a className="goals-icon-link" aria-label={moteText('去聊')} title={moteText('去聊')} href={chatHref({kind:'matter',id:matter.id})}><MessageCircle size={17} aria-hidden="true"/></a>
        <a className="goals-icon-link" aria-label={moteText('相关资料')} title={moteText('相关资料')} href={libraryHref(matter.id)}><FileText size={16} aria-hidden="true"/><span>{matter.evidenceIds.length}</span></a>
        {canEditMatters&&<details className="goals-menu">
          <summary>{moteText('更多')}</summary>
          <div className="goals-menu-list">
            <button type="button" className="text-button" disabled={busy} onClick={()=>{setCommandError('');setEdit({matterId:matter.id,revision:matter.revision,goal:matter.goal});}}>{moteText('编辑')}</button>
            <label className="goals-template">{moteText('模板')}
              <select aria-label={moteText('模板')} value={matter.template} disabled={busy}
                onChange={event=>void run('/api/assistant/matter-commands',{type:'edit',matterId:matter.id,expectedRevision:matter.revision,template:event.target.value as MatterTemplate})}>
                {(['project','travel','reading'] as const).map(value=><option key={value} value={value}>{moteText(templateLabels[value])}</option>)}
              </select>
            </label>
            <button type="button" className="text-button" disabled={busy} onClick={()=>void run('/api/assistant/matter-commands',{type:'pause',matterId:matter.id,expectedRevision:matter.revision})}>{moteText('暂停')}</button>
            <button type="button" className="text-button" disabled={busy} onClick={()=>void run('/api/assistant/matter-commands',{type:'archive',matterId:matter.id,expectedRevision:matter.revision})}>{moteText('归档')}</button>
          </div>
        </details>}
      </div>}
    </header>;
  };
  const body=(group:GoalGroup)=><>{(['theirs','mine','unconfirmed'] as const).map(section=>group[section].length>0&&<section className="goals-section" data-section={section} key={section}>
    <h3>{moteText(sectionLabels[section])}</h3>
    {group[section].map(item=>row(group,item))}
  </section>)}</>;
  return <section className="goals-page" aria-busy={loading}>
    <style>{goalsStyles}</style>
    <header className="goals-heading">
      <h1>{moteText('目标')}</h1>
      <div className="goals-heading-actions">
        <div className="segmented-nav goals-switch" role="group" aria-label={moteText('目标')}>
          {(['matter','person'] as const).map(value=><button type="button" key={value} className={grouping===value?'active':undefined}
            aria-pressed={grouping===value} onClick={()=>{setCommandError('');setEdit(undefined);setGrouping(value);}}>{moteText(value==='matter'?'事项':'人')}</button>)}
        </div>
        {canCreate&&<button type="button" className="goals-add" aria-label={moteText('添加目标')} title={moteText('添加目标')}
          onClick={()=>{setCommandError('');setAddOpen(true);}}><Plus size={18} aria-hidden="true"/></button>}
      </div>
    </header>
    {commandError&&<p className="goals-error" role="alert">{commandError}
      <button type="button" className="text-button" disabled={busy} onClick={()=>{setCommandError('');refresh();}}>{moteText('重新读取')}</button></p>}
    {loading&&<Loading/>}
    {!loading&&invalid&&<p className="goals-error" role="alert">{moteText('目标数据无法读取')}
      <button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {!loading&&!invalid&&read.error!==undefined&&read.data===undefined&&<p className="goals-error" role="alert">{errorMessage(read.error)}
      <button type="button" className="text-button" onClick={read.refresh}>{moteText('重试')}</button></p>}
    {!loading&&!invalid&&read.error!==undefined&&read.data!==undefined&&<p className="goals-error" role="alert">{errorMessage(read.error)}
      <button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
    {canReadMatters&&mattersRead.error!==undefined&&<p className="goals-partial" role="status">{moteText('事项状态暂不可用')}</p>}
    {!loading&&!invalid&&view&&total===0&&<p className="goals-empty">{moteText('没有待办')}</p>}
    {!loading&&!invalid&&view&&total>0&&<div className="goals-groups" data-grouping={grouping}>{groups.map(group=><article className="goals-group" data-group={groupId(group)} key={groupId(group)}>
      {head(group)}{body(group)}
      {edit&&group.key.kind==='matter'&&edit.matterId===group.key.id&&<form className="goals-edit" onSubmit={event=>{event.preventDefault();const matter=matters.get(edit.matterId);if(matter)saveMatter(matter);}}>
        <label>{moteText('目标')}<textarea value={edit.goal} maxLength={8000} disabled={busy} onChange={event=>setEdit({...edit,goal:event.target.value})}/></label>
        <div>
          <button type="submit" className="button primary" disabled={busy||!edit.goal.trim()}>{moteText('保存')}</button>
          <button type="button" className="text-button" disabled={busy} onClick={()=>setEdit(undefined)}>{moteText('取消')}</button>
        </div>
      </form>}
    </article>)}</div>}
    {addOpen&&<ActionDialog title={moteText('添加目标')} busy={busy} onClose={()=>{if(!busy){setAddOpen(false);setCommandError('');}}}>
      <form onSubmit={event=>{event.preventDefault();void add();}}>
        <label>{moteText('要做什么')}<input autoFocus required maxLength={80} value={draft.title} disabled={busy} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
        <label>{moteText('截止时间（选填）')}<input type="datetime-local" value={draft.due} disabled={busy} onChange={event=>setDraft({...draft,due:event.target.value})}/></label>
        {commandError&&<p className="goals-error" role="alert">{commandError}</p>}
        <footer>
          <button type="button" className="text-button" disabled={busy} onClick={()=>{setAddOpen(false);setCommandError('');}}>{moteText('取消')}</button>
          <button type="submit" className="button primary" disabled={busy||!draft.title.trim()}>{moteText('添加')}</button>
        </footer>
      </form>
    </ActionDialog>}
  </section>;
}

const goalsStyles=`
.goals-page { max-width: 980px; margin: 0 auto; }
.goals-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
.goals-heading h1 { margin:0; font-size:var(--mote-font-title); letter-spacing:var(--mote-letter-title); }
.goals-heading-actions { display:flex; align-items:center; gap:12px; }
.goals-switch { padding:3px; border-radius:var(--mote-radius-pill); }
.goals-switch button { min-height:32px; padding:4px 14px; border:0; border-radius:var(--mote-radius-pill); }
.goals-switch button.active { background:var(--mote-surface); color:var(--mote-ink); font-weight:600; }
.goals-add { display:grid; place-items:center; width:36px; height:36px; border:1px solid var(--mote-border); border-radius:var(--mote-radius-control); background:var(--mote-surface); color:var(--mote-ink); cursor:pointer; }
.goals-add:hover { border-color:var(--mote-accent); color:var(--mote-accent); }
.goals-groups { display:grid; gap:16px; }
.goals-group { padding:18px 20px; border:1px solid var(--mote-border); border-radius:var(--mote-radius-container); background:var(--mote-surface); }
.goals-group-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.goals-group-title { margin:0; color:var(--mote-ink); font-size:var(--mote-font-section); font-weight:650; text-decoration:none; overflow-wrap:anywhere; }
a.goals-group-title:hover { text-decoration:underline; text-underline-offset:4px; }
.goals-count { color:var(--mote-muted); font-size:var(--mote-font-meta); }
.goals-group-actions { display:flex; align-items:center; gap:12px; margin-left:auto; }
.goals-icon-link { display:inline-flex; align-items:center; gap:4px; color:var(--mote-muted); text-decoration:none; font-size:var(--mote-font-meta); }
.goals-icon-link:hover { color:var(--mote-ink); }
.goals-menu { position:relative; }
.goals-menu summary { list-style:none; cursor:pointer; color:var(--mote-muted); font-size:var(--mote-font-meta); }
.goals-menu summary::-webkit-details-marker { display:none; }
.goals-menu[open] summary { color:var(--mote-ink); }
.goals-menu-list { position:absolute; right:0; z-index:5; display:grid; gap:2px; min-width:128px; padding:6px; border:1px solid var(--mote-border); border-radius:var(--mote-radius-control); background:var(--mote-surface); box-shadow:var(--mote-shadow); }
.goals-template { display:grid; gap:4px; color:var(--mote-muted); font-size:var(--mote-font-meta); }
.goals-template select { font:inherit; color:var(--mote-ink); }
.goals-section { margin-top:16px; padding-top:8px; border-top:1px solid var(--mote-hair); }
.goals-section:first-of-type { margin-top:14px; }
.goals-section h3 { margin:0 0 4px; color:var(--mote-muted); font-size:var(--mote-font-meta); font-weight:600; }
.goals-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 12px; padding:12px 0; border-top:1px solid var(--mote-hair); }
.goals-section .goals-row:first-of-type { border-top:0; padding-top:8px; }
.goals-row-line { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0; }
.goals-who { font-weight:600; }
.goals-due { color:var(--mote-accent); font-size:var(--mote-font-meta); white-space:nowrap; }
.goals-due[data-state=overdue] { color:var(--mote-danger); }
.goals-title { overflow-wrap:anywhere; }
.goals-inferred { display:inline-flex; align-items:center; gap:3px; padding:1px 7px; border:1px solid var(--mote-hair); border-radius:var(--mote-radius-pill); background:var(--mote-background); color:var(--mote-muted); font:inherit; font-size:var(--mote-font-meta); cursor:pointer; }
.goals-inferred:hover { color:var(--mote-danger); border-color:var(--mote-danger); }
.goals-progress { grid-column:1; margin:0; color:var(--mote-muted); font-size:var(--mote-font-meta); overflow-wrap:anywhere; }
.goals-progress .text-button { margin-left:6px; font-size:var(--mote-font-meta); }
.goals-follow { grid-column:1; display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:2px 0 0; color:var(--mote-muted); font-size:var(--mote-font-meta); }
.goals-follow .button { min-height:28px; padding:2px 10px; font-size:var(--mote-font-meta); }
.goals-row-actions { grid-column:2; grid-row:1 / span 3; display:flex; align-items:flex-start; gap:2px; }
.goals-action { display:grid; place-items:center; width:30px; height:30px; padding:0; border:0; border-radius:var(--mote-radius-control); background:transparent; color:var(--mote-muted); cursor:pointer; text-decoration:none; }
.goals-action:hover:not(:disabled) { color:var(--mote-ink); background:var(--mote-surface-hover); }
.goals-action:disabled { cursor:default; opacity:.5; }
.goals-edit { margin-top:12px; padding-top:12px; border-top:1px solid var(--mote-hair); }
.goals-edit label { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.goals-edit textarea { box-sizing:border-box; width:100%; min-height:88px; padding:10px; border:1px solid var(--mote-border); border-radius:var(--mote-radius-control); background:var(--mote-surface); color:inherit; font:inherit; resize:vertical; }
.goals-edit div { display:flex; align-items:center; gap:8px; }
.goals-error { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:10px 0; color:var(--mote-danger); font-size:var(--mote-font-row); }
.goals-partial { margin:8px 0; color:var(--mote-muted); font-size:var(--mote-font-meta); }
.goals-empty { margin:48px 0; color:var(--mote-muted); font-size:var(--mote-font-row); }
@media (max-width:640px) {
  .goals-heading { align-items:flex-start; flex-direction:column; gap:12px; }
  .goals-heading-actions { width:100%; justify-content:space-between; }
  .goals-group { padding:14px; }
  .goals-group-actions { width:100%; margin-left:0; justify-content:flex-start; }
  .goals-row { grid-template-columns:minmax(0,1fr); }
  .goals-row-actions { grid-column:1; grid-row:auto; }
  .goals-menu-list { right:auto; left:0; }
}
`;
