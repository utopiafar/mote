import {useEffect,useRef,useState,type ReactNode} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {ProcessingProfile} from '@mote/shared';
import {type Api,errorMessage,ApiError} from '../../api';
import {useResource} from '../../useResource';
import {useUnsavedChanges} from '../../unsaved';
import {invalidateConfiguration} from '../../configuration-cache';
import {MediaPreparation} from '../../MediaPreparation';
import {PerceptionSettings} from '../../PerceptionSettings';
import {FileProcessingSettings} from '../../FileProcessingSettings';
import {useProcessingRelatedPages} from './ProcessingRelatedPages';
import {processingProfileLabel,type FileSettingsView} from '../../processing-settings-view';

type ImageView={revision:number;settings:{enabled:boolean;understandingEnabled:boolean;allowExternalProcessing:boolean;allowQueryImages:boolean;providerRevision:string;ocrEndpoint:string;ocrProcessorId:string;profileId?:string};model:{model?:string}|null};
type Kind='images'|'audio'|'documents';
type Draft={owner:Api;kind:Kind;file:FileSettingsView;image:ImageView;dirty:boolean;fileSaved?:boolean;persistedFile?:FileSettingsView};
const ruleType=(kind:Kind)=>kind==='images'?'image/*':'audio/*';
const selected=(draft:Draft)=>draft.file.policy.profiles.find(value=>value.id===draft.file.policy.rules.find(rule=>!rule.sourceId&&rule.type===ruleType(draft.kind))?.profileId);
function Check({children,value,onChange}:{children:ReactNode;value:boolean;onChange:(value:boolean)=>void}){return <label className="processing-check"><input type="checkbox" checked={value} onChange={event=>onChange(event.target.checked)}/><span>{children}</span></label>;}

/** Ordinary settings compose the existing image and file policies. Advanced
 * plugin/profile controls remain available without taking over these pages. */
export function MaterialProcessing({api,kind,onDetailChange}:{api:Api;kind:Kind;onDetailChange?:(value:boolean)=>void}){
 const files=useResource<FileSettingsView>(api,'/api/file-processing'),images=useResource<ImageView>(api,'/api/perception');
 const [draft,setDraft]=useState<Draft>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const related=useProcessingRelatedPages(api,kind,onDetailChange,(next,previousRevision)=>{setDraft(value=>{
  if(!value||value.owner!==api||value.kind!==kind||value.file.revision!==previousRevision||kind==='images'&&value.image.revision!==Number(previousRevision))return value;
  const baseline=value.persistedFile?.revision===previousRevision?value.persistedFile:files.data?.revision===previousRevision?files.data:undefined;if(!baseline)return value;
  const keepDraft=<T,>(draft:T,before:T,after:T):T=>structuredClone(JSON.stringify(draft)===JSON.stringify(before)?after:draft);
  return {...value,file:{...next,settings:keepDraft(value.file.settings,baseline.settings,next.settings),policy:{...next.policy,rules:keepDraft(value.file.policy.rules,baseline.policy.rules,next.policy.rules),profiles:keepDraft(value.file.policy.profiles,baseline.policy.profiles,next.policy.profiles)}},image:{...value.image,revision:Number(next.revision)},persistedFile:structuredClone(next)};
 });});
 const saveError=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{if(error)saveError.current?.scrollIntoView?.({block:'nearest'});},[error]);
 const request=useRef<AbortController|undefined>(undefined),active=useRef(api);active.current=api;
 const current=draft?.owner===api&&draft.kind===kind?draft:undefined;
 useUnsavedChanges(Boolean(current?.dirty));
 useEffect(()=>{setDraft(undefined);setError('');setNotice('');setBusy(false);return()=>{request.current?.abort();request.current=undefined;};},[api,kind]);
 useEffect(()=>{if(files.data&&images.data&&!current?.dirty&&!busy){
  if(kind==='images'&&String(images.data.revision)!==files.data.revision)return;
  if(current&&(Number(files.data.revision)<Number(current.file.revision)||images.data.revision<current.image.revision))return;
  setDraft({owner:api,kind,file:structuredClone(files.data),image:structuredClone(images.data),dirty:false});
 }},[api,kind,files.data,images.data,busy,current?.dirty]);
 const revoked=[files.error,images.error].some(value=>value instanceof ApiError&&[401,403,404,410].includes(value.status));
 useEffect(()=>{if(revoked)setDraft(undefined);},[revoked]);
 const failure=files.error??images.error;
 function edit(change:(value:Draft)=>void){if(!current||busy)return;setDraft(value=>{if(!value||value.owner!==api||value.kind!==kind)return value;const next={...value,file:structuredClone(value.file),image:structuredClone(value.image),dirty:true};change(next);return next;});setNotice('');setError('');}
 const profile=current&&selected(current),service=current?.file.policy.services.find(value=>value.id===profile?.serviceId),local=service?.execution==='local',archived=profile?.processorId==='archive';
 const options=current?.file.policy.profiles.filter(value=>kind==='images'?value.processorId==='archive'||value.processorId==='image.http'||value.id===profile?.id:['archive','audio.local-dialogue','audio.http'].includes(value.processorId)||value.id===profile?.id)??[];
 function choose(id:string){edit(value=>{const type=ruleType(kind),rule=value.file.policy.rules.find(rule=>!rule.sourceId&&rule.type===type);if(rule)rule.profileId=id;else value.file.policy.rules.push({type,profileId:id});});}
 function patchProfile(change:(value:ProcessingProfile)=>void){edit(value=>{const target=selected(value);if(target)change(target);});}
 const refresh=()=>{if(busy)return;setDraft(undefined);setError('');setNotice('');files.refresh();images.refresh();};
 async function save(){
  if(!current||request.current||revoked)return;
  const snapshot={...current,file:structuredClone(current.file),image:structuredClone(current.image)},controller=new AbortController();request.current=controller;
  const valid=()=>active.current===api&&request.current===controller&&!controller.signal.aborted;
  setBusy(true);setError('');setNotice('');
  try{
   const baseline=snapshot.persistedFile??files.data;
   const fileChanged=JSON.stringify(snapshot.file.settings)!==JSON.stringify(baseline?.settings)||JSON.stringify(snapshot.file.policy)!==JSON.stringify(baseline?.policy);
   let saved=snapshot.file;
   if(fileChanged){saved=await api.request<FileSettingsView>('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:snapshot.file.revision,settings:snapshot.file.settings,policy:snapshot.file.policy}),signal:controller.signal});if(!valid())return;
    snapshot.file=saved;snapshot.persistedFile=structuredClone(saved);snapshot.fileSaved=true;snapshot.image.revision=Number(saved.revision);setDraft({...snapshot,dirty:true});}
   if(kind==='images'){
    const imageProfile=selected(snapshot),imageService=saved.policy.services.find(value=>value.id===imageProfile?.serviceId);
    const settings={...snapshot.image.settings,profileId:imageProfile?.id,ocrProcessorId:imageProfile?.processorId??snapshot.image.settings.ocrProcessorId,ocrEndpoint:imageService?.endpoint??''};
    const image=await api.request<ImageView>('/api/perception',{method:'PUT',body:JSON.stringify({revision:snapshot.image.revision,settings}),signal:controller.signal});if(!valid())return;
    snapshot.image=image;snapshot.file={...saved,revision:String(image.revision)};
   }
   if(!valid())return;setDraft({...snapshot,dirty:false,fileSaved:false});setNotice(moteText('设置已保存；已完成资料保留原结果。'));invalidateConfiguration(api);files.refresh();images.refresh();
  }catch(caught){if(valid())setError((snapshot.fileSaved?moteText('处理方案已保存，图片设置尚未确认；请保留草稿并重试。')+' ':'')+errorMessage(caught));}
  finally{if(valid())setBusy(false);if(request.current===controller)request.current=undefined;}
 }
 const number=(label:string,value:number|null|undefined,onChange:(value:number|null)=>void,min:number,max:number,optional=false)=><label className="preference-field">{moteText(label)}<input type="number" aria-label={moteText(label)} value={value??''} min={min} max={max} step="1" required={!optional} onChange={event=>onChange(event.target.value===''?null:Number(event.target.value))}/></label>;
 const model=<div className="processing-model-link"><small>{moteText('使用文件分析模型 · {0}',current?.image.model?.model||moteText('未配置'))}</small><button type="button" className="text-button" onClick={related.openModels}>{moteText('更改功能模型')} →</button></div>;
 const runtime=kind==='images'&&!archived&&local||kind==='audio'&&profile?.processorId==='audio.local-dialogue';
 return <section className="material-processing" aria-label={moteText(kind==='images'?'图片':kind==='audio'?'录音':'文档与其他文件')} aria-busy={busy}>
  <div data-processing-main hidden={related.active}>
  {(error||failure!==undefined)&&<p ref={saveError} role="alert">{error||errorMessage(failure)}</p>}
  {!current&&!revoked&&<p role="status">{failure!==undefined?moteText('暂不可用'):moteText('正在读取…')}</p>}
  {current&&!revoked&&<><form className="processing-form material-processing-form" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy||failure!==undefined}>
   {kind==='images'&&<>
    <Check value={current.image.settings.enabled} onChange={value=>edit(draft=>{draft.image.settings.enabled=value;})}>{moteText('自动处理新图片')}</Check>
    <label className="preference-field">{moteText('文字识别')}<select value={archived?'archive':profile?.id??''} onChange={event=>choose(event.target.value==='archive'?options.find(value=>value.processorId==='archive')!.id:event.target.value)}>{options.filter(value=>value.processorId!=='archive').map(value=><option key={value.id} value={value.id}>{value.id==='central-image'?moteText('使用 OCR 提取文字'):value.name}</option>)}{options.some(value=>value.processorId==='archive')&&<option value="archive">{moteText('不提取文字，保留原图')}</option>}</select></label>
    {!archived&&<label className="preference-field">{moteText('OCR 服务')}<select value={profile?.serviceId??''} onChange={event=>patchProfile(value=>{value.serviceId=event.target.value||undefined;})}><option value="">{moteText('未配置')}</option>{current.file.policy.services.filter(value=>value.kind==='image').map(value=><option key={value.id} value={value.id}>{value.name} · {moteText(value.execution==='local'?'本机':'远程')}</option>)}</select><button type="button" className="text-button" disabled={!profile?.serviceId} onClick={()=>{if(profile?.serviceId)related.openService(profile.serviceId);}}>{moteText('管理这个服务')} →</button></label>}
    <div className="processing-meaning"><h2>{moteText('画面理解')}</h2><Check value={current.image.settings.understandingEnabled} onChange={value=>edit(draft=>{draft.image.settings.understandingEnabled=value;})}>{moteText('理解画面与来源上下文')}</Check>{model}</div>
    <details className="processing-policy-details"><summary>{moteText('原图使用与高级设置')}</summary><Check value={current.image.settings.allowExternalProcessing} onChange={value=>edit(draft=>{draft.image.settings.allowExternalProcessing=value;})}>{moteText('允许图片发往已选择的远程 OCR 服务')}</Check><Check value={current.image.settings.allowQueryImages} onChange={value=>edit(draft=>{draft.image.settings.allowQueryImages=value;})}>{moteText('允许查询模型按需读取原图')}</Check></details>
   </>}
   {kind==='audio'&&<>
    <label className="preference-field">{moteText('录音处理方式')}<select value={profile?.id??''} onChange={event=>choose(event.target.value)}>{options.map(value=><option key={value.id} value={value.id}>{value.id==='profile.audio.local-dialogue'?moteText('本地转写与匿名说话人分离'):value.id==='profile.audio.http'?moteText('使用转写服务'):value.processorId==='archive'?moteText('仅保存原件'):value.name}</option>)}</select></label>
    {!archived&&<label className="preference-field">{moteText('转写服务')}<select value={profile?.serviceId??''} onChange={event=>patchProfile(value=>{value.serviceId=event.target.value||undefined;})}><option value="">{moteText('未配置')}</option>{current.file.policy.services.filter(value=>value.kind==='asr'&&(profile?.processorId!=='audio.local-dialogue'||value.execution==='local')).map(value=><option key={value.id} value={value.id}>{value.name} · {moteText(value.execution==='local'?'本机':'远程')}</option>)}</select><button type="button" className="text-button" disabled={!profile?.serviceId} onClick={()=>{if(profile?.serviceId)related.openService(profile.serviceId);}}>{moteText('管理这个服务')} →</button></label>}
    {!archived&&!local&&<p className="processing-caution">{moteText('录音将发送到所选远程服务；后台任务仍受已保存的授权范围限制。')}</p>}
    <details className="processing-policy-details"><summary>{moteText('转写选项与单文件限制')}</summary><div className="preference-grid">{number('单个音频最长（分钟）',current.file.settings.maxAudioMinutes,value=>edit(draft=>{draft.file.settings.maxAudioMinutes=value!;}),1,1440)}{number('单次处理超时（秒）',current.file.settings.timeoutMs/1000,value=>edit(draft=>{draft.file.settings.timeoutMs=value!*1000;}),1,3600)}</div>
     {profile?.processorId==='audio.local-dialogue'&&<><div className="preference-grid">{number('准确说话人数（选填）',profile.parameters.speakerCount as number|null,value=>patchProfile(profile=>{profile.parameters.speakerCount=value;}),1,16,true)}<label className="preference-field">{moteText('说话人分离')}<select value={profile.diarizationProcessor} onChange={event=>patchProfile(value=>{value.diarizationProcessor=event.target.value;})}>{current.file.processors.filter(value=>value.stage==='diarize').map(value=><option key={value.id} value={value.id}>{value.id==='audio.diarize'?moteText('默认匿名说话人分离'):value.name}</option>)}</select></label></div><div className="preference-grid">{number('说话人数下限（选填）',profile.parameters.speakerMin as number|null,value=>patchProfile(profile=>{profile.parameters.speakerMin=value;}),1,16,true)}{number('说话人数上限（选填）',profile.parameters.speakerMax as number|null,value=>patchProfile(profile=>{profile.parameters.speakerMax=value;}),1,16,true)}</div><Check value={profile.parameters.semanticTurns===true} onChange={value=>patchProfile(profile=>{profile.parameters.semanticTurns=value;})}>{moteText('使用语言模型合并自然发言轮次')}</Check></>}
     {!archived&&profile&&<><Check value={profile.summarize} onChange={value=>patchProfile(profile=>{profile.summarize=value;})}>{moteText('转写后生成摘要')}</Check>{model}</>}
    </details>
   </>}
   {kind==='documents'&&<><Check value={current.file.settings.enabled} onChange={value=>edit(draft=>{draft.file.settings.enabled=value;})}>{moteText('启用 Central 文件处理')}</Check>{current.file.policy.rules.map((rule,index)=>!rule.sourceId&&!['image/*','audio/*'].includes(rule.type)&&<label className="processing-rule-row" key={rule.type}><span>{rule.type==='*/*'?moteText('其他类型'):rule.type==='text/*'?moteText('文本'):rule.type==='application/pdf'?'PDF':rule.type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'?'DOCX':rule.type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'?'XLSX':rule.type}</span><select aria-label={rule.type} value={rule.profileId} onChange={event=>edit(draft=>{draft.file.policy.rules[index].profileId=event.target.value;})}>{current.file.policy.profiles.filter(value=>value.id===rule.profileId||value.processorId==='archive'||current.file.processors.find(processor=>processor.id===value.processorId)?.mediaTypes.some(type=>type===rule.type||type==='*/*'||type===rule.type.split('/')[0]+'/*')).map(value=><option key={value.id} value={value.id}>{processingProfileLabel(value)}</option>)}</select></label>)}</>}
   {notice&&<p role="status">{notice}</p>}
   <div className="model-save-footer"><span>{moteText('保存后续处理设置，原件继续保留')}</span><button className="button primary" disabled={busy||!current.dirty}>{moteText('保存设置')}</button></div>
  </fieldset></form>
  {runtime&&<section className="managed-runtime"><h2>{moteText('中心本机处理')}</h2><MediaPreparation api={api} role={kind==='images'?'ocr':'dialogue'} title={moteText(kind==='images'?'图片文字识别':'录音转写与说话人分离')}/>{kind==='audio'&&<details><summary>{moteText('可选：中文声纹模型')}</summary><MediaPreparation api={api} role="speaker-wespeaker" title={moteText('中文声纹模型')}/></details>}<details><summary>{moteText('高级连接配置')}</summary><button className="text-button" disabled={!profile?.serviceId} onClick={()=>{if(profile?.serviceId)related.openService(profile.serviceId);}}>{moteText('自定义本机处理服务')} →</button></details></section>}
  <details className="material-processing-advanced"><summary>{moteText(kind==='images'?'更多：已有图片与完整处理策略':'来源覆盖、规则试算与完整处理策略')}</summary>{kind==='images'?<PerceptionSettings api={api}/>:<FileProcessingSettings api={api}/>}</details>
  </>}
  <button type="button" className="text-button processing-refresh" disabled={busy} onClick={refresh}>{moteText('重新读取并还原草稿')}</button>
  </div>{related.pages}
 </section>;
}
