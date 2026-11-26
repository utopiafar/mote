import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {UiPresentationHost,desktopUiLayout,linearUiTheme,type PluginPresentationInventory} from '@mote/shared';
import {WebFeatureHost} from '../../web/src/features/host';
import {InstalledWebPlugins} from '../../web/src/plugin-host/installed-plugins';
import {CustomPageBridge} from '../../web/src/plugin-host/custom-page-bridge';
import {PresentationSurface,WorkspaceShell,type WebShellRenderer} from '../../web/src/presentation';
import {pluginPresentationFixture,packedPresentationTemplate,presentationCommand,presentationDomainRelease,presentationManifest,presentationRelease,presentationUntil} from './fixtures/plugin-presentation.js';

test('the full packaged domain template installs, checks, opens its declared page bridge and restores a fresh activation',async t=>{
  const f=await pluginPresentationFixture();t.after(()=>f.close());
  const item=await packedPresentationTemplate(f.directory),pkg=await f.install(item),instance=await f.configure(pkg);
  assert.ok(item.manifest.contributions?.some(value=>value.surface==='page'&&value.bridge?.methods.join(',')==='state,add'));
  assert.equal((await f.response('GET','/api/plugins/presentation',undefined,'')).statusCode,401);
  assert.equal((await f.check(instance.id)).observed,'ready');assert.deepEqual((await f.request('GET','/api/plugins/presentation')).instances,[]);
  assert.equal((await f.enable(instance.id)).observed,'ready');
  const inventory=await f.request('GET','/api/plugins/presentation') as PluginPresentationInventory,installed=inventory.instances[0]!;
  assert.equal(installed.packageId,item.manifest.id);assert.equal(installed.instanceId,instance.id);assert.equal(installed.releaseDigest,item.manifest.archive.sha256);
  const page=installed.pages[0]!,document=await f.response('GET',page.entryUrl,undefined,'');assert.equal(document.statusCode,200);
  assert.match(document.headers['content-security-policy'] as string,/sandbox allow-scripts/);assert.match(document.headers['content-security-policy'] as string,/default-src 'none'/);assert.match(document.body,/Template collection/);assert.ok(!document.body.includes(f.config.privateCredential!.token));
  const invoke=(method:string,payload?:unknown,activationId=installed.activationId)=>f.response('POST',`/api/plugin-instances/${instance.id}/pages/${page.id}/invoke`,{activationId,method,...(payload===undefined?{}:{payload})});
  assert.equal((await invoke('summary')).statusCode,403,'a real but undeclared method stays inaccessible');
  assert.equal((await invoke('add',{text:'Generated installed page item'})).statusCode,200);
  assert.equal((await invoke('state')).json().items[0].text,'Generated installed page item');
  const identity=f.node.pluginCenter.instanceIdentity(instance.id);await f.restart();
  const restored=(await f.request('GET','/api/plugins/presentation')).instances[0];assert.deepEqual(f.node.pluginCenter.instanceIdentity(instance.id),identity);assert.notEqual(restored.activationId,installed.activationId);
  assert.equal((await invoke('state')).statusCode,409,'the previous document cannot call into a restarted instance');assert.equal((await f.response('GET',page.entryUrl)).statusCode,409);
  assert.equal((await invoke('state',undefined,restored.activationId)).json().items[0].text,'Generated installed page item');
  await f.action(instance.id,'disable');assert.deepEqual((await f.request('GET','/api/plugins/presentation')).instances,[]);assert.equal((await invoke('state',undefined,restored.activationId)).statusCode,409);
  await f.request('POST','/api/plugins/'+encodeURIComponent(pkg)+'/uninstall',presentationCommand(f.node.pluginCenter.revision()));assert.deepEqual((await f.request('GET','/api/plugins/presentation')).instances,[]);
});

test('complete template instances bind local page dependencies to their own live ports while external providers stay ambiguous',async t=>{
  const f=await pluginPresentationFixture();t.after(()=>f.close());
  const pkg=await f.install(await packedPresentationTemplate(f.directory)),one=await f.configure(pkg),two=await f.configure(pkg);
  for(const instance of [one,two]){
    assert.equal((await f.check(instance.id)).observed,'ready');
    assert.equal((await f.enable(instance.id)).observed,'ready','a sibling instance cannot make an explicit local contribution ambiguous');
  }
  const inventory=await f.request('GET','/api/plugins/presentation') as PluginPresentationInventory;
  assert.equal(inventory.instances.length,2);
  const a=inventory.instances.find(value=>value.instanceId===one.id)!,b=inventory.instances.find(value=>value.instanceId===two.id)!;
  const invoke=(instance:typeof a,method:string,payload?:unknown)=>f.request('POST',`/api/plugin-instances/${instance.instanceId}/pages/${instance.pages[0]!.id}/invoke`,{activationId:instance.activationId,method,...(payload===undefined?{}:{payload})});
  await invoke(a,'add',{text:'Generated instance A only'});
  assert.equal((await invoke(b,'state')).items.length,0,'the sibling page cannot read the first instance state');
  await invoke(b,'add',{text:'Generated instance B only'});
  assert.deepEqual((await invoke(a,'state')).items.map((item:{text:string})=>item.text),['Generated instance A only']);
  assert.deepEqual((await invoke(b,'state')).items.map((item:{text:string})=>item.text),['Generated instance B only']);
  for(const dependency of [{kind:'contribution' as const,id:'template-collection.port',version:'1'},{kind:'service' as const,id:'template.collection.log',version:'1'}]){
    const base=presentationManifest('generated.ambiguous.'+dependency.kind),manifest={...base,contributions:base.contributions!.map(value=>({...value,requires:[dependency]}))};
    const external=await f.configure(await f.install(presentationRelease(manifest,{'page.html':'<h1>Generated external dependency</h1>'}))),checked=await f.check(external.id);
    assert.equal(checked.observed,'blocked','a genuinely external reference cannot choose one of two matching providers');
    assert.match(checked.issues.join(','),/Ambiguous domain dependency/);assert.ok(!checked.allowedActions.includes('enable'));
  }
  await f.restart();
  const restored=(await f.request('GET','/api/plugins/presentation') as PluginPresentationInventory).instances;
  assert.equal(restored.length,2);
  for(const prior of [a,b]){
    const current=restored.find(value=>value.instanceId===prior.instanceId)!;
    assert.equal(f.node.pluginCenter.instanceView(current.instanceId).observed,'ready');assert.notEqual(current.activationId,prior.activationId);
    assert.equal((await f.response('POST',`/api/plugin-instances/${prior.instanceId}/pages/${prior.pages[0]!.id}/invoke`,{activationId:prior.activationId,method:'state'})).statusCode,409);
    assert.deepEqual((await invoke(current,'state')).items.map((item:{text:string})=>item.text),[prior.instanceId===one.id?'Generated instance A only':'Generated instance B only']);
  }
  await f.action(one.id,'disable');
  assert.equal(f.node.pluginCenter.instanceView(two.id).observed,'ready');
  const remaining=(await f.request('GET','/api/plugins/presentation') as PluginPresentationInventory).instances;
  assert.deepEqual(remaining.map(value=>value.instanceId),[two.id]);
  assert.deepEqual((await invoke(remaining[0]!,'state')).items.map((item:{text:string})=>item.text),['Generated instance B only']);
});

test('owner inventory drives actual Web registry, scoped themes/layouts, navigation rendering and removal fallback',async t=>{
  const f=await pluginPresentationFixture();t.after(()=>f.close());
  const base=presentationManifest('generated.presentation'),theme={...linearUiTheme,id:'generated.studio',schemes:undefined,tokens:{...linearUiTheme.tokens,accent:'#aabbcc'}},layout={...desktopUiLayout,id:'generated.workspace',detail:'stack' as const};
  const manifest={...base,contributions:[...base.contributions!,{id:'generated.theme',version:'1',surface:'theme' as const,runtime:'host' as const,entry:'theme.json',capabilities:['generated.theme']},{id:'generated.layout',version:'1',surface:'layout' as const,runtime:'host' as const,entry:'layout.json',capabilities:['generated.layout']}],capabilities:[...base.capabilities,'generated.theme','generated.layout']};
  const pkg=await f.install(presentationRelease(manifest,{'page.html':'<h1>Generated installed page</h1>','theme.json':JSON.stringify(theme),'layout.json':JSON.stringify(layout)})),one=await f.configure(pkg),two=await f.configure(pkg);
  for(const instance of [one,two]){assert.equal((await f.check(instance.id)).observed,'ready');assert.equal((await f.enable(instance.id)).observed,'ready');}
  const host=new WebFeatureHost(),presentation=new UiPresentationHost<WebShellRenderer>({theme:linearUiTheme,layout:{...desktopUiLayout,implementation:WorkspaceShell}}),consumer=new InstalledWebPlugins(host,presentation);
  t.after(async()=>{await consumer.close();await host.close();});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'}),previous=new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true});}
  dom.window.scrollTo=()=>{};
  const {createRoot}=await import('react-dom/client'),root=createRoot(document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}dom.window.close();});
  const inventory=await f.request('GET','/api/plugins/presentation');await consumer.reconcile(inventory,f.api);
  assert.equal(host.pages().length,2,'two instances never overwrite a page route');
  const route=host.page(one.id+'/'+base.contributions![0]!.id)!;assert.ok(route.route?.includes(encodeURIComponent(one.id)));
  await act(async()=>root.render(React.createElement(PresentationSurface,{host:presentation,navigation:()=>React.createElement('nav',null,...['generated.nav.a','generated.nav.b'].map(value=>React.createElement('button',{key:value},value))),toolbar:null,footer:null},React.createElement('input',{defaultValue:'Generated unsaved draft'}),route.render({} as never))));
  const input=document.querySelector('input')!;input.focus();input.setSelectionRange(2,8);
  assert.equal(document.querySelector('iframe')?.getAttribute('sandbox'),'allow-scripts');assert.equal(document.querySelector('iframe')?.getAttribute('src'),inventory.instances.find((value:any)=>value.instanceId===one.id).pages[0].entryUrl);
  const choices=consumer.getSnapshot();await act(async()=>{consumer.select('theme',choices.theme.find(value=>value.key.startsWith(one.id))!.key);consumer.select('layout',choices.layout.find(value=>value.key.startsWith(one.id))!.key);});
  assert.equal(document.documentElement.style.getPropertyValue('--mote-accent'),'#aabbcc');assert.equal(document.querySelector('.app-shell')?.getAttribute('data-detail'),'stack');assert.deepEqual([...document.querySelectorAll('nav button')].map(value=>value.textContent),['generated.nav.a','generated.nav.b']);
  assert.equal(document.querySelector('input'),input);assert.equal(input.value,'Generated unsaved draft');assert.equal(document.activeElement,input);assert.equal(input.selectionStart,2);
  const oldScope=consumer.scopes.get(one.id)!;await f.action(one.id,'disable');await act(async()=>{await consumer.reconcile(await f.request('GET','/api/plugins/presentation'),f.api);});
  assert.equal(oldScope.lifetime.state,'disposed');assert.ok(oldScope.customPages?.mounts.values().next().value?.revoked);assert.equal(host.pages().length,1);assert.ok(host.page(two.id+'/'+base.contributions![0]!.id));assert.equal(presentation.getSnapshot().theme.id,linearUiTheme.id);assert.equal(presentation.getSnapshot().layout.id,desktopUiLayout.id);assert.equal(document.querySelector('input'),input);
  assert.deepEqual(consumer.getErrors(),[]);
});

test('unsupported declarations, missing exact dependencies and invalid theme/layout data never become ready',async t=>{
  const f=await pluginPresentationFixture();t.after(()=>f.close());
  const cases=[
    {name:'missing',change:{dependencies:[{kind:'service' as const,id:'generated.absent',version:'1'}]},files:{'page.html':'<h1>Generated missing dependency</h1>'}},
    {name:'version',change:{contributions:[{id:'generated.page',version:'2',surface:'page' as const,runtime:'host' as const,entry:'page.html',capabilities:['generated.page']}]},files:{'page.html':'<h1>Generated unsupported version</h1>'}},
    {name:'renderer',change:{contributions:[{id:'generated.renderer',version:'1',surface:'renderer' as const,runtime:'host' as const,entry:'page.html',capabilities:['generated.page']},{id:'generated.page',version:'1',surface:'page' as const,runtime:'host' as const,entry:'page.html'}]},files:{'page.html':'<h1>Generated renderer</h1>'}},
    {name:'theme',change:{contributions:[{id:'generated.theme',version:'1',surface:'theme' as const,runtime:'host' as const,entry:'theme.json',capabilities:['generated.page']}]},files:{'theme.json':JSON.stringify({...linearUiTheme,id:'generated.invalid',tokens:{...linearUiTheme.tokens,accent:'url(https://invalid.example/tracker)'}})}},
    {name:'layout',change:{contributions:[{id:'generated.layout',version:'1',surface:'layout' as const,runtime:'host' as const,entry:'layout.json',capabilities:['generated.page']}]},files:{'layout.json':JSON.stringify({...desktopUiLayout,id:'generated.invalid',implementation:'https://invalid.example/remote.js'})}},
  ];
  for(const item of cases){const manifest={...presentationManifest('generated.invalid.'+item.name),...item.change},instance=await f.configure(await f.install(presentationRelease(manifest,item.files as Record<string,string>)));const checked=await f.check(instance.id);assert.equal(checked.observed,'blocked',item.name);assert.ok(checked.issues.length,item.name);assert.ok(!checked.allowedActions.includes('enable'),item.name);}
  assert.deepEqual((await f.request('GET','/api/plugins/presentation')).instances,[]);
});

test('a layout package that still carries primary is rejected with the field while another plugin stays ready',async t=>{
  const f=await pluginPresentationFixture();t.after(()=>f.close());
  const manifest=presentationManifest('generated.primary-layout'),layoutContribution={id:'generated.layout',version:'1',surface:'layout' as const,runtime:'host' as const,entry:'layout.json',capabilities:['generated.page']};
  const invalidManifest={...manifest,contributions:[...manifest.contributions!,layoutContribution]};
  const invalid=await f.configure(await f.install(presentationRelease(invalidManifest,{'page.html':'<h1>Generated primary page</h1>','layout.json':JSON.stringify({id:'generated.primary',version:'1',detail:'stack',primary:['generated']})})));
  const blocked=await f.check(invalid.id);assert.equal(blocked.observed,'blocked');assert.match(blocked.issues.join(','),/primary/);assert.ok(!blocked.allowedActions.includes('enable'));
  const valid=await f.configure(await f.install(presentationRelease(presentationManifest('generated.valid-layout'),{'page.html':'<h1>Generated valid page</h1>'})));
  assert.equal((await f.check(valid.id)).observed,'ready');assert.equal((await f.enable(valid.id)).observed,'ready');
  const inventory=await f.request('GET','/api/plugins/presentation') as PluginPresentationInventory;
  assert.deepEqual(inventory.instances.map(value=>value.instanceId),[valid.id]);
});

test('required live dependencies restore before pages and their withdrawal revokes the display scope',async t=>{
  const f=await pluginPresentationFixture();t.after(()=>f.close());
  const template=await packedPresentationTemplate(f.directory),provider=await f.configure(await f.install(template),'ffffffff-ffff-4fff-8fff-ffffffffffff');
  const base=presentationManifest('generated.dependent'),manifest={...base,contributions:base.contributions!.map(value=>({...value,requires:[{kind:'service' as const,id:'template.collection.log',version:'1'}]}))};
  const instance=await f.configure(await f.install(presentationRelease(manifest,{'page.html':'<h1>Generated dependent</h1>'})),'00000000-0000-4000-8000-000000000001');
  assert.equal((await f.check(instance.id)).observed,'blocked');await f.check(provider.id);assert.equal((await f.check(instance.id)).observed,'blocked','a checked disabled provider is not a live dependency');
  await f.enable(provider.id);assert.equal((await f.check(instance.id)).observed,'ready');await f.enable(instance.id);await f.restart();assert.equal(f.node.pluginCenter.instanceView(instance.id).observed,'ready');
  const before=(await f.request('GET','/api/plugins/presentation')).instances.find((value:any)=>value.instanceId===instance.id);assert.ok(before);
  await f.action(provider.id,'disable');await presentationUntil(()=>f.node.pluginCenter.instanceView(instance.id).observed==='blocked','dependent presentation reports actual withdrawal');assert.ok(!(await f.request('GET','/api/plugins/presentation')).instances.some((value:any)=>value.instanceId===instance.id));assert.equal((await f.response('GET',before.pages[0].entryUrl)).statusCode,409);
});

test('closing a page suppresses late replies while separately admitted server work completes',async t=>{
  const f=await pluginPresentationFixture();t.after(()=>f.close());
  const gate=join(f.directory,'gate.json');await writeFile(gate,'false');
  const base=presentationManifest('generated.durable'),data={id:'generated.durable.port',version:'1',surface:'data' as const,runtime:'service' as const,entry:'plugin.mjs',provides:[{kind:'service' as const,id:'generated.durable.work',apiVersion:'1',cardinality:'single' as const}]};
  const manifest={...base,contributions:[data,...base.contributions!.map(value=>({...value,requires:[{kind:'contribution' as const,id:data.id,version:'1'}],bridge:{contributionId:data.id,service:{id:'generated.durable.work',apiVersion:'1'},methods:['start','state']}}))]};
  const body=`let result=null;return {prepare(){},start(){context.provide('${data.id}',serviceContract('generated.durable.work','1'),Object.freeze({async start(){await writeFile(${JSON.stringify(gate+'.entered')},'entered');while(!JSON.parse(await readFile(${JSON.stringify(gate)},'utf8')))await delay(5);const prior=await context.state.get('result');result=await context.state.compareAndSet('result',prior?.revision??null,{completed:true});return result.value;},state(){return result?.value??null;}}));},quiesce(){},stop(){},dispose(){}};`;
  const instance=await f.configure(await f.install(await presentationDomainRelease(manifest,body,{'page.html':'<h1>Generated authorized work</h1>'})));assert.equal((await f.check(instance.id)).observed,'ready');await f.enable(instance.id);
  const installed=(await f.request('GET','/api/plugins/presentation')).instances[0],posted:unknown[]=[];
  const bridge=new CustomPageBridge({instanceId:instance.id,nonce:'generated-nonce',documentKey:'generated-document',generation:()=>1,visible:()=>true,documentAlive:()=>true,declared:installed.pages[0].methods,invoke:(method,payload)=>f.request('POST',`/api/plugin-instances/${instance.id}/pages/${installed.pages[0].id}/invoke`,{activationId:installed.activationId,method,payload}),post:reply=>posted.push(reply)});
  const pending=bridge.accept({data:{contractVersion:'1',instanceId:instance.id,nonce:'generated-nonce',documentKey:'generated-document',generation:1,requestId:'generated-start',kind:'request',method:'start',payload:{authorized:true}}});
  await presentationUntil(async()=>Boolean(await readFile(gate+'.entered').catch(()=>undefined)),'authorized server work entered');
  bridge.revoke();
  await writeFile(gate+'.next','true');
  await rename(gate+'.next',gate);
  assert.equal(await pending,true);
  assert.deepEqual(posted,[]);
  const result=await f.request('POST',`/api/plugin-instances/${instance.id}/pages/${installed.pages[0].id}/invoke`,{activationId:installed.activationId,method:'state'});assert.deepEqual(result,{completed:true});assert.equal(f.node.pluginCenter.instanceView(instance.id).desired,true,'page lifetime never revokes the background owner selection');
});
