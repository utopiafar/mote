import {useMemo} from 'react';
import {mediaModelsViewSchema,type MediaModelStatus,type ProcessingProfile} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {MediaPreparation} from './MediaPreparation';
import {useResource} from './useResource';

function audioModelState(model:MediaModelStatus){
 if(model.state==='ready')return model.runtimeReady?moteText('可使用'):moteText('模型已准备，音频或图片服务尚未就绪。检查服务后重试。');
 return {not_installed:moteText('尚未安装'),downloading:moteText('正在下载模型…'),verifying:moteText('正在验证模型…'),installing:moteText('正在安装模型…'),failed:moteText('准备未完成'),cancelled:moteText('安装已取消，可继续准备')}[model.state];
}

/** Read the Central's installation and runtime facts independently. This view
 * never starts a worker, retries a file or changes background authorization. */
export function AudioModelStatus({api}:{api:Api}){
 const read=useResource<unknown>(api,'/api/media-models',5000);
 const parsed=useMemo(()=>mediaModelsViewSchema.safeParse(read.data),[read.data]);
 const model=parsed.success?parsed.data.dialogue:undefined;
 const error=read.error??(read.data!==undefined&&!model?new Error(moteText('中央响应格式无效，请刷新后重试。')):undefined);
 return <div className="audio-model-status">
  <strong>Fun-ASR-Nano-2512 + fsmn-vad + CAM++ + CT-Punc</strong>
  {error?<p role="alert">{errorMessage(error)} <button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>:model?<>
   <p role="status">{audioModelState(model)}</p>
   <small>{moteText('版本')} · {model.version}</small>
   {model.missingDependencies?.length?<p>{moteText('缺少运行依赖：{0}',model.missingDependencies.join(', '))}</p>:null}
   {model.error&&<p role="alert">{model.error}</p>}
  </>:<p role="status">{moteText('正在读取…')}</p>}
 </div>;
}

/** Mounted by the shared settings owner in the existing file-processing page. */
export function AudioProcessingSettings({api}:{api:Api}){
 return <section aria-label={moteText('录音转写与说话人')}>
  <AudioModelStatus api={api}/>
  <MediaPreparation api={api} role="dialogue" title={moteText('录音转写与说话人')}/>
  <p>{moteText('摘要、语义分组、复核、Memory 与 Ask 继续使用各自所选模型。')}</p>
 </section>;
}

/** A profile edit stays in the parent's existing dirty/save/preview transaction.
 * No PUT, reprocessing or separate settings authority lives in this component. */
export function AudioCleanupSetting({parameters,onChange,disabled=false}:{parameters:ProcessingProfile['parameters'];onChange:(parameters:ProcessingProfile['parameters'])=>void;disabled?:boolean}){
 return <label><span><input type="checkbox" disabled={disabled} checked={parameters.deduplicate!==false} onChange={event=>onChange({...parameters,deduplicate:event.target.checked})}/>{moteText('保守消重')}</span><small>{moteText('保守消重仅影响派生稿；原文始终可对照和导出。')}</small></label>;
}

/** An unavailable saved choice is visible until the owner explicitly edits it;
 * rendering the fixed current model must not silently rewrite an old profile. */
export function AudioDiarizationSetting({processor,onChange,disabled=false}:{processor:string;onChange:(processor:'audio.diarize')=>void;disabled?:boolean}){
 return <div><label>{moteText('声纹模型')}<strong>CAM++</strong></label>{processor!=='audio.diarize'&&<><p role="status">{moteText('插件不可用')} · {processor}</p><button type="button" className="button" disabled={disabled} onClick={()=>onChange('audio.diarize')}>{moteText('使用 CAM++')}</button></>}</div>;
}
