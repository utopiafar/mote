import {moteText} from '@mote/shared/i18n';
import type {CapabilityState,MemoryBindingView,MemoryModuleBinding,MemoryPreparationView,PluginConfigurationField} from '@mote/shared';

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
