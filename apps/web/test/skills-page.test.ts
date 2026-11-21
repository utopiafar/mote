import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {configureLocale} from '@mote/shared/i18n';
import {navigationFor,type PluginBuildView,type PluginCenterView,type PluginInstanceView,type PluginPackageView,type PluginSourceContribution,type Routine,type ServerConfiguration,type SourceConnection} from '@mote/shared';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';

configureLocale(()=> 'zh-CN');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import('react-dom/client');
const {SkillsPage,routinesPath,routineScopeSummary}=await import('../src/plugins/plugin-center/SkillsPage.js');
const {pinnedNavPages}=await import('../src/plugins/plugin-center/pinned-pages.js');
const {Sources}=await import('../src/plugins/sources/Sources.js');
const {withPinnedPages}=await import('../src/WorkspaceSidebar.js');

const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function waitFor(check:()=>boolean,label:string){
 const until=Date.now()+2000;
 while(Date.now()<until){if(check())return;await act(async()=>{await tick();});}
 assert.fail(label);
}
const source={repository:'generated-fixture/mote-compatible',tag:'generated-test-release',commit:'a'.repeat(40),digest:'b'.repeat(64)};
const notionPackage:PluginPackageView={id:'mote.connector.notion',name:'Notion',version:'1.0.0',source,runtime:'service',state:'installed',desired:true,observed:'ready',issues:[],instanceIds:['generated-notion-instance'],allowedActions:['configure','uninstall']};
const notionInstance:PluginInstanceView={id:'generated-notion-instance',packageId:notionPackage.id,name:'Notion',revision:4,scope:'default',configurationSchema:[],configuration:{},secretStatus:{},capabilities:[{id:'source.connector',state:'verified'}],desired:true,observed:'ready',issues:[],allowedActions:['configure','check','disable']};
const readerPackage:PluginPackageView={id:'mote.page.generated-reader',name:'Generated reading list',version:'1.0.0',source,runtime:'service',state:'installed',desired:true,observed:'ready',issues:[],instanceIds:['generated-reader-instance'],allowedActions:['configure','uninstall']};
const readerInstance:PluginInstanceView={id:'generated-reader-instance',packageId:readerPackage.id,name:'Generated reading list',revision:2,scope:'default',configurationSchema:[],configuration:{},secretStatus:{},capabilities:[],desired:true,observed:'ready',issues:[],allowedActions:['configure','disable']};
const brokenPackage:PluginPackageView={id:'mote.generated-broken',name:'Generated broken adapter',version:'1.0.0',source,runtime:'service',state:'failed',desired:false,observed:'blocked',issues:['generated_failure'],instanceIds:[],allowedActions:['uninstall']};
const notionContribution:PluginSourceContribution={packageId:notionPackage.id,packageName:notionPackage.name,contributionId:'generated-notion',title:'Generated Notion',body:'Generated fixture',note:'',icon:'notion',kinds:['mote.official.notion'],target:{pageId:'sources',href:'#/connections'},state:'enabled',instanceId:notionInstance.id};
const gmailBuild:PluginBuildView={id:'bundled:gmail',packageId:'mote.connector.gmail',installationId:'bundled:gmail',revision:2,desired:{packageId:'mote.connector.gmail',version:'1',configurationRevision:0},retired:false,observed:'active',blockers:[],operationId:'generated-build-operation',restartRequired:false,name:'Gmail',version:'1',runtime:'host',source:null,configuration:{},configurationSchema:[],capabilities:[],issues:[],allowedActions:['enable','disable'],package:false};
const routine:Routine={id:'11111111-1111-4111-8111-111111111111',revision:1,enabled:true,nextDue:'2026-11-27T09:00:00.000Z',goal:'Generated weekly release review',scope:{kind:'all'},schedule:{revision:1,timeZone:'Asia/Shanghai',trigger:{kind:'weekly',weekday:5,localTime:'17:00'}},matterId:null,event:null};
const notionSource:SourceConnection={id:'generated-notion-source',name:'Notion',kind:'mote.official.notion',deviceId:'generated-notion-device',platform:'import',retention:'snapshot',enabled:true,createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'};
const fileSource:SourceConnection={id:'generated-file-source',name:'Generated files',kind:'local-files',deviceId:'generated-file-device',platform:'import',retention:'archive',enabled:true,createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'};
const readingPageId=readerInstance.id+'/generated-reading-list',settingsPageId=readerInstance.id+'/generated-reader-settings';
const pages=[{id:readingPageId,label:'Generated reading list',featureId:readerPackage.id},{id:settingsPageId,label:'Generated reader settings',featureId:readerPackage.id},{id:'generated-uninstalled-page',label:'Generated uninstalled page',featureId:'mote.generated-uninstalled'}];

function configuration(pinnedPages:string[]=[]):ServerConfiguration{
 return {version:1,revision:3,configFile:'generated',domains:[{id:'ui',saved:{pinnedPages},effective:{pinnedPages},fields:[{path:'pinnedPages',effect:'immediate'}],status:'applied'}],lastError:null,profile:'fixture',runtime:'native',hostConfigFile:null,ownerCredential:{configured:true,source:'programmatic'},baseDir:'/generated',readOnly:false,restartRequired:false,description:'Generated fixture configuration',storage:{dataDir:'/generated/data',sqlitePath:'/generated/data/mote.sqlite',assetDir:'/generated/assets',logDir:'/generated/logs',kind:'local-directory',source:null,mountPath:null,description:'Generated fixture storage'}};
}

function state(pinnedPages:string[]=[]){
 const plugins:PluginCenterView={revision:5,installation:{supported:true,runtime:'worker',restartRequired:false},packages:[structuredClone(notionPackage),structuredClone(readerPackage),structuredClone(brokenPackage)],instances:[structuredClone(notionInstance),structuredClone(readerInstance)],builds:[],catalog:[],sourceContributions:[structuredClone(notionContribution)]};
 return {plugins,builds:[structuredClone(gmailBuild)],config:configuration(pinnedPages),routines:{items:[structuredClone(routine)],nextCursor:null},sources:{items:[structuredClone(notionSource),structuredClone(fileSource)]}};
}

function generatedApi(initial=state()){
 const reads=new Map<string,number>(),writes:{path:string;method:string;body:any}[]=[];
 const api={request:async(path:string,init?:RequestInit)=>{
  const method=init?.method??'GET';
  if(method==='GET'||!method){
   reads.set(path,(reads.get(path)??0)+1);
   if(path==='/api/plugins')return structuredClone(initial.plugins);
   if(path==='/api/plugin-builds')return structuredClone(initial.builds);
   if(path==='/api/configuration')return structuredClone(initial.config);
   if(path===routinesPath)return structuredClone(initial.routines);
   if(path==='/api/sources')return structuredClone(initial.sources);
   if(path==='/api/library/browse?limit=1')return {sources:[],sourcesTruncated:true};
   if(path==='/api/connectors/status')return {};
   if(path==='/api/features')return {schemaVersion:1,revision:1,features:[],capabilities:[]};
   if(path.startsWith('/api/operations/changes'))return {ids:[],cursor:0,hasMore:false,reset:false};
   throw new Error('Unexpected fixture read '+path);
  }
  const body=init?.body?JSON.parse(String(init.body)):undefined;
  writes.push({path,method,body});
  if(path==='/api/configuration/ui'){
   assert.equal(body.revision,initial.config.revision);
   const next=body.value as {pinnedPages:string[]};
   initial.config={...initial.config,revision:initial.config.revision+1,domains:initial.config.domains.map(domain=>domain.id==='ui'?{...domain,saved:next,effective:next}:domain)};
   return structuredClone(initial.config);
  }
  if(path.startsWith('/api/plugin-instances/')&&(path.endsWith('/disable')||path.endsWith('/enable'))){
   const instance=initial.plugins.instances.find(value=>path.includes(encodeURIComponent(value.id)))!;
   assert.equal(body.expectedRevision,instance.revision);assert.equal(typeof body.operationId,'string');
   instance.revision++;instance.desired=path.endsWith('/enable');instance.observed=instance.desired?'ready':'disabled';instance.allowedActions=[instance.desired?'configure':'configure','check',instance.desired?'disable':'enable'];
   initial.plugins.revision++;
   return structuredClone(instance);
  }
  if(path.startsWith('/api/plugin-builds/')){
   const build=initial.builds.find(value=>path.endsWith(encodeURIComponent(value.id)))!;
   assert.equal(body.expectedRevision,build.revision);
   build.revision++;build.desired=body.selection;build.observed=body.selection?'active':'stopped';
   return structuredClone(build);
  }
  if(path.startsWith('/api/assistant/routines/')){
   const rule=initial.routines.items.find(value=>path.endsWith(encodeURIComponent(value.id)))!;
   assert.equal(body.expectedRevision,rule.revision);
   assert.equal(Object.keys(body).sort().join(','),'enabled,expectedRevision','routine updates use the existing command envelope only');
   rule.revision++;rule.enabled=body.enabled;rule.nextDue=rule.enabled?'2026-11-27T09:00:00.000Z':null;
   return structuredClone(rule);
  }
  throw new Error('Unexpected fixture write '+path);
 }} as Api;
 return {api,initial,reads,writes,count:(path:string)=>reads.get(path)??0};
}

async function mount(t:import('node:test').TestContext,api:Api){
 const element=document.createElement('div');document.body.appendChild(element);const root=createRoot(element);
 t.after(async()=>{await act(async()=>root.unmount());element.remove();});
 await act(async()=>{root.render(React.createElement(SkillsPage,{api,pages}));await tick();});
 return {element,root};
}
function row(element:Element,id:string){const found=element.querySelector<HTMLElement>(`[data-skill-id="${id}"]`);assert.ok(found,'row '+id);return found;}
function control(element:Element,text:string){const found=[...element.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.includes(text));assert.ok(found,'control '+text);return found;}

test('SK1-01 disabling a connector hides only its own sources across the real Skills and Connections pages',async t=>{
 const fixture=generatedApi(),{element,root}=await mount(t,fixture.api);
 const notion=row(element,'package:'+notionPackage.id);
 assert.match(notion.textContent!,/连接器/);
 const toggle=notion.querySelector<HTMLButtonElement>('[role=switch]')!;assert.equal(toggle.getAttribute('aria-checked'),'true');
 await act(async()=>{toggle.click();await tick();await tick();});
 const write=fixture.writes.find(value=>value.path.includes(notionInstance.id));
 assert.ok(write);assert.equal(write.path,'/api/plugin-instances/'+encodeURIComponent(notionInstance.id)+'/disable');assert.equal(write.method,'POST');
 assert.equal(fixture.initial.plugins.instances.find(value=>value.id===notionInstance.id)!.desired,false);
 assert.equal(row(element,'package:'+notionPackage.id).querySelector('[role=switch]')!.getAttribute('aria-checked'),'false');
 assert.equal(fixture.writes.some(value=>value.path==='/api/configuration/ui'),false,'disabling a plugin never changes pins');
 assert.equal(row(element,'build:bundled:gmail').getAttribute('data-skill-state'),'enabled','the sibling build stays enabled');
 assert.equal(fixture.initial.plugins.sourceContributions?.length,1,'the package keeps its connector declaration; the instance carries the disabled state');
 assert.equal(fixture.initial.sources.items.filter(source=>source.kind===notionContribution.kinds[0]).length,1,'the source record itself remains for archived evidence');
 await act(async()=>{root.render(React.createElement(Sources,{api:fixture.api,onOpen:()=>{},onImport:()=>{}}));await tick();await tick();});
 const rows=()=>[...element.querySelectorAll<HTMLElement>('.source-final-row')];
 await waitFor(()=>rows().length===1,'Connections renders only the unrelated source');
 assert.equal(rows().filter(row=>/Notion/.test(row.textContent??'')).length,0,'a stopped connector no longer lists its connected source');
 assert.equal(rows().filter(row=>/Generated files/.test(row.textContent??'')).length,1,'other sources stay listed');
 const reads=fixture.count('/api/sources');
 await act(async()=>{[...element.querySelectorAll<HTMLButtonElement>('.source-heading-actions button')].find(button=>button.textContent?.includes('刷新'))!.click();await tick();await tick();});
 await waitFor(()=>fixture.count('/api/sources')>reads,'Refresh rereads the source directory');
 assert.equal(rows().filter(row=>/Notion/.test(row.textContent??'')).length,0,'Refresh does not resurrect the stopped connector');
 assert.equal(fixture.writes.some(value=>value.path==='/api/configuration/ui'),false,'the cross-page path never changes pins');
});

test('SK1-02 pinning appends one daily sidebar item and unpinning removes it without changing the plugin',async t=>{
 const fixture=generatedApi(),{element}=await mount(t,fixture.api);
 const page=element.querySelector<HTMLElement>(`[data-page-id="${readingPageId}"]`)!;
 assert.equal(page.getAttribute('data-pinned'),'false');
 assert.equal(page.querySelector('[role=switch]')!.getAttribute('aria-checked'),'false');
 assert.match(page.textContent!,/固定到侧栏/);
 await act(async()=>{page.querySelector<HTMLButtonElement>('[role=switch]')!.click();await tick();await tick();});
 const pin=fixture.writes.find(value=>value.path==='/api/configuration/ui')!;
 assert.deepEqual(pin.body,{revision:3,value:{pinnedPages:[readingPageId]}});
 assert.equal(element.querySelector(`[data-page-id="${readingPageId}"]`)!.getAttribute('data-pinned'),'true');
 assert.equal(element.querySelector(`[data-page-id="${readingPageId}"] [role=switch]`)!.getAttribute('aria-checked'),'true');
 const enabled=new Set([readerPackage.id]),pinned=pinnedNavPages([readingPageId],pages,enabled);
 const {daily}=navigationFor({enabledPackages:enabled,registered:new Set(),pinned});
 assert.equal((daily.at(-1) as {pageId:string}).pageId,readingPageId);
 const merged=withPinnedPages([{id:'chat',label:'Generated chat',group:'daily',order:10,icon:'message-circle',packageId:'mote.ask',page:'ask'}],pinned);
 assert.equal((merged.at(-1) as {page:string}).page,readingPageId);
 await act(async()=>{element.querySelector<HTMLElement>(`[data-page-id="${readingPageId}"]`)!.querySelector<HTMLButtonElement>('[role=switch]')!.click();await tick();await tick();});
 assert.deepEqual(fixture.writes.filter(value=>value.path==='/api/configuration/ui').at(-1)!.body,{revision:4,value:{pinnedPages:[]}});
 assert.equal(element.querySelector(`[data-page-id="${readingPageId}"]`)!.getAttribute('data-pinned'),'false');
 const after=navigationFor({enabledPackages:enabled,registered:new Set(),pinned:pinnedNavPages([],pages,enabled)});
 assert.equal(after.daily.some(item=>'pageId' in item),false);
 assert.equal(fixture.writes.some(value=>value.path.includes('/api/plugin-instances/')),false,'pinning never enables or disables a plugin');
});

test('SK1-03 a routine switch sends the existing command and follows the returned state',async t=>{
 const fixture=generatedApi(),{element}=await mount(t,fixture.api);
 const article=element.querySelector<HTMLElement>(`[data-routine-id="${routine.id}"]`)!;
 const toggle=article.querySelector<HTMLButtonElement>('[role=switch]')!;
 assert.equal(toggle.getAttribute('aria-checked'),'true');
 await act(async()=>{toggle.click();await tick();await tick();});
 const write=fixture.writes.find(value=>value.path==='/api/assistant/routines/'+routine.id)!;
 assert.deepEqual(write.body,{expectedRevision:1,enabled:false});
 assert.equal(element.querySelector<HTMLElement>(`[data-routine-id="${routine.id}"]`)!.getAttribute('data-routine-state'),'disabled');
 assert.equal(element.querySelector<HTMLElement>(`[data-routine-id="${routine.id}"]`)!.querySelector('[role=switch]')!.getAttribute('aria-checked'),'false');
 assert.equal(fixture.writes.some(value=>value.path==='/api/configuration/ui'),false);
});

test('SK1-04 a failed plugin row keeps the failure and retries the load',async t=>{
 const fixture=generatedApi(),{element}=await mount(t,fixture.api);
 const broken=row(element,'package:'+brokenPackage.id);
 assert.match(broken.textContent!,/加载失败/);
 const before=fixture.count('/api/plugins');
 fixture.initial.plugins.packages=fixture.initial.plugins.packages.filter(value=>value.id!==brokenPackage.id);
 await act(async()=>{control(broken,'重试').click();await tick();await tick();});
 assert.ok(fixture.count('/api/plugins')>before,'retry reads the plugin inventory again');
 assert.equal(element.querySelector(`[data-skill-id="package:${brokenPackage.id}"]`),null);
});

test('SK1-06 routines show the next due time and a compact saved scope',async t=>{
 const fixture=generatedApi();fixture.initial.routines.items.push({...structuredClone(routine),id:'22222222-2222-4222-8222-222222222222',goal:'Generated selected-source review',scope:{kind:'selection',sourceIds:['generated-source']},nextDue:null,enabled:false});
 const {element}=await mount(t,fixture.api);
 const first=element.querySelector<HTMLElement>(`[data-routine-id="${routine.id}"]`)!;
 assert.equal(first.getAttribute('data-next-run'),routine.nextDue);
 assert.equal(first.getAttribute('data-scope-kind'),'all');
 assert.match(first.textContent!,/全部来源/);
 assert.ok(first.querySelector('small')!.textContent!.includes('2026'),'next due is formatted from the rule time zone');
 assert.equal(routineScopeSummary({kind:'selection',sourceIds:['generated-source']}),'来源 · 1');
 const second=element.querySelector<HTMLElement>('[data-routine-id="22222222-2222-4222-8222-222222222222"]')!;
 assert.equal(second.getAttribute('data-next-run'),'');
 assert.match(second.textContent!,/来源 · 1/);
});

test('SK1-07 a pinned page from an uninstalled package renders nothing and reports no error',async t=>{
 const fixture=generatedApi(state(['generated-uninstalled-page'])),{element}=await mount(t,fixture.api);
 assert.equal(element.querySelector('[data-page-id="generated-uninstalled-page"]'),null);
 assert.equal(element.querySelector('[role=alert]'),null);
 assert.deepEqual(pinnedNavPages(['generated-uninstalled-page'],pages,new Set([readerPackage.id])),[]);
 const enabled=new Set([readerPackage.id]),{daily}=navigationFor({enabledPackages:enabled,registered:new Set(),pinned:pinnedNavPages(['generated-uninstalled-page'],pages,enabled)});
 assert.equal(daily.some(item=>'pageId' in item),false);
});

test('SK1-08 a configuration without the ui domain starts empty and the page remains usable',async t=>{
 const fixture=generatedApi();
 fixture.initial.config={...fixture.initial.config,domains:[],revision:1};
 const {element}=await mount(t,fixture.api);
 assert.equal(element.querySelector('[role=alert]'),null);
 assert.equal(element.querySelector(`[data-page-id="${readingPageId}"]`)!.getAttribute('data-pinned'),'false');
 assert.match(element.textContent!,/Generated reading list/);
});

test('the add control opens the official catalog deep link',async t=>{
 const fixture=generatedApi(),{element}=await mount(t,fixture.api);
 await act(async()=>{element.querySelector<HTMLButtonElement>('.page-heading button')!.click();await tick();});
 assert.equal(dom.window.location.hash,'#/system/plugins?tab=discover');
});

test('the search field filters installed skills deterministically without semantic dispatch',async t=>{
 const fixture=generatedApi(),{element}=await mount(t,fixture.api);
 const input=element.querySelector<HTMLInputElement>('.skills-search input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'notion');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();});
 assert.equal(element.querySelectorAll('.skills-list .skills-row').length,1,'only the literal name match survives the filter');
 assert.match(element.textContent!,/Notion/);
 assert.doesNotMatch(element.textContent!,/Generated reading list/);
});
