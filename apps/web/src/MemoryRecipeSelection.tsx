import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,ApiError,errorMessage} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {useUnsavedChanges} from './unsaved';
import {memoryRecipeLabel} from './memory-recipes';

type Ref={id:string;version:string};
type Choice=Ref&{available:boolean};
type View={sourceId:string|null;inherited:boolean;items:{binding:{recipe:Ref};available:boolean}[]};
type Draft={refs:Ref[];inherited:boolean};
const key=(ref:Ref)=>ref.id+'@'+ref.version;
export function MemoryRecipeSelection({api}:{api:Api}){
  const [source,setSource]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  const request=useRef<AbortController|null>(null);
  const sourceId=source.startsWith('source:')?source.slice(7):undefined,capture=source==='capture';
  const path='/api/memory-recipe-settings'+(capture?'?scope=capture':sourceId?'?sourceId='+encodeURIComponent(sourceId):'');
  const read=useResource<View>(api,path),catalog=useResource<{items:Choice[]}>(api,'/api/memory-recipes'),sources=useResource<{items:{id:string;name:string}[]}>(api,'/api/sources');
  const [editor,setEditor]=useState<{api:Api;path:string;draft:Draft;baseline:Draft}>();
  const active=editor?.api===api&&editor.path===path?editor:undefined,draft=active?.draft,dirty=!!active&&JSON.stringify(active.draft)!==JSON.stringify(active.baseline);
  useUnsavedChanges(dirty);
  useEffect(()=>{setError('');setSaved(false);setBusy(false);return()=>request.current?.abort();},[api,path]);
  useEffect(()=>{
    if(read.data&&!dirty){const next={refs:read.data.items.map(i=>({id:i.binding.recipe.id,version:i.binding.recipe.version})),inherited:read.data.inherited};setEditor({api,path,draft:next,baseline:next});}
    if(read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status))setEditor(undefined);
  },[api,path,read.data,read.error]);
  const choices=new Map((catalog.data?.items??[]).map(c=>[key(c),c]));
  for(const item of read.data?.items??[])choices.set(key(item.binding.recipe),{...item.binding.recipe,available:item.available});
  function edit(value:Draft){setSaved(false);setEditor(current=>current?.api===api&&current.path===path?{...current,draft:value}:current);}
  async function save(){if(!draft||busy)return;if(!draft.inherited&&!draft.refs.length)return;const controller=new AbortController();request.current=controller;setBusy(true);setSaved(false);setError('');try{
    const result=await api.request<View>('/api/memory-recipe-settings',{method:'PUT',signal:controller.signal,body:JSON.stringify({...(sourceId?{sourceId}:capture?{scope:'capture'}:{}),recipes:sourceId&&draft.inherited?null:draft.refs})});
    if(controller.signal.aborted)return;
    const next={refs:result.items.map(i=>({id:i.binding.recipe.id,version:i.binding.recipe.version})),inherited:result.inherited};
    setEditor({api,path,draft:next,baseline:next});setSaved(true);resources(api).invalidate(k=>k.startsWith('/api/memory-recipe-settings'));
  }catch(e){if(!controller.signal.aborted)setError(errorMessage(e));}finally{if(!controller.signal.aborted)setBusy(false);}}
  return <section className="memory-recipe-selection"><h3>{moteText('自动 Memory 组合')}</h3>
    <p>{moteText('为新接收的来源资料选择记忆策略。多个策略可共用处理结果；保存设置不会重算历史资料，已有记忆仍保留。')}</p>
    <label>{moteText('应用范围')}<select aria-label={moteText('应用范围')} value={source} disabled={busy||dirty} onChange={e=>setSource(e.target.value)}><option value="">{moteText('默认组合')}</option><option value="capture">{moteText('截图和页面采集默认组合')}</option>{sources.data?.items.map(s=><option value={'source:'+s.id} key={s.id}>{s.name}</option>)}</select></label>
    <p className="muted">{moteText('截图和页面采集使用独立默认组合；来源覆盖优先。日常事件保留浏览和行动线索，区分计划与完成，并可在对话中按天回顾。')}</p>
    {Boolean(error||read.error||catalog.error||sources.error)&&<p role="alert" className="notice error">{error||errorMessage(read.error||catalog.error||sources.error)}</p>}
    {draft&&<form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy}>
      <legend>{moteText('选择记忆策略')}</legend>
      {!!sourceId&&<label><input type="checkbox" checked={draft.inherited} onChange={e=>edit({...draft,inherited:e.target.checked})}/>{moteText('跟随默认组合')}</label>}
      {[...choices.values()].map(choice=>{const checked=draft.refs.some(r=>key(r)===key(choice));return <label className="source-toolbar" key={key(choice)}><input type="checkbox" checked={checked} disabled={!!sourceId&&draft.inherited||!choice.available&&!checked||checked&&draft.refs.length===1} onChange={e=>edit({...draft,refs:e.target.checked?[...draft.refs,{id:choice.id,version:choice.version}]:draft.refs.filter(r=>key(r)!==key(choice))})}/>{memoryRecipeLabel(choice)}{!choice.available&&<span className="muted">{moteText('组件暂不可用')}</span>}</label>;})}
      <button className="button primary" type="submit" disabled={!dirty}>{moteText('保存组合')}</button>{dirty&&<button className="button" type="button" onClick={()=>{edit(active!.baseline);read.refresh();}}>{moteText('放弃修改并重新加载')}</button>}
    </fieldset></form>}{saved&&<p role="status">{moteText('设置已保存。')}</p>}
  </section>;
}
