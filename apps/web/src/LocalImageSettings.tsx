import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import type {MediaModelsView,PluginBuildSelection,PluginBuildView} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,errorMessage,type Api} from './api';
import {failureMessage} from './failure-message';
import {resources} from './resource-cache';
import {useResource} from './useResource';
import {LoadingText} from './Loading';

/** CORE-03 supplies translated copy and the registered build/state route. The
 * shared settings entry composes MediaPreparation here; this view never owns an
 * installer, a durable switch or background model authorization. */
export type LocalImageSettingsCopy={
    title:string;
    scope:string;
    preparationNote:string;
    disabled:string;
    ready:string;
    waiting:string;
    stopping:string;
    unavailable:string;
    reasons:Readonly<Record<string,string>>;
};
export type LocalImageSettingsProps={
    api:Api;
    control:{instanceId:string;selection:PluginBuildSelection;statePath:string};
    modelName:string;
    copy:LocalImageSettingsCopy;
    preparation:ReactNode;
};
// Structural consumption of IMG-00's state, with no client-side state enum or
// new wire contract. CORE-03 serializes LocalImageProcessingPort.state() here.
type LocalState={enabled:boolean;state:string;reason?:string};
type Intent={expectedRevision:number;operationId:string;selection:PluginBuildSelection|null};
const buildsPath='/api/plugin-builds',modelsPath='/api/media-models',authorizationPath='/api/model-authorization';
const denied=(error:unknown)=>error instanceof ApiError&&[401,403,404,410].includes(error.status);
const sameSelection=(a:PluginBuildSelection|null|undefined,b:PluginBuildSelection)=>Boolean(a&&a.packageId===b.packageId&&a.version===b.version&&a.configurationRevision===b.configurationRevision);

export function LocalImageSettings({api,control,modelName,copy,preparation}:LocalImageSettingsProps){
    const builds=useResource<PluginBuildView[]>(api,buildsPath,3000);
    const models=useResource<MediaModelsView>(api,modelsPath,3000);
    const state=useResource<LocalState>(api,control.statePath,3000);
    const authorization=useResource<{authorization:{state:'on'|'off'}}>(api,authorizationPath,3000);
    const visit=useRef({api,path:control.statePath,id:control.instanceId,alive:true,busy:false});
    if(visit.current.api!==api||visit.current.path!==control.statePath||visit.current.id!==control.instanceId){
        visit.current.alive=false;
        visit.current={api,path:control.statePath,id:control.instanceId,alive:true,busy:false};
    }
    const own=visit.current;
    useEffect(()=>{own.alive=true;return()=>{own.alive=false;};},[own]);
    const [operation,setOperation]=useState<{owner:typeof own;busy:boolean;error?:string;notice?:string;retry?:Intent}>();
    const pending=operation?.owner===own?operation:undefined;
    const scopeId=useId();
    const reads=[builds,models,state,authorization],privateDenied=reads.some(read=>denied(read.error));
    const readError=reads.find(read=>read.error!==undefined)?.error;
    const build=privateDenied?undefined:builds.data?.find(value=>value.id===control.instanceId&&!value.retired);
    const model=privateDenied?undefined:models.data?.['local-image'];
    const local=privateDenied?undefined:state.data;
    const selected=Boolean(build?.desired);
    const transitioning=build?.observed==='queued'||build?.observed==='starting'||build?.observed==='draining';
    const healthy=Boolean(model?.state==='ready'&&model.runtimeReady);
    const ready=readError===undefined&&build?.observed==='active'&&sameSelection(build.desired,control.selection)&&sameSelection(build.active,control.selection)&&local?.enabled===true&&local.state==='ready'&&healthy;
    const reason=local?.reason??build?.blockers[0];
    const reasonText=(code:string)=>copy.reasons[code]??failureMessage(code);
    let actual:ReactNode=copy.unavailable;
    if(readError===undefined&&build&&local){
        if(build.observed==='blocked'||local.state==='failed'&&selected)actual=moteText('处理失败');
        else if(build.observed==='draining'||!selected&&build.observed!=='stopped')actual=copy.stopping;
        else if(!selected&&!local.enabled&&build.observed==='stopped')actual=moteText('已关闭');
        else if(build.observed==='queued'||build.observed==='starting')actual=moteText('正在启动本机处理…');
        else if(ready)actual=copy.ready;
        else if(selected&&local.enabled)actual=copy.waiting;
    }else if(!readError&&reads.some(read=>read.loading))actual=<LoadingText/>;
    // The assembly supplies this trusted optional build's exact registered
    // selection. Native build views currently have no instance allowedActions;
    // their public selectBuild endpoint performs owner/CAS/lifecycle admission.
    const actionable=Boolean(build&&build.packageId===control.selection.packageId);
    const disabled=Boolean(pending?.busy||pending?.retry||readError||!actionable||transitioning||builds.loading);

    function invalidate(){
        resources(api).invalidate(key=>key===buildsPath||key==='/api/plugins'||key===modelsPath||key==='/api/media-preparation'||key===control.statePath);
    }
    function refresh(){builds.refresh();models.refresh();state.refresh();authorization.refresh();}
    async function execute(intent:Intent){
        if(own.busy||privateDenied)return;
        own.busy=true;setOperation({owner:own,busy:true});
        try{
            // An acknowledged owner command outlives this view. Unmount only
            // releases reads; it must not cancel preparation or an accepted stop.
            await api.request(buildsPath+'/'+encodeURIComponent(control.instanceId),{method:'PATCH',body:JSON.stringify(intent)});
            if(own.alive&&visit.current===own)setOperation({owner:own,busy:false,notice:moteText('请求已登记，运行状态以中央返回为准。')});
        }catch(error){
            if(own.alive&&visit.current===own){
                const conflict=error instanceof ApiError&&[409,422].includes(error.status);
                const retry=!(error instanceof ApiError&&[400,401,403,404,409,410,422].includes(error.status));
                setOperation({owner:own,busy:false,error:conflict?moteText('配置或方案已变化；请读取当前状态后重新确认。'):errorMessage(error),...(retry?{retry:intent,notice:moteText('请求结果尚未确认，请重试同一请求。')}:{})});
            }
        }finally{
            own.busy=false;
            invalidate();
        }
    }
    function select(selection:PluginBuildSelection|null){
        if(disabled||!build)return;
        void execute({expectedRevision:build.revision,operationId:crypto.randomUUID(),selection});
    }
    return <section className="policy-card local-image-settings" aria-label={copy.title} style={{minWidth:0,maxWidth:'100%',overflowWrap:'anywhere'}}>
        <h3>{copy.title}</h3>
        <p id={scopeId}>{copy.scope}</p>
        <dl className="plugin-facts">
            <div><dt>{moteText('模型名称')}</dt><dd>{modelName}</dd></div>
            <div><dt>{moteText('状态')}</dt><dd>{build?(selected?moteText('已选择启用'):moteText('已选择停用')):moteText('状态未知')}</dd></div>
            <div><dt>{moteText('当前状态')}</dt><dd role="status">{actual}</dd></div>
            <div><dt>{moteText('中心本机处理')}</dt><dd>{readError===undefined&&model?(healthy?moteText('可使用'):moteText('未就绪')):moteText('状态未知')}</dd></div>
        </dl>
        {reason&&readError===undefined&&(selected||build?.observed==='blocked')&&<p role={local?.state==='failed'||build?.observed==='blocked'?'alert':'status'}>{reasonText(reason)}</p>}
        {Boolean(model?.missingDependencies?.length)&&<p>{moteText('阻塞原因')} · {model!.missingDependencies!.join(' · ')}</p>}
        {authorization.data?.authorization.state==='off'&&!privateDenied&&<p role="status">{moteText('后台模型已关闭')} · {moteText('等待开启自动处理')}</p>}
        {!selected&&build&&<p>{copy.disabled}</p>}
        {readError!==undefined&&<p role="alert">{copy.unavailable} {errorMessage(readError)}</p>}
        {pending?.error&&!privateDenied&&<p role="alert">{pending.error}</p>}
        {pending?.notice&&!privateDenied&&<p role="status">{pending.notice}</p>}
        <div className="source-toolbar" style={{display:'flex',flexWrap:'wrap',minWidth:0}}>
            <button type="button" className="button" role="switch" aria-label={copy.title} aria-describedby={scopeId} aria-checked={selected} disabled={disabled} onClick={()=>select(selected?null:control.selection)}>{selected?moteText('停用'):moteText('启用')}</button>
            {(selected&&!ready||build?.observed==='blocked')&&!transitioning&&<button type="button" className="button" disabled={disabled} onClick={()=>select(build!.desired)}>{moteText('重试')}</button>}
            {pending?.retry&&!privateDenied&&<button type="button" className="button" disabled={pending.busy} onClick={()=>void execute(pending.retry!)}>{moteText('重试同一请求')}</button>}
            <button type="button" className="text-button" disabled={pending?.busy} onClick={refresh}>{moteText('刷新')}</button>
        </div>
        <p>{copy.preparationNote}</p>
        {!privateDenied&&preparation}
        {model&&!privateDenied&&<details><summary>{moteText('固定版本')}</summary><p>{model.version}</p></details>}
    </section>;
}
