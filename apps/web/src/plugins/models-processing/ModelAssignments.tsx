import {invalidateConfiguration} from '../../configuration-cache';
import {useResource} from '../../useResource';
import {ApiError,type Api,errorMessage} from '../../api';
import {confirmNavigation,useUnsavedChanges} from '../../unsaved';
import {moteText} from '@mote/shared/i18n';
import {commonFailureMessage,httpStatusMessage} from '@mote/shared';
import {useEffect,useMemo,useRef,useState} from 'react';
import {MODEL_FEATURES,MODEL_FEATURE_LABELS,type ModelFeature,type ModelFeatureDefaults,type ModelFeatureModels,type ModelSettingsView} from '@mote/shared/models';
import {type AgentRuntimeStatusReceipt} from '@mote/shared/agent-runtime-status';
import {parseAgentRuntimeStatus} from '../../agent-runtime-status';

function moduleFailure(error:unknown){return error instanceof ApiError?(commonFailureMessage(error.code??'',error.status)??httpStatusMessage(error.status)):errorMessage(error);}
function installStyle(){if(document.querySelector('link[data-model-assignments-final]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./model-assignments-final.css?no-inline',import.meta.url).href;link.dataset.modelAssignmentsFinal='';document.head.append(link);}
const customModes=(models:ModelFeatureModels)=>Object.fromEntries(MODEL_FEATURES.map(feature=>[feature,Boolean(models[feature])]));
function effectiveSummary(view:ModelSettingsView|undefined,receipt:AgentRuntimeStatusReceipt|undefined){
 if(!view||!receipt)return '';
 const restart=receipt.configuration.domain?.status==='restart-required'?' · '+moteText('重启后生效'):'';
 return Object.keys(receipt.features).map(feature=>{
  const selected=receipt.features[feature];
  const profile=view.profiles.find(value=>value.id===selected.profileId);
  const label=(MODEL_FEATURE_LABELS as Record<string,string|undefined>)[feature]??feature;
  return label+'：'+(profile?.name??selected.profileId)+(selected.model?' · '+selected.model:'')+(selected.configured?'':' · '+moteText('尚未生效'));
 }).join('；')+restart;
}
function ModuleModel({api,feature,profileId,value,custom,onCustom,onChange,disabled,fallback}:{api:Api;feature:ModelFeature;profileId:string;value:string;custom:boolean;onCustom:(custom:boolean)=>void;onChange:(value:string)=>void;disabled:boolean;fallback:string}){
 const {data,error,loading}=useResource<{items:{id:string;name:string}[]}>(api,custom?`/api/model-settings/profiles/${encodeURIComponent(profileId)}/models`:null);
 return <><label><span className="visually-hidden">{MODEL_FEATURE_LABELS[feature]+moteText('模型方式')}</span><select className="module-mode" aria-label={MODEL_FEATURE_LABELS[feature]+moteText('模型方式')} disabled={disabled} value={custom?'custom':'inherit'} onChange={event=>onCustom(event.target.value==='custom')}><option value="inherit">{moteText('跟随连接默认')} · {fallback||moteText('未配置')}</option><option value="custom">{moteText('指定此连接下的模型')}</option></select></label>{custom&&<label><span className="visually-hidden">{MODEL_FEATURE_LABELS[feature]+moteText('指定模型 ID')}</span><input aria-label={MODEL_FEATURE_LABELS[feature]+moteText('指定模型 ID')} list={'module-models-'+feature} value={value} maxLength={512} disabled={disabled} placeholder={loading?moteText('正在读取模型列表…'):moteText('模型 ID')} onChange={event=>onChange(event.target.value)}/><datalist id={'module-models-'+feature}>{data?.items.map(model=><option key={model.id} value={model.id}>{model.name}</option>)}</datalist>{error!==undefined&&<small role="status">{moduleFailure(error)}</small>}</label>}</>;
}
export function ModelAssignments({api,revision,onApplied,onManage}:{api:Api;revision:number;onApplied:()=>void;onManage:()=>void}){
 const [view,setView]=useState<ModelSettingsView>(),[defaults,setDefaults]=useState<ModelFeatureDefaults>(),[models,setModels]=useState<ModelFeatureModels>({}),[custom,setCustom]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(''),[notice,setNotice]=useState('');
 const activeApi=useRef(api);activeApi.current=api;const viewOwner=useRef<Api|undefined>(undefined),operation=useRef<AbortController|undefined>(undefined),reloadPending=useRef<Api|undefined>(undefined);
 const invalid=MODEL_FEATURES.some(feature=>custom[feature]&&!models[feature]?.trim()),dirty=!!view&&(invalid||JSON.stringify(defaults)!==JSON.stringify(view.defaults)||JSON.stringify(models)!==JSON.stringify(view.defaultModels));
 useUnsavedChanges(viewOwner.current===api&&dirty);
 const read=useResource<ModelSettingsView>(api,'/api/model-settings',undefined,revision),formBusy=busy||reloadPending.current===api&&read.loading;
 const runtimeRead=useResource<unknown>(api,'/api/agent-runtime-settings',undefined,revision);
 const parsedReceipt=useMemo<AgentRuntimeStatusReceipt|Error|undefined>(()=>{if(runtimeRead.data===undefined)return undefined;try{return parseAgentRuntimeStatus(runtimeRead.data);}catch(failure){return failure instanceof Error?failure:new Error(moteText('中央响应格式无效，请刷新后重试。'));}},[runtimeRead.data]);
 const receipt=parsedReceipt instanceof Error?undefined:parsedReceipt;
 const receiptError=runtimeRead.error??(parsedReceipt instanceof Error?parsedReceipt:undefined);
 const effective=read.data&&(!view||read.data.revision>=view.revision)?read.data:view,effectiveValues=effectiveSummary(effective,receipt);
 const adopt=(next:ModelSettingsView)=>{viewOwner.current=api;setView(next);setDefaults(next.defaults);setModels(next.defaultModels);setCustom(customModes(next.defaultModels));};
 useEffect(installStyle,[]);
 useEffect(()=>{viewOwner.current=undefined;reloadPending.current=undefined;setView(undefined);setDefaults(undefined);setModels({});setCustom({});setError('');setNotice('');setBusy(false);return()=>{operation.current?.abort();operation.current=undefined;};},[api]);
 useEffect(()=>{
  const reloading=reloadPending.current===api;
  if(!read.loading&&read.error===undefined&&read.data&&(!dirty||viewOwner.current!==api||reloading)){
   adopt(read.data);if(reloading&&!read.loading){reloadPending.current=undefined;setError('');setNotice('');}
  }
  if(read.error!==undefined&&!read.loading)reloadPending.current=undefined;
  if(read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status)){viewOwner.current=undefined;operation.current?.abort();operation.current=undefined;setBusy(false);setView(undefined);setDefaults(undefined);setModels({});setCustom({});}
 },[api,read.data,read.error,read.loading]);
 function reload(){if(busy||read.loading||!confirmNavigation())return;reloadPending.current=api;setError('');setNotice('');read.refresh();runtimeRead.refresh();}
 async function save(){
  if(!view||viewOwner.current!==api||!defaults||invalid||!dirty||formBusy||operation.current)return;
  const controller=new AbortController();operation.current=controller;const current=()=>activeApi.current===api&&!controller.signal.aborted&&operation.current===controller;setBusy(true);setError('');setNotice('');
  try{const next=await api.request<ModelSettingsView>('/api/model-settings/defaults',{method:'PUT',body:JSON.stringify({revision:view.revision,defaults,defaultModels:models}),signal:controller.signal});if(!current())return;adopt(next);invalidateConfiguration(api);setNotice(moteText('模块分配已保存，新请求立即生效。'));onApplied();}
  catch(failure){if(current()){setError(failure);if(failure instanceof ApiError&&failure.code==='model_settings_prepare_failed')read.refresh();if(failure instanceof ApiError&&[401,403,404,410].includes(failure.status)){viewOwner.current=undefined;controller.abort();operation.current=undefined;setBusy(false);setView(undefined);setDefaults(undefined);setModels({});setCustom({});}}}
  finally{if(current())setBusy(false);if(operation.current===controller)operation.current=undefined;}
 }
 return <section className="panel module-assignments final-module-assignments" aria-busy={formBusy}>
  {Boolean(error||read.error!==undefined||receiptError!==undefined)&&<div className="module-assignment-error"><p role="alert">{moduleFailure(error||read.error||receiptError)}</p><details><summary>{moteText('技术详情')}</summary><p>{errorMessage(error||read.error||receiptError)}</p></details><button className="text-button" disabled={busy||read.loading} onClick={reload}>{moteText('重新读取')}</button></div>}
  {read.loading&&!view&&<p role="status">{moteText('正在读取…')}</p>}
  {viewOwner.current===api&&view&&defaults&&<><div className="module-assignment-list">{MODEL_FEATURES.map(feature=><div className="module-assignment-row" key={feature}><h2>{MODEL_FEATURE_LABELS[feature]}</h2><div className="module-selection"><label><span className="visually-hidden">{MODEL_FEATURE_LABELS[feature]+moteText('默认模型')}</span><select aria-label={MODEL_FEATURE_LABELS[feature]+moteText('默认模型')} value={defaults[feature]} disabled={formBusy} onChange={event=>{setDefaults({...defaults,[feature]:event.target.value});setModels(previous=>{const next={...previous};delete next[feature];return next;});setCustom(previous=>({...previous,[feature]:false}));setNotice('');}}>{!view.profiles.some(profile=>profile.id===defaults[feature])&&<option value={defaults[feature]}>{moteText('所选模型配置不存在，请重新选择。')}</option>}{view.profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}{profile.readOnly?moteText(' · 只读'):''}</option>)}</select></label><ModuleModel api={api} feature={feature} profileId={defaults[feature]} fallback={view.profiles.find(profile=>profile.id===defaults[feature])?.settings.model??''} value={models[feature]??''} custom={!!custom[feature]} disabled={formBusy} onCustom={next=>{setCustom(previous=>({...previous,[feature]:next}));if(!next)setModels(previous=>{const copy={...previous};delete copy[feature];return copy;});setNotice('');}} onChange={value=>{setModels(previous=>{const next={...previous};if(value.trim())next[feature]=value.trim();else delete next[feature];return next;});setNotice('');}}/></div></div>)}</div>{effectiveValues&&<p className="fine-print module-assignment-effective"><span>{moteText('当前生效值')}</span> · {effectiveValues}</p>}<div className="module-assignment-footer"><span role="status">{notice||(dirty?moteText('有未保存的修改'):moteText('新请求使用已保存的模块分配'))}</span><button className="button primary" aria-label={moteText('保存模块分配')} disabled={formBusy||!dirty||invalid} onClick={()=>void save()}>{moteText('保存模块分配')}</button></div><details className="module-assignment-help"><summary>{moteText('更多选项')}</summary><p>{moteText('跟随预设的默认模型，或为模块指定同一连接下的其他模型。单次请求的选择优先。')}</p><p>{moteText('文件处理器的显式模型与本地处理限制优先。')}</p><button className="text-button" onClick={()=>{if(confirmNavigation())onManage();}}>{moteText('管理模型连接')}</button></details></>}
 </section>;
}
