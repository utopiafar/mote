import test from 'node:test';
import assert from 'node:assert/strict';
import {UiPresentationHost,desktopUiLayout,linearUiTheme,type PluginPresentationInventory} from '@mote/shared';
import {WebFeatureHost} from '../src/features/host';
import {WorkspaceShell,type WebShellRenderer} from '../src/presentation';
import {InstalledWebPlugins} from '../src/plugin-host/installed-plugins';
import {CustomPageBridge} from '../src/plugin-host/custom-page-bridge';
import type {Api} from '../src/api';

const id='00000000-0000-4000-8000-000000000001',activationId='00000000-0000-4000-8000-000000000002';
const inventory:PluginPresentationInventory={instances:[{packageId:'generated.page',packageVersion:'1.0.0',installationId:'generated-install',instanceId:id,activationId,releaseDigest:'a'.repeat(64),name:'Generated instance',pages:[{id:'generated.page',version:'1',title:'Generated page',entryUrl:`/plugin-pages/${id}/${activationId}/generated.page`,methods:['state']}],themes:[],layouts:[]}]};
const until=async(check:()=>boolean,label:string)=>{const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,1));}};
const fixture=()=>{const host=new WebFeatureHost(),presentation=new UiPresentationHost<WebShellRenderer>({theme:linearUiTheme,layout:{...desktopUiLayout,implementation:WorkspaceShell}});return {host,consumer:new InstalledWebPlugins(host,presentation)};};
function api(){
  const reads:{signal?:AbortSignal|null;resolve:(value:unknown)=>void}[]=[],calls:string[]=[];
  const value={request(path:string,init:RequestInit={}){if(init.method==='POST'){calls.push(path);return Promise.resolve({source:calls.length});}return new Promise(resolve=>reads.push({signal:init.signal,resolve}));},raw:async()=>new Response()} as Api;
  return {value,reads,calls};
}

test('owner/StrictMode rebinding revokes the old channel and remounts even when inventory identities are identical',async t=>{
  const {host,consumer}=fixture(),owner=api();t.after(async()=>{await consumer.close();await host.close();});
  const disconnect=consumer.connect(owner.value);owner.reads[0]!.resolve(inventory);await until(()=>host.pages().length===1,'first owner mounts');
  const old=consumer.scopes.get(id)!,posted:unknown[]=[];
  const bridge=new CustomPageBridge({instanceId:id,nonce:'generated',documentKey:'generated',generation:()=>1,visible:()=>true,documentAlive:()=>true,declared:['state'],invoke:old.instance.customPages![0]!.invoke!,post:value=>posted.push(value)});old.customPages!.mounts.get('generated.page')!.attach(bridge);
  disconnect();consumer.connect(owner.value);assert.equal(await bridge.accept({data:{contractVersion:'1',instanceId:id,nonce:'generated',documentKey:'generated',generation:1,requestId:'old',kind:'request',method:'state'}}),false,'the old channel closes before async cleanup');
  owner.reads.at(-1)!.resolve(inventory);await until(()=>consumer.scopes.get(id)!==undefined&&consumer.scopes.get(id)!==old,'the same snapshot remounts under a fresh connection epoch');
  const current=consumer.scopes.get(id)!;assert.equal(old.lifetime.state,'disposed');assert.equal(current.customPages!.mounts.get('generated.page')!.revoked,false);assert.deepEqual(posted,[]);
  const next=api();consumer.connect(next.value);next.reads[0]!.resolve(inventory);await until(()=>consumer.scopes.get(id)!==undefined&&consumer.scopes.get(id)!==current,'the replacement owner mounts');await consumer.scopes.get(id)!.instance.customPages![0]!.invoke!('state',null);assert.equal(next.calls.length,1);assert.equal(owner.calls.length,0);
});

test('a late install receipt after shutdown releases its temporary registry and cannot mount a page',async t=>{
  const {host,consumer}=fixture(),owner=api(),original=host.install.bind(host);let entered=false,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  t.mock.method(host,'install',async(...args:Parameters<typeof host.install>)=>{entered=true;await gate;return original(...args);});
  const pending=consumer.reconcile(inventory,owner.value);await until(()=>entered,'mount is held before its receipt');const closed=consumer.close();release();await pending;await closed;assert.deepEqual(host.pages(),[]);assert.equal(consumer.scopes.size,0);await host.close();
});

test('a malformed replacement inventory withdraws the prior pages and keeps an explicit diagnostic',async()=>{
  const {host,consumer}=fixture(),owner=api();await consumer.reconcile(inventory,owner.value);assert.equal(host.pages().length,1);
  await consumer.reconcile({instances:null} as unknown as PluginPresentationInventory,owner.value);assert.equal(host.pages().length,0);assert.equal(consumer.getErrors().length,1);await consumer.close();await host.close();
});
