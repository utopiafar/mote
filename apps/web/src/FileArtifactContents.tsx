import {transcriptSchema} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {useResource} from './useResource';
import {errorMessage,type Api} from './api';

/** Derived publications retain their own identity. They do not replace the
 * editable current transcript or invent citations omitted by the producer. */
export function FileArtifactContents({api,id,originalRef,kind}:{api:Api;id:string;originalRef:string;kind:'summary'|'dialogue'|'image'}){
 const read=useResource<{id:string;originalRef:string;payload:unknown}>(api,'/api/processing/artifacts/'+encodeURIComponent(id));
 const parsed=read.data&&transcriptSchema.safeParse(read.data.payload),valid=read.data?.id===id&&read.data.originalRef===originalRef&&parsed?.success;
 const error=read.error?errorMessage(read.error):read.data&&!valid?moteText('服务返回的操作回执与当前账号不一致。'):'';
 return <section className="file-derived-product" data-artifact-id={id}>
  <h4>{kind==='summary'?moteText('模型摘要'):kind==='image'?moteText('查看图片理解'):moteText('语义分组')}</h4>
  {read.loading&&<p role="status">{moteText('正在读取…')}</p>}
  {error&&<p role="alert">{error}<button className="button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
  {valid&&parsed.data.segments.map((segment,index)=><div key={index} className="source-item">{segment.speaker&&<p>{segment.speaker}{segment.uncertain?' · '+moteText('含不确定片段'):''}{segment.overlap?' · '+moteText('重叠说话'):''}</p>}<pre className="file-text">{segment.text}</pre></div>)}
 </section>;
}
