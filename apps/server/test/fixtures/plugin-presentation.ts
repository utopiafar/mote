import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {zipSync,strToU8} from 'fflate';
import {buildApp} from '../../src/app.js';
import {sha256} from '../../src/store.js';
import type {Config} from '../../src/config.js';
import type {PluginManifest,PluginReleaseTransport} from '../../src/plugin-release.js';
import type {Api} from '../../../web/src/api';

export type PresentationRelease={manifest:PluginManifest;archive:Uint8Array};
export const presentationRepository=fileURLToPath(new URL('../../../../',import.meta.url));
export const presentationCommand=(expectedRevision:number)=>({expectedRevision,operationId:randomUUID()});
export async function presentationUntil(check:()=>boolean|Promise<boolean>,label:string){
  const deadline=Date.now()+10000;
  while(!await check()){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,5));}
}
export function presentationRelease(manifest:PluginManifest,files:Record<string,string|Uint8Array>={}):PresentationRelease{
  const archive=zipSync(Object.fromEntries(Object.entries({'plugin.mjs':'throw Error("Presentation data must not execute the service entry")',...files}).map(([path,value])=>[path,typeof value==='string'?strToU8(value):value])));
  return {manifest:{...manifest,archive:{...manifest.archive,sha256:sha256(archive)}},archive};
}
export function presentationManifest(id:string):PluginManifest{return {
  schemaVersion:1,id,name:'Generated '+id,version:'1.0.0',runtime:'service',entry:'plugin.mjs',archive:{asset:'presentation.zip',sha256:'0'.repeat(64)},
  contributions:[{id:id+'.page',version:'1',surface:'page',runtime:'host',entry:'page.html',capabilities:['generated.page']}],capabilities:['generated.page'],configuration:[],dependencies:[],access:[],
};}
export async function presentationDomainRelease(manifest:PluginManifest,body:string,files:Record<string,string>={}){
  const contributions=manifest.contributions!.filter(value=>value.surface==='data'),capabilities=manifest.capabilities.filter(id=>contributions.some(value=>value.capabilities?.includes(id)));
  const source=`import {serviceContract} from '@mote/plugin-sdk';import {readFile,writeFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';export const manifest=${JSON.stringify({apiVersion:1,id:manifest.id,version:manifest.version,contributions,capabilities,required:manifest.dependencies,optional:[]})};export function createPlugin(context){${body}}`;
  const bundled=await build({stdin:{contents:source,resolveDir:presentationRepository},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
  return presentationRelease(manifest,{'plugin.mjs':bundled.outputFiles[0]!.contents,...files});
}

/** Real Central/owner routes with a generated fixed-release transport. The
 * caller owns close(); every restart reuses only this temporary profile. */
export async function pluginPresentationFixture(webRoot?:string){
  const directory=await mkdtemp(join(tmpdir(),'mote-presentation-')),releases=new Map<string,PresentationRelease>();
  const config:Config={dataDir:join(directory,'central'),token:'generated-presentation-owner',tokenPath:'generated',host:'127.0.0.1',port:0,maxExportBytes:1e6,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  const transport:PluginReleaseTransport=async url=>{
    const item=[...releases.values()].find(value=>url.includes('/generated/'+value.manifest.id+'/'));assert.ok(item,'fixture accepts generated release URLs only');
    const base='https://github.com/generated/'+item.manifest.id+'/releases/download/v1/';
    if(url.endsWith('/releases/tags/v1'))return {bytes:strToU8(JSON.stringify({tag_name:'v1',draft:false,assets:['mote-plugin.json',item.manifest.archive.asset].map(name=>({name,browser_download_url:base+name}))}))};
    if(url.endsWith('/commits/v1'))return {bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
    if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(item.manifest))};
    if(url===base+item.manifest.archive.asset)return {bytes:item.archive};throw Error('Unexpected generated release URL');
  };
  const start=async()=>{
    const runtime=await buildApp(config,{...(webRoot?{webRoot}:{}),backgroundWorker:false,agent:{configured:false,async close(){},async query(){throw Error('No model calls in presentation fixture');}}});
    Object.defineProperty(runtime.pluginCenter.releases,'transport',{value:transport});return runtime;
  };
  let node=await start();
  const response=(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown,token=config.token)=>node.app.inject({method,url,headers:token?{authorization:'Bearer '+token}:{},...(payload===undefined?{}:{payload:payload as object})});
  const request=async(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown)=>{const reply=await response(method,url,payload);assert.ok(reply.statusCode<400,reply.body);return reply.json();};
  const install=async(item:PresentationRelease)=>{
    releases.set(item.manifest.id,item);
    const preview=await request('POST','/api/plugins/resolve',{repository:'generated/'+item.manifest.id,tag:'v1'}),id=item.manifest.id+'@'+preview.source.digest;
    await request('POST','/api/plugins/install',{...presentationCommand(node.pluginCenter.revision()),previewId:preview.id});
    await presentationUntil(()=>node.pluginCenter.view().packages.some(value=>value.id===id&&value.state==='installed'),'formal presentation artifact installs');
    assert.equal(sha256(await readFile(join(config.dataDir,'plugins/packages',preview.source.digest,'mote-source.zip'))),preview.source.digest);return id;
  };
  const configure=(packageId:string,id=randomUUID())=>request('POST','/api/plugin-instances',{...presentationCommand(node.pluginCenter.revision()),operationId:id,packageId,name:'Generated instance '+id.slice(0,8),scope:'default',configuration:{}});
  const action=(id:string,kind:'check'|'enable'|'disable')=>request('POST','/api/plugin-instances/'+id+'/'+kind,presentationCommand(node.pluginCenter.instanceView(id).revision));
  const settle=async(id:string)=>{await presentationUntil(()=>node.pluginCenter.instanceView(id).observed!=='checking','presentation operation settles');return node.pluginCenter.instanceView(id);};
  const api={async request<T>(path:string,init:RequestInit={}){return await request((init.method??'GET') as 'GET'|'POST'|'PATCH',path,init.body?JSON.parse(String(init.body)):undefined) as T;},async raw(path:string,init:RequestInit={}){const reply=await response((init.method??'GET') as 'GET'|'POST'|'PATCH',path,init.body?JSON.parse(String(init.body)):undefined);return new Response(reply.body,{status:reply.statusCode});}} satisfies Api;
  return {directory,config,request,response,install,configure,action,api,get node(){return node;},
    async check(id:string){await action(id,'check');return settle(id);},async enable(id:string){await action(id,'enable');return settle(id);},
    async restart(){await node.app.close();node=await start();},async close(){await node.app.close();await rm(directory,{recursive:true,force:true});}};
}

export async function packedPresentationTemplate(directory:string){
  const output=join(directory,'complete-template');
  await promisify(execFile)(process.execPath,[join(presentationRepository,'examples/domain-plugin/scripts/pack.mjs'),'--mote',presentationRepository,'--out',output],{timeout:120000});
  const manifest=JSON.parse(await readFile(join(output,'mote-plugin.json'),'utf8')) as PluginManifest;
  return {manifest,archive:await readFile(join(output,manifest.archive.asset))};
}
