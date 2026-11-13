import {useEffect,useRef,useState} from 'react';
import {featureRequirementsAvailable,type FeatureInventory,type SourceConnection} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {resources} from '../../resource-cache';
import {FileRetentionNote,fileRetentionLabel} from '../reader/FileStatus';

/** Keep an explicit draft attached to this Api/source, rather than resetting
 * it whenever status polling returns a fresh source object. */
export function FileRetentionSettings({api,source}:{api:Api;source:SourceConnection}){
 const inventory=useResource<FeatureInventory>(api,'/api/features',5000);
 const [draft,setDraft]=useState<{api:Api;sourceId:string;retention:SourceConnection['retention']}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null);
 useEffect(()=>{setBusy(false);setError('');return()=>{request.current?.abort();request.current=null;};},[api,source.id]);
 const retention=draft?.api===api&&draft.sourceId===source.id?draft.retention:source.retention;
 const available=!inventory.error&&featureRequirementsAvailable(['http:PATCH:/api/sources/:id'],inventory.data);
 async function save(){
  if(!available||request.current||retention===source.retention)return;
  const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{
   const result=await api.request<SourceConnection>('/api/sources/'+encodeURIComponent(source.id),{method:'PATCH',body:JSON.stringify({retention}),signal:controller.signal});
   if(controller.signal.aborted||request.current!==controller)return;
   if(result.id!==source.id||result.retention!==retention)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
   setDraft(undefined);resources(api).invalidate(key=>/^\/api\/(sources|source-items|files|capture-browser|materials|library)([/?]|$)/.test(key));
  }catch(error){if(!controller.signal.aborted&&request.current===controller)setError(errorMessage(error));}
  finally{if(request.current===controller){request.current=null;setBusy(false);}}
 }
 return <form className="file-retention-settings" onSubmit={event=>{event.preventDefault();void save();}}>
  <label>{moteText('保存方式')}<select value={retention} disabled={busy||!available} onChange={event=>setDraft({api,sourceId:source.id,retention:event.target.value as SourceConnection['retention']})}>{(['reference','snapshot','archive'] as const).map(mode=><option key={mode} value={mode}>{fileRetentionLabel(mode)}</option>)}</select></label>
  <FileRetentionNote/>
  <p className="fine-print">{moteText('保存方式只提交当前选择，不更改其他来源设置。已有文件的实际能力以文件状态为准。')}</p>
  <div className="source-toolbar"><button className="button" type="submit" disabled={busy||!available||retention===source.retention}>{moteText('保存设置')}</button>{draft?.api===api&&draft.sourceId===source.id&&<button className="button subtle" type="button" disabled={busy} onClick={()=>setDraft(undefined)}>{moteText('取消')}</button>}</div>
  {!available&&<p role="status">{moteText('当前支持情况暂无法确认')}</p>}{error&&<p role="alert">{error}</p>}
 </form>;
}
