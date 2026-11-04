import {moteText} from '@mote/shared/i18n';
import {useSyncExternalStore} from 'react';
import {webFeatures} from '../../features/registry';
import {validatedReturnTarget} from '../../route-query';
import {useHashChoice} from '../../useHashChoice';
const readReturn=(hash:string)=>new URLSearchParams(hash.split('?')[1]??'').get('returnTo');
export function modelSetupHref(category:'providers'|'model',returnTo?:string){
 const query=new URLSearchParams({category});
 if(returnTo?.startsWith('#/'))query.set('returnTo',returnTo);
 return '#/system/models?'+query;
}
export function ModelStartGuide({step,contextualOnly=false}:{step?:'connection'|'module';contextualOnly?:boolean}){
 useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
 const [candidate]=useHashChoice('returnTo',readReturn);
 const returnTo=candidate!==null?validatedReturnTarget(candidate,webFeatures.pages(),webFeatures.collections()):undefined;
 if(contextualOnly&&candidate===null)return null;
 return <div className="discovery-model-start" aria-label={moteText('开始使用 AI 功能')}><nav aria-label={moteText('开始使用 AI 功能')}><a aria-current={step==='connection'?'step':undefined} className={step==='connection'?'is-current':''} href={modelSetupHref('providers',returnTo)}>{moteText('① 保存或检查模型连接')}</a><span aria-hidden="true">→</span><a aria-current={step==='module'?'step':undefined} className={step==='module'?'is-current':''} href={modelSetupHref('model',returnTo)}>{moteText('② 检查 / 分配对应模块')}</a>{candidate!==null&&<><span aria-hidden="true">→</span>{returnTo?<a href={returnTo}>{moteText('③ {0}',moteText('返回原任务'))}</a>:<span role="status">{moteText('原任务入口当前不可用，请从主导航继续。')}</span>}</>}</nav><details className="model-setup-help"><summary>{moteText('模型设置说明')}</summary><p><strong>{moteText('开始使用 AI 功能')}</strong>{moteText('：已有可用默认时可直接使用；需要设置时，按下面顺序检查。')}</p><small>{moteText('例如问答检查「Chat 问答」，记忆提取检查「Memory 记忆提取」。无需创建新预设或修改所有模块；高级参数和自动处理节奏按需设置。')}</small></details></div>;
}
