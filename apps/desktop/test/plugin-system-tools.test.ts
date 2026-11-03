import {afterEach,expect,it,vi} from 'vitest';
import {appendFile,mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReleaseManifest} from '@mote/shared/release';
import {defaultConfig,publicConfig} from '../src/config';
import type {Status} from '../src/contracts';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import type {BuiltinPluginContext} from '../src/plugins/index';
import {
  createSystemToolsPlugin,systemToolsChannels,systemToolsManageCapability,systemToolsReadCapability,
  type SystemToolsOptions,type SystemToolsPlugin,
} from '../src/plugins/system-tools';
import type {UpdateDependencies} from '../src/updater';
import {digest,updateZip} from './update-fixtures';

vi.mock('electron',()=>({net:{request:vi.fn()},session:{fromPartition:vi.fn()}}));

const makeRouter=()=>{
  const handlers=new Map<string,(view:IpcCallerView,args:readonly unknown[])=>unknown>();
  const removed:string[]=[];
  const router:IpcRouter={
    handle:(channel,listener)=>{if(handlers.has(channel))throw new Error('duplicate');handlers.set(channel,listener);},
    removeHandler:channel=>{handlers.delete(channel);removed.push(channel);},
  };
  return {
    router,removed,
    invoke:(channel:string,view:IpcCallerView,args:readonly unknown[]=[])=>handlers.get(channel)?.(view,args) as Promise<IpcInvokeResult>|undefined,
    has:(channel:string)=>handlers.has(channel),
  };
};
const pageUrl='file:///generated/index.html';
const view=():IpcCallerView=>({senderId:7,frameIsMain:true,windowRole:'main',frameUrl:pageUrl});
const okValue=async(result:ReturnType<ReturnType<typeof makeRouter>['invoke']>)=>{
  expect(result).toBeDefined();
  const envelope=await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok?envelope.value:undefined;
};
const generatedStatus=():Status=>{
  const config=defaultConfig();config.token='private token';config.serverUrl='https://private-host.example';config.deviceName='private device';
  return {running:false,state:'paused',message:'private OCR',lastUploadError:'private note',queueDepth:2,queueBytes:90,encryptedTokenStorage:true,
    config:publicConfig(config),
    diagnostics:{enabled:true,sampleCount:1,fileBytes:22,error:'private error',counters:{saved:1,secret:'private counter'},latest:{rssBytes:100,message:'private latest',cpuUserMicros:Infinity}},
  } as unknown as Status;
};
const options=(directory:string,overrides:Partial<SystemToolsOptions>={}):SystemToolsOptions=>({
  directory,currentVersion:'0.5.0',arch:'arm64',
  profile:{name:'dev',defaultProfile:true,dataDirectory:directory,defaultServerUrl:'http://127.0.0.1:47842'},
  developmentBuild:false,devDownloadsUrl:'https://github.com/utopiafar/mote/releases',
  diagnosticsEnabled:()=>true,status:generatedStatus,
  chooseSupportPath:async()=>undefined,sampleDiagnostics:async()=>undefined,
  openExternal:async()=>undefined,reveal:()=>undefined,sendPending:async()=>undefined,
  showMessage:async()=>({response:0}),beforeInstall:async()=>undefined,quit:()=>undefined,
  ...overrides,
});
const register=async(plugin:SystemToolsPlugin,host:DesktopPluginHost)=>{
  await plugin.register({
    host,pageUrl,ipcMain:{} as never,appVersion:'generated',mainWindow:{} as never,
    mainSenderId:7,trustedMain:()=>undefined,
  } as BuiltinPluginContext);
};

let directories:string[]=[];
afterEach(async()=>{
  await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));
  vi.clearAllMocks();
});

it('exports a privacy bounded support bundle and never includes secrets or private body',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-system-tools-support-'));directories.push(directory);
  const target=join(directory,'support.json');
  const plugin=createSystemToolsPlugin(options(directory,{chooseSupportPath:async()=>target}));
  await plugin.events.record('UPLOAD','AUTH',{httpStatus:401});
  const forgedAt=Date.now()-1000;
  await appendFile(join(directory,'diagnostics','events.0.ndjson'),
    JSON.stringify({atMs:forgedAt,stage:'UPLOAD',code:'AUTH',message:'private forged body',token:'private secret'})+'\n');
  const fake=makeRouter(),host=new DesktopPluginHost({router:fake.router,native:new NativeProviderRegistry('mac')});
  host.registerWindow(7,'main',[systemToolsReadCapability,systemToolsManageCapability]);
  await register(plugin,host);
  try {
    expect(await okValue(fake.invoke(systemToolsChannels.supportExport,view(),[24]))).toEqual({canceled:false});
    const output=await readFile(target,'utf8');
    expect(output).not.toContain('private');
    expect(output).not.toContain('secret');
    const bundle=JSON.parse(output) as {app:{profile:string};state:{queueDepth:number};diagnostics:{counters:{saved:number}};events:unknown[]};
    expect(bundle).toMatchObject({app:{profile:'dev'},state:{queueDepth:2},diagnostics:{counters:{saved:1}}});
    expect(bundle.events).toContainEqual(expect.objectContaining({atMs:forgedAt,stage:'UPLOAD',code:'AUTH'}));
    expect((await stat(target)).mode&0o777).toBe(0o600);
  } finally { expect(host.stopScope('mote.system-tools')).toEqual([]); }
});

it('aborts an in-flight update download when the plugin is disabled',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-system-tools-update-'));directories.push(directory);
  const zip=updateZip([{name:'Mote.app/Contents/synthetic',text:'fixture'}]);
  const manifest:ReleaseManifest={schemaVersion:1,component:'desktop',version:'0.6.0',channel:'stable',repository:'utopiafar/mote',
    tag:'desktop-v0.6.0',notesUrl:'https://github.com/utopiafar/mote/releases/tag/desktop-v0.6.0',publishedAt:'2026-09-14T00:00:00Z',
    assets:[{component:'desktop',platform:'darwin',arch:'arm64',format:'zip',name:'fixture.zip',url:'https://github.com/utopiafar/mote/releases/download/desktop-v0.6.0/fixture.zip',size:zip.length,sha256:digest(zip),bundleId:'dev.mote.collector',signing:'adhoc'}],images:[]};
  let aborted=false,startedResolve:()=>void=()=>undefined;
  const started=new Promise<void>(resolve=>{startedResolve=resolve;});
  const dependencies:Partial<UpdateDependencies>={
    check:async()=>({manifest,available:true}),
    download:async(_asset,_path,download)=>new Promise((_resolve,reject)=>{
      const fail=()=>{aborted=true;reject(new Error('cancelled'));};
      if(download?.signal?.aborted){fail();return;}
      download?.signal?.addEventListener('abort',fail,{once:true});
      startedResolve();
    }),
    inspect:async()=>({valid:true,otherInstances:0,digest:'a'.repeat(64)}),
    extract:async(_archive,path)=>{await mkdir(join(path,'Mote.app'));},
  };
  const plugin=createSystemToolsPlugin(options(directory));
  await plugin.initialize({updatesDirectory:join(directory,'updates'),helperPath:'/generated/no-helper',updaterDependencies:dependencies});
  const fake=makeRouter(),host=new DesktopPluginHost({router:fake.router,native:new NativeProviderRegistry('mac')});
  host.registerWindow(7,'main',[systemToolsReadCapability,systemToolsManageCapability]);
  await register(plugin,host);
  expect((await okValue(fake.invoke(systemToolsChannels.updateCheck,view())) as {state:string}).state).toBe('available');
  expect((await okValue(fake.invoke(systemToolsChannels.updateDownload,view())) as {state:string}).state).toBe('downloading');
  await started;
  expect(host.stopScope('mote.system-tools')).toEqual([]);
  expect(aborted).toBe(true);
  await plugin.close();
  expect(plugin.updateStatus().state).toBe('error');
  expect(plugin.updateStatus().message).toContain('取消');
  expect(fake.has(systemToolsChannels.updateStatus)).toBe(false);
});
