import {useEffect,useMemo} from 'react';
import {fileViewSchema,featureRequirementsAvailable,type FileCoverage,type FileView} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,type Api,dateTime,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {useForegroundResources} from '../../useForegroundResources';
import {useOperationUpdates} from '../../useOperationUpdates';
import {openQuestionDraft} from '../../open-question-draft';
import {originalReferenceRoute,rememberOriginalReturn} from '../../ask-original-reference';
import {confirmNavigation} from '../../unsaved';
import {DiscoveryLink,DiscoveryProvider,discoveryAvailabilityText,useDiscoveryState} from '../../DiscoveryLink';
import {resolveDiscoveryTarget} from '../../discovery-availability';

export function fileRetentionLabel(retention:FileView['retention']){
 return retention==='reference'?moteText('仅保存引用'):retention==='archive'?moteText('保留原件'):moteText('内容快照');
}
export function FileRetentionNote(){return <p className="fine-print">{moteText('文件快照和原件归档都会上传完整文件，由中央解析或转写。快照处理后删除中央临时原件，保留提取正文；原件归档长期保留文件。仅文件目录不读取正文。')}</p>;}

/** FileView is the host projection. Retention, coverage, body text and summary
 * presence never substitute for its original-opening capability. */
export function useFileStatus(api:Api,id:string){
 const path='/api/files/'+encodeURIComponent(id)+'/view',page=useResource<unknown>(api,path);
 const discovery=useDiscoveryState(api);
 useOperationUpdates(api);useForegroundResources(api,[path]);
 const parsed=useMemo(()=>fileViewSchema.safeParse(page.data),[page.data]);
 const view=parsed.success&&parsed.data.captureId===id?parsed.data:undefined;
 const error=page.error??(page.data!==undefined&&!view?new Error(moteText('中央响应格式无效，请刷新后重试。')):undefined);
 const current=Boolean(view&&error===undefined);
 const supports=(method:string,route:string)=>!discovery.inventoryError&&featureRequirementsAvailable(['http:'+method+':'+route],discovery.inventory);
 const revoked=error instanceof ApiError&&[401,403,404,410].includes(error.status);
 return {view,error,loading:page.loading,refresh:page.refresh,revoked,current,supports,discovery,canOpenOriginal:current&&view!.canOpenOriginal};
}
function Coverage({label,value}:{label:string;value:FileCoverage}){
 const labels:Record<FileCoverage['status'],string>={pending:moteText('等待处理'),partial:moteText('部分内容'),ready:moteText('处理完成'),failed:moteText('处理失败'),unsupported:moteText('不可用')};
 return <div><dt>{label}</dt><dd><span>{labels[value.status]}</span>{value.completed!==undefined&&<span> · {value.completed} / {value.total}</span>}{value.reason&&<details><summary>{moteText('技术详情')}</summary><p>{value.reason}</p></details>}</dd></div>;
}

export function FileStatus({api,status,historical=false}:{api:Api;status:ReturnType<typeof useFileStatus>;historical?:boolean}){
 useEffect(()=>{if(document.head.querySelector('link[data-mote-file-status]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('../../file-status.css',import.meta.url).href;link.dataset.moteFileStatus='true';document.head.append(link);},[]);
 const {view,error,current,supports}=status;
 if(error!==undefined)return <section className="file-status"><p role="alert">{errorMessage(error)} <button className="text-button" onClick={status.refresh}>{moteText('重新读取')}</button></p></section>;
 if(!view)return <section className="file-status"><p role="status">{moteText('正在读取文件状态…')}</p></section>;
 const askAvailability=resolveDiscoveryTarget({pageId:'ask',href:originalReferenceRoute('capture',view.captureId),requires:['http:POST:/api/query-runs']},status.discovery);
 const canAsk=current&&!historical&&askAvailability.state==='available',canUse=canAsk&&supports('POST','/api/assistant/commands');
 const location=view.item.document?.path??view.item.uri;
 return <DiscoveryProvider state={status.discovery}><section className="file-status" aria-label={moteText('文件状态')}>
  <h4>{moteText('文件状态')}</h4>
  <dl className="file-status-facts">
   <div><dt>{moteText('原件位置')}</dt><dd>{location??moteText('未提供位置')}{view.item.uri&&view.item.uri!==location&&<small>{view.item.uri}</small>}</dd></div>
   <div><dt>{moteText('版本')}</dt><dd>{view.item.revision}</dd></div>
   <div><dt>{moteText('最后确认（来源观察）')}</dt><dd><time dateTime={view.item.observedAt}>{dateTime(view.item.observedAt)}</time></dd></div>
   <div><dt>{moteText('位置状态')}</dt><dd>{view.originMissing?moteText('原位置已不可见'):moteText('未报告原位置缺失')}</dd></div>
   <div><dt>{moteText('保存方式')}</dt><dd>{fileRetentionLabel(view.retention)}</dd></div>
   <div><dt>{moteText('原件能力')}</dt><dd>{view.canOpenOriginal?moteText('可打开原件'):moteText('原件不可用')}{view.hasOriginal&&<small>{moteText('原件已归档')}</small>}</dd></div>
   <Coverage label={moteText('正文提取')} value={view.coverage.extraction}/>
   <Coverage label={moteText('语义理解')} value={view.coverage.semantic}/>
   <Coverage label={moteText('向量索引')} value={view.coverage.embedding}/>
  </dl>
  <p className="fine-print">{moteText('来源最近一次观察时间不代表设备当前在线。提取、语义理解、向量索引和原件打开分别确认。')}</p>
  {view.retention==='reference'&&<p role="status">{moteText('此来源仅保留引用与元数据，未导入正文。')}</p>}
  {view.retention==='snapshot'&&!view.hasOriginal&&<p role="status">{moteText('快照原件未保留；已提取正文仍按当前覆盖和读取权限提供。')}</p>}
  {view.coverage.extraction.status==='partial'&&<p role="status">{moteText('资料尚不完整，可在“来源与处理”中查看缺失情况。')}</p>}
  {view.coverage.semantic.status!=='ready'&&<p className="fine-print">{moteText('内容提取或生成摘要不代表已完成全文语义理解。')}</p>}
  {view.retention!=='reference'&&view.coverage.embedding.status!=='ready'&&<p className="fine-print">{moteText('向量索引尚未完整就绪；可用正文仍可通过文本检索查找。')}</p>}
  <FileRetentionNote/>
  <div className="source-toolbar">
   <DiscoveryLink className="button subtle" target={{pageId:'archive',collectionId:'files',href:'#/library?view=files&sourceId='+encodeURIComponent(view.sourceId),requires:['http:GET:/api/files']}}>{moteText('浏览来源资料')}</DiscoveryLink>
   <DiscoveryLink className="button subtle" target={{pageId:'search',href:'#/search?sourceId='+encodeURIComponent(view.sourceId)}}>{moteText('搜索资料')}</DiscoveryLink>
   <button className="button" disabled={!canAsk} onClick={()=>{if(!canAsk||!confirmNavigation())return;rememberOriginalReturn(api,'capture',view.captureId);window.location.hash=originalReferenceRoute('capture',view.captureId);}}>{moteText('问文件')}</button>
   <button className="button" disabled={!canUse} onClick={()=>{if(canUse)openQuestionDraft(api,moteText('请基于这份文件拟定可编辑的工作草稿，说明目标和资料范围，等我确认后开始。'),view.captureId);}}>{moteText('用于事项')}</button>
   <button className="text-button" onClick={status.refresh} disabled={status.loading}>{moteText('刷新')}</button>
  </div>
  {!canAsk&&<p className="fine-print">{historical?moteText('历史证据，仅用于核对当时的内容。'):askAvailability.state==='available'?moteText('当前支持情况暂无法确认'):discoveryAvailabilityText(askAvailability.state)}</p>}
  {canAsk&&!canUse&&<p className="fine-print">{moteText('任务服务尚未接通，暂时不能开始。')}</p>}
  <p className="fine-print">{moteText('用于事项会先准备可编辑草稿，点击开始后才执行。')}</p>
 </section></DiscoveryProvider>;
}
