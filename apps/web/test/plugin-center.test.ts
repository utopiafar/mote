import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import type {MemoryBindingView,MemoryPlanView,PluginCenterView,PluginInstanceView,PluginPackageView,PluginReleasePreview} from '@mote/shared';
import type {Api} from '../src/api.js';
import {ApiError} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {configurationValid,memoryAdmissionLabel} from '../src/plugin-center-presentation.js';

configureLocale(()=> 'zh-CN');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
dom.window.confirm=()=>true;
const {createRoot}=await import('react-dom/client');
const {PluginCenter}=await import('../src/PluginCenter.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
const bindingPath='/api/memory-spaces/default/binding';
const source={repository:'https://github.com/generated-fixture/mote-compatible',tag:'generated-test-release',commit:'generated-test-commit',digest:'generated-test-digest'};
const packageFixture:PluginPackageView={id:'generated-package',name:'Generated test adapter',version:'fixture-1',source,runtime:'worker',state:'installed',desired:false,observed:'disabled',issues:[],instanceIds:[],allowedActions:['configure','uninstall']};
const instanceFixture:PluginInstanceView={id:'generated-instance',packageId:packageFixture.id,name:'Generated test instance',revision:1,scope:'default',configurationSchema:[{id:'serviceReference',label:'Generated service reference',type:'text',required:true},{id:'secretReference',label:'Generated credential reference',type:'secret-reference'}],configuration:{},secretStatus:{},capabilities:[{id:'memory.repository',state:'unknown',reason:'Generated verification pending'}],desired:false,observed:'unconfigured',issues:[],allowedActions:['configure','check']};
const builtin:MemoryPlanView={id:'builtin',name:'Built-in fixture plan',mode:'modules',modules:[],capabilities:[{id:'memory.repository',state:'verified'}],available:true,allowedActions:['prepare']};
const candidate:MemoryPlanView={id:'generated-plan',name:'Generated candidate plan',mode:'modules',instanceId:instanceFixture.id,modules:[],capabilities:[{id:'memory.repository',state:'verified'},{id:'memory.retrieval',state:'verified'}],available:true,allowedActions:['prepare']};
const preview:PluginReleasePreview={id:'private-preview',name:packageFixture.name,version:packageFixture.version,source,runtime:'worker',restartRequired:false,capabilities:[{id:'memory.repository',state:'unknown'}],dependencies:[],access:['Generated authorized scope only'],issues:[],installable:true};
function fixtures(){
 const plugins:PluginCenterView={revision:1,installation:{supported:true,runtime:'worker',restartRequired:false},packages:[],instances:[],catalog:[{repository:source.repository,name:'Generated repository fixture',description:'Test fixture only'}]};
 const binding:MemoryBindingView={revision:1,generation:4,mode:'modules',modules:[],activePlan:structuredClone(builtin),plans:[structuredClone(builtin),structuredClone(candidate),{...structuredClone(candidate),id:'unverified-engine',name:'Generated unverified engine',mode:'engine',available:false,reason:'Generated isolation contract is not proven',capabilities:[{id:'memory.engine',state:'unknown'}],allowedActions:[]}],admission:{desired:true,state:'enabled',generation:4,queued:2,running:1,checkpointed:0,resultUnknown:0},allowedActions:['pause','stop','prepare']};
 return {plugins,binding};
}
function button(host:Element,name:string){const found=[...host.querySelectorAll<HTMLButtonElement>('button')].find(element=>element.textContent===name||element.getAttribute('aria-label')===name);assert.ok(found,`button ${name}`);return found;}
async function click(host:Element,name:string){await act(async()=>{button(host,name).click();await tick();});}
async function input(host:Element,label:string,value:string){const field=[...host.querySelectorAll('label')].find(element=>element.textContent?.startsWith(label))?.querySelector('input');assert.ok(field,`field ${label}`);await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});}
async function mount(t:import('node:test').TestContext,api:Api,hash='#/system/plugins'){dom.window.history.replaceState(null,'',hash);const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);t.after(async()=>{await act(async()=>root.unmount());element.remove();});await act(async()=>{root.render(React.createElement(PluginCenter,{api,onPage:()=>{}}));await tick();});return {element,root};}
async function openInstalled(element:Element){await click(element,'已安装插件');await act(async()=>{element.querySelector<HTMLButtonElement>('.provider-card')!.click();await tick();});}
function readFixture(path:string,plugins:PluginCenterView,binding:MemoryBindingView){if(path==='/api/model-authorization')return {authorization:{revision:1,state:'enabled'}};if(path==='/api/plugins')return structuredClone(plugins);if(path===bindingPath)return structuredClone(binding);if(path==='/api/features')return {features:[],capabilities:[]};throw new Error('Unexpected fixture read '+path);}

test('installation requires an explicit pinned preview, config, verified capabilities, and separate enable; transport retry reuses its operation ID',async t=>{
 const {plugins,binding}=fixtures(),calls:{path:string;body:Record<string,unknown>}[]=[];let installAttempt=0;
 const api={request:async(path:string,init?:RequestInit)=>{
  if(!init?.method)return readFixture(path,plugins,binding);
  const body=JSON.parse(String(init.body));calls.push({path,body});
  if(path==='/api/plugins/resolve')return structuredClone(preview);
  if(path==='/api/plugins/install'){if(++installAttempt===1)throw new TypeError('Generated response lost');plugins.packages=[structuredClone(packageFixture)];plugins.revision++;return structuredClone(plugins);}
  if(path==='/api/plugin-instances'){const instance=structuredClone(instanceFixture);instance.name=body.name;plugins.instances=[instance];plugins.packages[0].instanceIds=[instance.id];plugins.revision++;return instance;}
  const instance=plugins.instances[0];assert.ok(instance);
  if(init.method==='PATCH'){assert.equal(body.expectedRevision,instance.revision);instance.configuration=body.configuration;instance.revision++;instance.observed='disabled';return structuredClone(instance);}
  if(path.endsWith('/check')){assert.equal(body.expectedRevision,instance.revision);instance.revision++;instance.capabilities=[{id:'memory.repository',state:'verified'}];instance.allowedActions=['configure','check','enable'];return structuredClone(instance);}
  if(path.endsWith('/enable')){assert.equal(body.expectedRevision,instance.revision);instance.revision++;instance.desired=true;instance.observed='unbound';instance.allowedActions=['configure','disable'];return structuredClone(instance);}
  throw new Error('Unexpected fixture command '+path);
 }} as unknown as Api;
 const {element}=await mount(t,api);
 assert.equal(calls.length,0,'mounting does not mutate');
 await click(element,'添加插件');await click(element,'选择仓库');await click(element,'预览发布包');
 const dialog=element.querySelector('[role=dialog]')!;assert.ok(dialog.textContent?.includes(source.digest));assert.ok(dialog.textContent?.includes('不是沙箱隔离'));
 await click(dialog,'安装此版本');assert.ok(element.querySelector('[role=dialog]'),'failed request retains its preview');await click(dialog,'重试同一请求');
 const installs=calls.filter(call=>call.path==='/api/plugins/install');assert.equal(installs.length,2);assert.deepEqual(installs[0].body,installs[1].body);assert.equal(installs[0].body.previewId,preview.id);assert.equal('repository' in installs[0].body,false,'install cannot override the pinned source');
 assert.equal(element.querySelector('[role=dialog]'),null);assert.ok(element.textContent?.includes('没有运行，也没有绑定'));
 await click(element,'新增实例');await click(element.querySelector('[role=dialog]')!,'创建实例');
 assert.ok(element.querySelector('[role=dialog]')?.textContent?.includes('Generated service reference'),'creation obtains real schema before enabling');assert.equal(button(element,'保存配置').disabled,true);
 await input(element,'Generated service reference','generated-service-reference');await click(element,'保存配置');
 assert.equal(element.querySelector('[role=dialog]'),null);assert.equal(calls.some(call=>call.path.endsWith('/enable')),false,'saving never enables');
 await click(element,'核验能力');await click(element,'启用');
 assert.equal(binding.activePlan.id,builtin.id,'enabling never activates the candidate');assert.ok(element.textContent?.includes('已选择启用'));
 assert.equal(calls.filter(call=>call.path===bindingPath+'/activate').length,0);
});

test('ordinary pause shows authorized task drainage, immediate stop is separate, and resume displays a new admission generation without replay',async t=>{
 const {plugins,binding}=fixtures(),calls:{path:string;body:Record<string,unknown>}[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{if(!init?.method)return readFixture(path,plugins,binding);calls.push({path,body:JSON.parse(String(init.body))});binding.revision++;
  if(path.endsWith('/pause')){binding.admission.desired=false;binding.admission.state='draining';binding.allowedActions=['resume','stop','prepare'];}
  if(path.endsWith('/stop')){binding.admission.state='stopping';binding.admission.queued=0;binding.admission.running=0;binding.admission.resultUnknown=1;binding.allowedActions=['resume','prepare'];}
  if(path.endsWith('/resume')){binding.admission.desired=true;binding.admission.state='enabled';binding.admission.generation++;binding.allowedActions=['pause','stop','prepare'];}
  return structuredClone(binding);
 }} as unknown as Api;
 const {element}=await mount(t,api);await click(element,'自动记忆');
 await act(async()=>{element.querySelector<HTMLButtonElement>('[role=switch]')!.click();await tick();});
 assert.ok(element.textContent?.includes('停用中：仍有 3 个已授权任务'));assert.equal(element.querySelector('[role=switch]')?.getAttribute('aria-checked'),'false');assert.equal(calls[0].path,bindingPath+'/pause');
 assert.equal(calls.some(call=>call.path.endsWith('/stop')),false);
 await click(element,'立即停止');assert.equal(calls.length,1,'opening confirmation does not stop tasks');await click(element.querySelector('[role=dialog]')!,'确认立即停止');
 assert.ok(element.textContent?.includes('停止请求不代表远端工作已结束'));assert.equal(binding.admission.resultUnknown,1);
 await act(async()=>{element.querySelector<HTMLButtonElement>('[role=switch]')!.click();await tick();});
 assert.equal(calls.at(-1)!.path,bindingPath+'/resume');assert.equal('scope' in calls.at(-1)!.body,false,'resume never submits historical scope');assert.ok(element.textContent?.includes('当前准入代次 5'));
});

test('replacement separates scope and fee acknowledgement, preparation, verification, retry and activation; unknown engines remain blocked',async t=>{
 const {plugins,binding}=fixtures(),calls:{path:string;body:Record<string,unknown>}[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{if(!init?.method)return readFixture(path,plugins,binding);const body=JSON.parse(String(init.body));calls.push({path,body});assert.equal(body.expectedRevision,binding.revision);binding.revision++;
  if(path.endsWith('/prepare'))binding.preparation={operationId:'generated-preparation',targetPlanId:candidate.id,scope:body.scope,state:'failed',phase:'copy',kind:'content-migration',checks:[{id:'content-and-tombstones',state:'unknown'}],oldAdmissionFrozen:false,tail:3,usageUnknown:true,error:'memory_preparation_requires_attention',allowedActions:['retry','cancel']};
  if(path.endsWith('/retry')){assert.equal(body.preparationId,'generated-preparation');binding.preparation!.state='verified';binding.preparation!.phase='generated-tail-verified';binding.preparation!.oldAdmissionFrozen=true;binding.preparation!.tail=0;binding.preparation!.checks=[{id:'old-authorized-tail-drained',state:'verified'},{id:'content-and-tombstones',state:'verified'}];binding.preparation!.allowedActions=['activate','cancel'];binding.allowedActions=['pause','stop','activate'];}
  if(path.endsWith('/activate')){assert.equal(body.preparationId,'generated-preparation');binding.activePlan=structuredClone(candidate);binding.generation++;binding.preparation!.state='applied';binding.preparation!.allowedActions=[];binding.allowedActions=['pause','stop','prepare'];}
  return structuredClone(binding);
 }} as unknown as Api;
 const {element}=await mount(t,api);await click(element,'自动记忆');
 const unknown=[...element.querySelectorAll('.plugin-plan')].find(plan=>plan.textContent?.includes('Generated unverified engine'))!;assert.equal(unknown.querySelector<HTMLButtonElement>('button')!.disabled,true);assert.ok(unknown.textContent?.includes('not proven'));
 await click(element,'预览更换');const prepare=element.querySelector('[role=dialog]')!;assert.equal(button(prepare,'开始准备').disabled,true);await act(async()=>prepare.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await click(prepare,'开始准备');
 assert.equal(calls[0].body.feeAcknowledged,true);assert.equal(calls[0].body.scope,'default');assert.equal(binding.activePlan.id,builtin.id);assert.ok(element.textContent?.includes('准备失败'));assert.ok(element.querySelector('.plugin-preparation [role=alert]')?.textContent?.includes('准备未完成'));assert.doesNotMatch(element.querySelector('.plugin-preparation')!.textContent!,/memory_preparation_requires_attention|当前阶段：copy/);assert.equal(element.textContent?.includes('设为当前方案'),false);
 await click(element,'重试准备');assert.ok(element.textContent?.includes('核验通过 · 尚未生效'));assert.ok(element.textContent?.includes('旧方案已冻结新增写入'));assert.ok(element.textContent?.includes('待核对尾部任务：0'));assert.equal(binding.activePlan.id,builtin.id);assert.equal(element.querySelector('.plugin-preparation [role=alert]'),null,'a verified retry does not display the previous failed attempt as a current error');
 await click(element,'设为当前方案');assert.equal(binding.activePlan.id,candidate.id);assert.equal(binding.generation,5);
});

test('owner revision conflicts reload actual state and never silently retry; dialogs restore the triggering control',async t=>{
 const {plugins,binding}=fixtures();plugins.packages=[structuredClone(packageFixture)];plugins.instances=[structuredClone(instanceFixture)];plugins.packages[0].instanceIds=[instanceFixture.id];let posts=0;
 const api={request:async(path:string,init?:RequestInit)=>{if(!init?.method)return readFixture(path,plugins,binding);posts++;plugins.instances[0].revision=7;throw new ApiError('Generated revision conflict',409);}} as unknown as Api;
 const {element}=await mount(t,api);await openInstalled(element);const origin=button(element,'配置');origin.focus();await click(element,'配置');const panel=element.querySelector('[role=dialog]')!;await input(panel,'Generated service reference','generated-edited-reference');await click(panel,'保存配置');assert.equal(posts,1);assert.equal(panel.textContent?.includes('重试同一请求'),false);assert.ok(element.textContent?.includes('配置版本 7'));
 await click(panel,'重新读取配置并丢弃草稿');assert.equal(element.querySelector<HTMLInputElement>('[role=dialog] input')?.value,instanceFixture.name);assert.equal(button(element,'保存配置').disabled,true,'reload uses current server configuration, not the stale draft');await click(element.querySelector('[role=dialog]')!,'关闭详情');assert.equal(document.activeElement,origin);assert.equal(element.querySelector('[role=dialog]'),null);
});

test('switching authenticated sessions discards stale preview results and aborts outstanding commands',async t=>{
 const first=fixtures(),second=fixtures();let resolvePreview:(value:PluginReleasePreview)=>void=()=>{};let requestSignal:AbortSignal|undefined;
 const oldApi={request:async(path:string,init?:RequestInit)=>{if(!init?.method)return readFixture(path,first.plugins,first.binding);requestSignal=init.signal as AbortSignal;return new Promise<PluginReleasePreview>(resolve=>{resolvePreview=resolve;});}} as unknown as Api;
 const newApi={request:async(path:string)=>readFixture(path,second.plugins,second.binding)} as unknown as Api;
 const {element,root}=await mount(t,oldApi);await click(element,'添加插件');await click(element,'选择仓库');await act(async()=>button(element,'预览发布包').click());
 await act(async()=>{root.render(React.createElement(PluginCenter,{api:newApi,onPage:()=>{}}));await tick();});assert.equal(requestSignal?.aborted,true);await act(async()=>{resolvePreview(preview);await tick();});assert.equal(element.querySelector('[role=dialog]'),null);assert.equal(element.querySelector<HTMLInputElement>('input[placeholder]')?.value,'');
});

test('unavailable installation remains explicit and configuration validation rejects invalid values without inferring capabilities',async t=>{
 const {plugins,binding}=fixtures();plugins.installation={supported:false,reason:'Generated runtime does not implement installation',runtime:'worker',restartRequired:true};let mutation=false;
 const api={request:async(path:string,init?:RequestInit)=>{if(init?.method)mutation=true;return readFixture(path,plugins,binding);}} as unknown as Api;
 const {element}=await mount(t,api);await click(element,'添加插件');await click(element,'选择仓库');assert.equal(button(element,'预览发布包').disabled,true);assert.ok(element.textContent?.includes(plugins.installation.reason!));assert.equal(mutation,false);
 assert.equal(configurationValid([{id:'count',label:'Generated count',type:'number',required:true}],{count:NaN}),false);
 assert.equal(configurationValid([{id:'option',label:'Generated option',type:'select',options:[{value:'allowed',label:'Allowed'}]}],{option:'unknown'}),false);
 assert.equal(memoryAdmissionLabel({...binding.admission,desired:false,state:'draining',queued:0,running:1,checkpointed:2}), '停用中：仍有 3 个已授权任务');
 await act(async()=>resources(api).invalidate(key=>key===bindingPath));
});

test('uninstall is unavailable for a bound package and requires a fresh owner-confirmed command for an eligible package',async t=>{
 const {plugins,binding}=fixtures(),calls:{path:string;body:Record<string,unknown>}[]=[];plugins.packages=[{...structuredClone(packageFixture),allowedActions:['configure'],issues:['Generated historical reader still pins this package']}];
 const api={request:async(path:string,init?:RequestInit)=>{if(!init?.method)return readFixture(path,plugins,binding);calls.push({path,body:JSON.parse(String(init.body))});plugins.packages=[];plugins.revision++;return structuredClone(plugins);}} as unknown as Api;
 const {element}=await mount(t,api);await openInstalled(element);assert.equal(element.textContent?.includes('卸载安装包'),false);assert.ok(element.textContent?.includes('historical reader'));
 plugins.packages[0].allowedActions.push('uninstall');plugins.packages[0].issues=[];await act(async()=>{resources(api).invalidate(key=>key==='/api/plugins');await tick();});
 await click(element,'卸载安装包');assert.equal(calls.length,0);await click(element.querySelector('[role=dialog]')!,'确认卸载');assert.equal(calls[0].path,'/api/plugins/'+packageFixture.id+'/uninstall');assert.equal(calls[0].body.expectedRevision,1);assert.ok(element.textContent?.includes('还没有安装外部插件'));
});

test('revoked plugin reads discard cached configuration and close its owner modal',async t=>{
 const {plugins,binding}=fixtures();plugins.packages=[structuredClone(packageFixture)];plugins.instances=[structuredClone(instanceFixture)];let revoked=false;
 const api={request:async(path:string)=>{if(path==='/api/plugins'&&revoked)throw new ApiError('Generated permission revoked',403);return readFixture(path,plugins,binding);}} as unknown as Api;
 const {element}=await mount(t,api);await openInstalled(element);await click(element,'配置');assert.ok(element.querySelector('[role=dialog]'));revoked=true;await act(async()=>{resources(api).invalidate(key=>key==='/api/plugins');await tick();});assert.equal(element.querySelector('[role=dialog]'),null);assert.equal(element.querySelector('.plugin-package-detail'),null);assert.ok(element.textContent?.includes('Generated permission revoked'));
});

test('an installed package exposes required fields before the first instance exists and saves its initial configuration in one command',async t=>{
 const {plugins,binding}=fixtures(),calls:{path:string;body:Record<string,unknown>}[]=[];
 plugins.packages=[{...structuredClone(packageFixture),configurationSchema:structuredClone(instanceFixture.configurationSchema)}];
 const api={request:async(path:string,init?:RequestInit)=>{
  if(!init?.method)return readFixture(path,plugins,binding);
  const body=JSON.parse(String(init.body));calls.push({path,body});
  const instance={...structuredClone(instanceFixture),name:body.name,configuration:body.configuration};plugins.instances=[instance];plugins.revision++;
  return structuredClone(instance);
 }} as unknown as Api;
 const {element}=await mount(t,api);await openInstalled(element);await click(element,'新增实例');const dialog=element.querySelector('[role=dialog]')!;
 assert.ok(dialog.textContent?.includes('Generated service reference'));assert.equal(button(dialog,'创建实例').disabled,true);
 await input(dialog,'Generated service reference','generated-initial-service');await click(dialog,'创建实例');
 assert.equal(element.querySelector('[role=dialog]'),null);assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/plugin-instances');
 assert.deepEqual(calls[0].body.configuration,{serviceReference:'generated-initial-service'});assert.equal(calls[0].body.packageId,packageFixture.id);
 assert.equal(plugins.instances[0].desired,false);assert.equal(binding.activePlan.id,builtin.id);
});


test('plugin deep links and same-page browser history retain the selected tab',async t=>{
 const {plugins,binding}=fixtures(),api={request:async(path:string)=>readFixture(path,plugins,binding)} as unknown as Api;
 const {element}=await mount(t,api,'#/system/plugins?tab=memory');
 assert.equal(button(element,'自动记忆').getAttribute('aria-pressed'),'true');
 await act(async()=>{dom.window.location.hash='#/system/plugins?tab=discover';dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));await tick();});
 assert.equal(button(element,'添加插件').getAttribute('aria-pressed'),'true');
 await act(async()=>{dom.window.location.hash='#/system/plugins';dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));await tick();});
 assert.equal(button(element,'自动记忆').getAttribute('aria-pressed'),'true');
});

test('automatic Memory desire is separate from the real global authorization; failed reads remain unavailable without implying approval',async t=>{
 const {plugins,binding}=fixtures();let state='unapproved',denied=false,writes=0;const api={request:async(path:string,init?:RequestInit)=>{if(init?.method){writes++;throw Error('No authorization mutation belongs to this read-only status');}if(path==='/api/model-authorization'){if(denied)throw new ApiError('Generated automatic processing authorization denied',403);return {authorization:{revision:1,state}};}return readFixture(path,plugins,binding);}} as Api;
 const {element}=await mount(t,api);assert.equal(button(element,'自动记忆').getAttribute('aria-pressed'),'true');assert.match(element.querySelector('.plugin-memory-control [role=status]')!.textContent!,/等待开启自动处理/);assert.equal(element.querySelector('[role=switch]')!.getAttribute('aria-checked'),'true');assert.equal(element.querySelector<HTMLAnchorElement>('.plugin-waiting-authorization a')!.hash,'#/system/models?category=processing');
 denied=true;await act(async()=>{resources(api).invalidate(path=>path==='/api/model-authorization');await tick();});assert.match(element.querySelector('.plugin-memory-control [role=status]')!.textContent!,/暂不可用/);assert.equal(element.querySelector('.plugin-waiting-authorization'),null);assert.match(element.textContent!,/Generated automatic processing authorization denied/);denied=false;state='enabled';await act(async()=>{resources(api).invalidate(path=>path==='/api/model-authorization');await tick();});assert.match(element.querySelector('.plugin-memory-control [role=status]')!.textContent!,/自动记忆已启用/);assert.equal(writes,0);
});

const pluginReadPaths=['/api/plugins',bindingPath,'/api/model-authorization'];
function generatedPluginApi(){
 const data=fixtures(),reads:{path:string;signal?:AbortSignal|null}[]=[],feeds:{path:string;signal?:AbortSignal|null}[]=[],writes:{path:string;body:any;signal?:AbortSignal|null}[]=[];
 const authorization={authorization:{revision:1,state:'enabled'}};let change={cursor:0,ids:[] as string[],reset:false,hasMore:false};
 let readHook:((path:string,value:unknown,init?:RequestInit)=>unknown)|undefined,feedHook:((value:typeof change,init?:RequestInit)=>unknown)|undefined,writeHook:((path:string,init:RequestInit)=>unknown)|undefined;
 const api={request:async(path:string,init?:RequestInit)=>{
  if(path.startsWith('/api/operations/changes?')){feeds.push({path,signal:init?.signal});const value=structuredClone(change);change.ids=[];return feedHook?.(value,init)??value;}
  if(init?.method&&init.method!=='GET'){writes.push({path,body:JSON.parse(String(init.body)),signal:init.signal});return writeHook?.(path,init)??{};}
  reads.push({path,signal:init?.signal});const value=path==='/api/model-authorization'?structuredClone(authorization):readFixture(path,data.plugins,data.binding);return readHook?.(path,value,init)??value;
 }} as Api;
 return{...data,authorization,api,reads,feeds,writes,count:(path:string)=>reads.filter(read=>read.path===path).length,emit:(ids:string[])=>{change={...change,cursor:change.cursor+1,ids};},read:(hook:typeof readHook)=>readHook=hook,feed:(hook:typeof feedHook)=>feedHook=hook,write:(hook:typeof writeHook)=>writeHook=hook};
}
async function pluginClock(t:import('node:test').TestContext,api:Api,hash='#/system/plugins?tab=memory',copies=1){
 const previous=Object.getOwnPropertyDescriptor(document,'hidden');let hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});
 dom.window.history.replaceState(null,'',hash);t.mock.timers.enable({apis:['setTimeout']});
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);
 t.after(async()=>{t.mock.timers.reset();await act(async()=>root.unmount());element.remove();if(previous)Object.defineProperty(document,'hidden',previous);else Reflect.deleteProperty(document,'hidden');});
 const flush=async(ms=0)=>act(async()=>{t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));});
 const render=(owner:Api)=>act(async()=>root.render(React.createElement(React.Fragment,null,...Array.from({length:copies},(_,key)=>React.createElement(PluginCenter,{key,api:owner,onPage:()=>{}})))));
 await render(api);await flush();
 return{element,render,tick:flush,visibility:async(value:boolean)=>{hidden=value;await act(async()=>{document.dispatchEvent(new dom.window.Event('visibilitychange'));});},click:async(name:string)=>{await act(async()=>button(element,name).click());await flush();},installed:async()=>{await act(async()=>button(element,'已安装插件').click());await act(async()=>element.querySelector<HTMLButtonElement>('.provider-card')!.click());await flush();}};
}

test('plugin foreground coalesces three idle shared resources after hidden 60s and preserves all 3s fallbacks',async t=>{
 const f=generatedPluginApi();f.binding.admission.queued=0;f.binding.admission.running=0;
 const ui=await pluginClock(t,f.api,undefined,2);for(const path of pluginReadPaths)assert.equal(f.count(path),1);assert.equal(f.feeds.length,1,'one existing feed subscription per Api');
 await ui.visibility(true);f.binding.activePlan.name='Generated remote plan';f.authorization.authorization.state='paused';await ui.tick(60000);
 for(const path of pluginReadPaths)assert.equal(f.count(path),1,'hidden resource timers do not GET');assert.equal(f.feeds.length,1,'hidden feed timers do not GET');
 await ui.visibility(false);await ui.visibility(false);await ui.tick();for(const path of pluginReadPaths)assert.equal(f.count(path),2,'one foreground GET per exact key');assert.match(ui.element.textContent!,/Generated remote plan/);assert.match(ui.element.textContent!,/等待开启自动处理/);
 await ui.tick(2999);for(const path of pluginReadPaths)assert.equal(f.count(path),2);await ui.tick(1);for(const path of pluginReadPaths)assert.equal(f.count(path),3,'idle still uses the visible3s correctness fallback');assert.ok(f.feeds.length>1,'feed GETs are counted separately, not called push');
});

test('plugin feed uses existing plugin/binding matches while no-event remote stop still needs 3s reads',async t=>{
 const f=generatedPluginApi(),ui=await pluginClock(t,f.api,'#/system/plugins?tab=installed');assert.equal(ui.element.querySelectorAll('.provider-card').length,0);
 f.plugins.packages=[structuredClone(packageFixture)];f.emit(['plugin:generated-install']);await ui.tick(1500);
 assert.equal(ui.element.querySelectorAll('.provider-card').length,1);assert.equal(f.count('/api/plugins'),2);assert.equal(f.count(bindingPath),2);assert.equal(f.count('/api/model-authorization'),1,'existing mapping does not cover global authorization');
 await ui.click('自动记忆');f.binding.admission={...f.binding.admission,desired:false,state:'stopping',queued:0,running:0,resultUnknown:1};f.binding.allowedActions=['resume','prepare'];f.binding.activePlan.name='Generated remotely changed binding';
 await ui.tick(1500);assert.equal(ui.element.querySelector('[role=switch]')!.getAttribute('aria-checked'),'false');assert.match(ui.element.textContent!,/Generated remotely changed binding/);assert.match(ui.element.textContent!,/停止请求不代表远端工作已结束/);assert.equal(f.writes.length,0);
});

test('plugin foreground hint follows a held read once without aborting it or duplicating shared observers',async t=>{
 const f=generatedPluginApi(),ui=await pluginClock(t,f.api,undefined,2);let release!:(value:unknown)=>void;let captured:unknown;
 f.read((path,value)=>path==='/api/plugins'?new Promise(resolve=>{captured=value;release=resolve;}):undefined);
 await ui.tick(3000);assert.equal(f.count('/api/plugins'),2);const held=f.reads.filter(read=>read.path==='/api/plugins').at(-1)!;
 await ui.visibility(true);await ui.tick(60000);await ui.visibility(false);await ui.visibility(false);assert.equal(f.count('/api/plugins'),2);assert.equal(held.signal?.aborted,false);
 f.read(undefined);await act(async()=>release(captured));await ui.tick();assert.equal(f.count('/api/plugins'),3,'one fresh follow-up after held completion');
});

test('plugin foreground keeps three 3s resource reads while an installation preview command is busy',async t=>{
 const f=generatedPluginApi(),ui=await pluginClock(t,f.api,'#/system/plugins?tab=discover');let finish!:(value:unknown)=>void;
 f.write(path=>path==='/api/plugins/resolve'?new Promise(resolve=>finish=resolve):undefined);
 await act(async()=>ui.element.querySelector<HTMLElement>('.plugin-discovery summary')!.click());await ui.click('选择仓库');await ui.click('预览发布包');assert.equal(typeof finish,'function');const before=pluginReadPaths.map(path=>f.count(path));
 await ui.tick(3000);for(const[index,path]of pluginReadPaths.entries())assert.equal(f.count(path),before[index]+1,'busy installation must not stop its resource reads');
 await act(async()=>finish(structuredClone(preview)));await ui.tick();assert.equal(Boolean(ui.element.querySelector('[role=dialog]')),true);
});

test('plugin foreground old Api responses and its feed cannot revive after an owner switch',async t=>{
 const old=generatedPluginApi();old.plugins.packages=[structuredClone(packageFixture)];const ui=await pluginClock(t,old.api,'#/system/plugins?tab=installed');let finish!:(value:unknown)=>void;
 old.read(path=>path==='/api/plugins'?new Promise(resolve=>finish=resolve):undefined);await ui.tick(3000);const held=old.reads.filter(read=>read.path==='/api/plugins').at(-1)!;
 await ui.visibility(true);await ui.visibility(false);const fresh=generatedPluginApi();fresh.plugins.packages=[{...structuredClone(packageFixture),name:'Generated new owner package'}];await ui.render(fresh.api);await ui.tick();const feeds=old.feeds.length;
 assert.equal(held.signal?.aborted,true);old.read(undefined);await act(async()=>finish({...old.plugins,packages:[{...packageFixture,name:'LATE OLD PACKAGE'}]}));await ui.tick(60000);
 assert.equal(old.count('/api/plugins'),2);assert.equal(old.feeds.length,feeds,'unmounted old owner has no feed polls');assert.match(ui.element.textContent!,/Generated new owner package/);assert.doesNotMatch(ui.element.textContent!,/LATE OLD PACKAGE/);
});

for(const path of pluginReadPaths)test('plugin foreground '+path+' 503 remains unavailable and recovers on the next foreground',async t=>{
 const f=generatedPluginApi(),ui=await pluginClock(t,f.api);let failed=true;
 await ui.visibility(true);f.read(key=>{if(key===path&&failed)throw new ApiError('Generated resource503',503);});await ui.visibility(false);await ui.tick();assert.match(ui.element.textContent!,/Generated resource503/);
 if(path==='/api/model-authorization')assert.match(ui.element.querySelector('.plugin-memory-control [role=status]')!.textContent!,/暂不可用/);
 await ui.visibility(true);failed=false;await ui.visibility(false);await ui.tick();assert.doesNotMatch(ui.element.textContent!,/Generated resource503/);assert.equal(f.writes.length,0);
});

test('plugin feed error retry is 3s rather than push and returns to its existing 1.5s interval',async t=>{
 const f=generatedPluginApi();let failed=true;f.feed(value=>{if(failed)throw new ApiError('Generated feed503',503);return value;});const ui=await pluginClock(t,f.api);
 assert.equal(f.feeds.length,1);await ui.tick(2999);assert.equal(f.feeds.length,1);await ui.tick(1);assert.equal(f.feeds.length,2);for(const path of pluginReadPaths)assert.equal(f.count(path),2,'resource fallback survives a broken feed');
 failed=false;await ui.tick(3000);assert.equal(f.feeds.length,3);await ui.tick(1500);assert.equal(f.feeds.length,4);
});

for(const deniedPath of ['/api/plugins',bindingPath])test('plugin foreground denial of '+deniedPath+' closes configuration and discards its draft',async t=>{
 const f=generatedPluginApi();f.plugins.packages=[structuredClone(packageFixture)];f.plugins.instances=[structuredClone(instanceFixture)];const ui=await pluginClock(t,f.api);
 await ui.installed();await ui.click('配置');await input(ui.element,'Generated service reference','Generated private configuration');assert.equal(Boolean(ui.element.querySelector('[role=dialog]')),true);
 await ui.visibility(true);f.read(path=>{if(path===deniedPath)throw new ApiError('Generated owner denied',403);});await ui.visibility(false);await ui.tick();assert.equal(Boolean(ui.element.querySelector('[role=dialog]')),false);assert.doesNotMatch(ui.element.textContent!,/Generated private configuration/);
 f.read(undefined);await ui.visibility(true);await ui.visibility(false);await ui.tick();await ui.click('配置');const field=[...ui.element.querySelectorAll('label')].find(label=>label.textContent?.startsWith('Generated service reference'))!.querySelector('input')!;assert.equal(field.value,'');
});

test('plugin foreground revoked owner clears repository/tag drafts and cannot reopen a late preview',async t=>{
 const f=generatedPluginApi(),ui=await pluginClock(t,f.api,'#/system/plugins?tab=discover');let finish!:(value:unknown)=>void;
 await act(async()=>ui.element.querySelector<HTMLElement>('.plugin-discovery summary')!.click());await input(ui.element,'GitHub 仓库','https://github.com/generated-private/repository');await input(ui.element,'发布标签（可选）','generated-private-tag');f.write(path=>path==='/api/plugins/resolve'?new Promise(resolve=>finish=resolve):undefined);await ui.click('预览发布包');assert.equal(typeof finish,'function');
 await ui.visibility(true);f.read(path=>{if(path==='/api/plugins')throw new ApiError('Generated owner denied',403);});await ui.visibility(false);await ui.tick();await act(async()=>finish(structuredClone(preview)));await ui.tick();
 const fields=ui.element.querySelectorAll('.plugin-discovery input');assert.equal((fields[0] as HTMLInputElement).value,'');assert.equal((fields[1] as HTMLInputElement).value,'');assert.equal(Boolean(ui.element.querySelector('[role=dialog]')),false);assert.equal(button(ui.element,'预览发布包').disabled,true);
});
