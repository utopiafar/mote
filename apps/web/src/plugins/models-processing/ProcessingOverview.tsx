import {moteText} from '@mote/shared/i18n';
import {ChevronRight, FileText, Image, AudioLines} from 'lucide-react';
import type {FilePolicy} from '@mote/shared';
import {type Api,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {processingProfileLabel} from '../../processing-settings-view';
export function ProcessingOverview({api,onSelect}:{api:Api;onSelect:(category:'images'|'audio'|'documents'|'providers')=>void}){
 const read=useResource<{policy:FilePolicy}>(api,'/api/file-processing'),policy=read.data?.policy;
 const selected=(mime:string)=>policy?.profiles.find(profile=>profile.id===policy.rules.find(rule=>!rule.sourceId&&rule.type===mime)?.profileId);
 const image=selected('image/*'),audio=selected('audio/*');
 const rows=[{id:'images' as const,title:moteText('图片'),description:moteText('文字识别、画面理解与原图使用'),value:image?.processorId==='archive'?moteText('不提取文字'):policy?.services.find(service=>service.id===image?.serviceId)?.name,Icon:Image},{id:'audio' as const,title:moteText('录音'),description:moteText('转写、匿名说话人分离与单文件限制'),value:audio?processingProfileLabel(audio):undefined,Icon:AudioLines},{id:'documents' as const,title:moteText('文档与其他文件'),description:moteText('文本提取、其他类型与来源覆盖'),value:policy?moteText('按文件类型处理'):undefined,Icon:FileText}];
 return <section className="processing-overview" aria-label={moteText('资料处理')}>
  {read.error!==undefined&&<p role="alert">{errorMessage(read.error)}</p>}
  {rows.map(({id,title,description,value,Icon})=><button type="button" className="processing-entry-row" key={id} onClick={()=>onSelect(id)}><span className="model-profile-symbol"><Icon size={18}/></span><span><strong>{title}</strong><small>{description}</small></span><span className="processing-current">{value||(read.loading?moteText('正在读取…'):moteText('未配置'))}</span><ChevronRight size={15}/></button>)}
  <div className="processing-existing-links"><button className="text-button" onClick={()=>onSelect('providers')}>{moteText('服务连接')} →</button><a className="text-button" href="#/activity">{moteText('后台活动')} →</a></div>
 </section>;
}
