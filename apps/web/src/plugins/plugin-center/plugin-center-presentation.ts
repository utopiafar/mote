import {moteText} from '@mote/shared/i18n';
import {failureMessage} from '../../failure-message';
import type {CapabilityState,MemoryBindingView,MemoryModuleBinding,MemoryPreparationView,PluginBuildSelection,PluginBuildView,PluginConfigurationField,PluginInstanceView} from '@mote/shared';

export function capabilityLabel(state:CapabilityState){
 return state==='verified'?moteText('已核验'):state==='unsupported'?moteText('不支持'):moteText('尚未核验');
}
export function memoryAdmissionLabel(admission:MemoryBindingView['admission']){
 const count=admission.queued+admission.running+admission.checkpointed;
 if(admission.state==='draining')return moteText('停用中：仍有 {0} 个已授权任务',count);
 if(admission.state==='stopping')return moteText('正在立即停止');
 if(admission.state==='blocked')return moteText('需要处理');
 return admission.state==='enabled'?moteText('自动记忆已启用'):moteText('自动记忆已暂停');
}
export function preparationLabel(state:MemoryPreparationView['state']){
 return ({waiting:moteText('等待准备'),running:moteText('正在准备'),blocked:moteText('准备受阻'),failed:moteText('准备失败'),verified:moteText('核验通过 · 尚未生效'),applied:moteText('已生效'),cancelled:moteText('准备已取消')})[state];
}
export function moduleLabel(stage:MemoryModuleBinding['stage']){
 return ({extract:moteText('记忆提取'),review:moteText('独立审查'),integrate:moteText('记忆整合'),repository:moteText('记忆正文'),retrieval:moteText('记忆检索')})[stage];
}
export function packageStateLabel(state:string){
 const labels:Record<string,string>={installed:moteText('已安装'),installing:moteText('正在安装'),failed:moteText('安装失败'),'restart-required':moteText('等待节点重启'),enabled:moteText('已启用'),disabled:moteText('已停用'),paused:moteText('已暂停'),draining:moteText('停用中'),stopping:moteText('正在停止'),blocked:moteText('需要处理'),unconfigured:moteText('待配置'),ready:moteText('可运行'),unknown:moteText('状态未知')};
 return labels[state]??state;
}
export function packageObservedLabel(state:string){
 return state==='disabled'?moteText('未启用'):packageStateLabel(state);
}
export function buildObservedLabel(state:PluginBuildView['observed']){
 const labels:Record<PluginBuildView['observed'],string>={queued:moteText('等待处理'),starting:moteText('正在启动'),active:moteText('运行中'),stopped:moteText('已停止'),blocked:moteText('需要处理'),restart_required:moteText('等待节点重启'),draining:moteText('停用中')};
 return labels[state]??state;
}
export function buildSelectionLabel(selection:PluginBuildSelection){
 return selection.packageId+'@'+selection.version+' · '+moteText('配置版本 {0}',selection.configurationRevision);
}
/** A missing required native provider is requires-build, not a generic
 * unavailable state. Other blocker codes stay literal so support can identify
 * the exact host or dependency failure. */
export function blockerLabel(code:string){
 return code.replaceAll('_','-')==='requires-build'?moteText('需要重新构建（requires-build）'):code;
}
export function hasRequiresBuild(blockers:readonly string[]){
 return blockers.some(code=>code.replaceAll('_','-')==='requires-build');
}
/** Observed is a runtime fact; a desired enable that has not reached it never
 * reads as the opposite stopped state. */
export function instanceObservedLabel(instance:Pick<PluginInstanceView,'desired'|'observed'>){
 if(instance.desired&&instance.observed==='disabled')return moteText('需要处理');
 return packageStateLabel(instance.observed);
}
export function configurationValid(fields:PluginConfigurationField[],values:Record<string,string|number|boolean>){
 return fields.every(field=>{
  const value=values[field.id];
  if(field.required&&(value===undefined||value===''))return false;
  if(value===undefined||value==='')return true;
  if(field.type==='number')return typeof value==='number'&&Number.isFinite(value);
  if(field.type==='boolean')return typeof value==='boolean';
  if(typeof value!=='string')return false;
  return field.type!=='select'||Boolean(field.options?.some(option=>option.value===value));
 });
}

export function preparationPhaseLabel(preparation:Pick<MemoryPreparationView,'state'|'phase'|'kind'>){
 if(preparation.state==='cancelled')return moteText('准备已取消');
 if(preparation.phase==='copy')return preparation.kind==='content-migration'?moteText('正文迁移与索引准备'):moteText('同一正文权威的索引准备');
 return ({drain:moteText('处理中'),verified:moteText('核验通过 · 尚未生效'),applied:moteText('已生效')} as Record<string,string>)[preparation.phase]??moteText('处理中');
}
export function preparationFailureLabel(code:string){const label=failureMessage(code);return label===moteText('操作未完成。错误码：{0}',code)?moteText('准备未完成'):label;}
