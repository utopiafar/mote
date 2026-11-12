import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {strToU8,zipSync} from 'fflate';
import {evidenceDependenciesSchema,pluginInstanceCommandSchema,sourceEvidenceRevisionSchema,type CaptureRecord} from '@mote/shared';
import {parseSemanticProducts} from '../../../apps/server/src/semantic-extraction.js';
import {Store,sha256} from '../../../apps/server/src/store.js';
import {ExecutionEngine} from '../../../apps/server/src/execution-engine.js';
import {PluginCenter} from '../../../apps/server/src/plugin-center.js';
import {GitHubPluginReleases,type PluginManifest,type PluginReleaseTransport} from '../../../apps/server/src/plugin-release.js';
import {instanceCommandActions,pluginInstanceDescriptor,pluginInstanceInvoker,pluginInstanceSpec} from '../../../apps/web/src/features/runtime.js';
import {DeclarativeViewSession} from '../../../apps/web/src/plugin-host/declarative-view.js';

const worker=`export async function createMemoryProvider(){return {async health(){return {providerId:'generated',version:'1',ready:true,verified:{},problems:[]};},async read(){return null;},async search(){return [];},async export(){return [];},async put(){return {state:'applied'};},async remove(){return {state:'removed'};},async close(){}};}`;
async function waitFor(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,'generated plugin state did not settle');await delay(5);}}

test('real plugin states expose exactly the executable declarative instance actions',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-assistant-contract-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const archive=zipSync({'provider.mjs':strToU8(worker)}),repository='generated-fixture/adapter',tag='v1.0.0';
  const manifest:PluginManifest={schemaVersion:1,id:'generated.assistant-contract',name:'Generated',version:'1.0.0',runtime:'worker',entry:'provider.mjs',archive:{asset:'adapter.zip',sha256:sha256(archive)},capabilities:['repository'],configuration:[{id:'label',label:'Label',type:'text',required:true}],dependencies:[],access:['Generated only']};
  const base=`https://github.com/${repository}/releases/download/${tag}/`;
  const transport:PluginReleaseTransport=async url=>{
    if(url.endsWith(`/releases/tags/${tag}`))return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'adapter.zip',browser_download_url:base+'adapter.zip'}]}))};
    if(url.endsWith(`/commits/${tag}`))return {bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
    if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
    if(url===base+'adapter.zip')return {bytes:archive};
    throw Error('Unexpected generated transport request');
  };
  const store=new Store(dir),executor=new ExecutionEngine(store,()=>Date.now());
  const plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(dir,'packages'),transport));
  plugins.probe=async()=>({capabilities:[{id:'repository',state:'verified'}],issues:[]});
  t.after(async()=>{await executor.close();await plugins.close();store.close();});
  const preview=await plugins.resolve({repository,tag});
  plugins.install({previewId:preview.id,operationId:randomUUID(),expectedRevision:plugins.revision()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed');
  const instance=plugins.configure(undefined,{packageId:plugins.view().packages[0]!.id,name:'Generated instance',scope:'default',configuration:{label:'one'},operationId:randomUUID(),expectedRevision:plugins.revision()});

  const exercise=async(action:typeof instanceCommandActions[number])=>{
    const emitted=plugins.instanceView(instance.id),descriptor=pluginInstanceDescriptor(emitted),spec=pluginInstanceSpec(emitted);
    const declared=descriptor.commands!.map(command=>pluginInstanceCommandSchema.parse(command).id);
    const displayed=spec.components.flatMap(component=>component.type==='action'?[component.command]:[]);
    assert.deepEqual(displayed,declared);
    assert.deepEqual(declared,instanceCommandActions.filter(value=>emitted.allowedActions.includes(value)));
    assert.ok(declared.includes(action));
    const calls:{path:string;revision:number}[]=[];
    const session=new DeclarativeViewSession(descriptor,spec,pluginInstanceInvoker(emitted,(path,revision)=>{
      calls.push({path,revision});
      const command=pluginInstanceCommandSchema.parse({id:path.split('/').at(-1),apiVersion:'1'});
      return plugins.action(instance.id,command.id,{operationId:randomUUID(),expectedRevision:revision});
    }));
    session.lifetime.show();
    assert.deepEqual(await session.command('uninstall'),{ok:false,reason:'undeclared'});
    assert.equal((await session.command(action)).ok,true);
    assert.deepEqual(calls,[{path:`/api/plugin-instances/${encodeURIComponent(instance.id)}/${action}`,revision:emitted.revision}]);
  };
  await exercise('check');
  await waitFor(()=>plugins.instanceView(instance.id).observed==='ready');
  await exercise('enable');
  await waitFor(()=>plugins.instanceView(instance.id).desired===true);
  await exercise('disable');
  await waitFor(()=>plugins.instanceView(instance.id).desired===false);
  assert.equal(pluginInstanceCommandSchema.safeParse({id:'unknown',apiVersion:'1'}).success,false);
  assert.equal(pluginInstanceCommandSchema.safeParse({id:'enable',apiVersion:'2'}).success,false);
  const disabled={...plugins.instanceView(instance.id),allowedActions:[]};
  assert.deepEqual(pluginInstanceDescriptor(disabled).commands,[]);
  assert.equal(pluginInstanceSpec(disabled).components.some(component=>component.type==='action'),false);
  const disabledSession=new DeclarativeViewSession(pluginInstanceDescriptor(disabled),pluginInstanceSpec(disabled),async()=>{throw Error('must not execute');});
  disabledSession.lifetime.show();
  assert.deepEqual(await disabledSession.command('enable'),{ok:false,reason:'undeclared'});
});

test('existing semantic consumer keeps unknown claims on original evidence; workRecords do not mint roots',()=>{
  const id=randomUUID(),text='Generated evidence with unknown author and date.';
  const record={id,ocrText:text} as CaptureRecord;
  const claim={statement:'Generated observation',actor:'unknown',status:'unknown',basis:'unknown',sourceTime:null,uncertainty:'Unknown',evidence:[{id,quote:text}]};
  const workRecord={title:'Generated',requirements:[claim],constraints:[],decisions:[],results:[],validation:[],openItems:[],artifactRefs:[]};
  const output={summary:'Generated summary',evidence:[{id,quote:text}],events:[],workRecords:[workRecord],memoryCandidates:[],actionCues:[]};
  const result=parseSemanticProducts(JSON.stringify(output),[record],[id],[{id,offset:0,length:text.length}]);
  assert.equal(result.workRecords![0].requirements[0].actor,'unknown');
  assert.equal(result.workRecords![0].requirements[0].sourceTime,null);
  assert.deepEqual(result.evidenceRanges,[{id,offset:0,length:text.length}]);
  assert.deepEqual(evidenceDependenciesSchema.parse({version:1,complete:true,ids:result.evidenceRanges.map(range=>range.id)}).ids,[id]);
  assert.equal(sourceEvidenceRevisionSchema.safeParse(workRecord).success,false);
  assert.equal(evidenceDependenciesSchema.safeParse({version:1,complete:true,ids:['artifact:work-record:1']}).success,false);
});
