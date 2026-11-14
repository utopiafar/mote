import {it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {runChromeExtensionFixture} from '../scripts/chrome-extension-smoke';
import {Collector} from '../src/collector';
import {DurableQueue} from '../src/queue';
import {defaultConfig} from '../src/config';
const hardware=vi.hoisted(()=>({pid:0,appId:'com.google.Chrome',appName:'Chrome',snapshot:undefined as any,helpers:[] as string[],pixels:vi.fn()}));
vi.mock('electron',async()=>{
 const {EventEmitter}=await import('node:events');
 return {app:{getVersion:()=> 'fixture',getLocale:()=> 'en'},powerMonitor:Object.assign(new EventEmitter(),{getSystemIdleTime:()=>0,getSystemIdleState:()=> 'active'}),systemPreferences:{getMediaAccessStatus:()=> 'denied'},desktopCapturer:{getSources:hardware.pixels},screen:{getPrimaryDisplay:()=>({id:1,size:{width:1600,height:1200}})},nativeImage:{}};
});
vi.mock('../src/native',async original=>{const actual=await original<typeof import('../src/native')>();return {...actual,foregroundApplication:async()=>({appId:hardware.appId,appName:hardware.appName,pid:hardware.pid}),runHelper:async(...args:Parameters<typeof actual.runHelper>)=>{hardware.helpers.push(args[1]);return args[1]==='ui-page'?{snapshot:hardware.snapshot}:actual.runHelper(...args);}};});
const chrome=process.env.MOTE_FIXTURE_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
it.skipIf(process.platform!=='darwin'||!existsSync(chrome))('real Chrome native messaging feeds Collector, durable restart, HTTP archive and searchable material without Memory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mote-mac-central-')),token=randomUUID()+randomUUID();let central:ChildProcess|undefined;let collector:Collector|undefined;
 try{
  const dataDir=join(root,'central');
  const repo=resolve(process.cwd(),'../..');
  central=spawn(process.execPath,['--import','tsx',join(repo,'scripts/mac-capture-central-fixture.ts')],{cwd:repo,env:{...process.env,MOTE_FIXTURE_DATA:dataDir,MOTE_FIXTURE_TOKEN:token},stdio:['ignore','ignore','pipe','ipc']});
  const nextMessage=()=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Central fixture response timed out')),20000);central!.once('message',m=>{clearTimeout(timer);resolve(m);});central!.once('exit',code=>{clearTimeout(timer);reject(Error('Central fixture exited '+code));});});
  let errors='';central.stderr!.on('data',c=>errors+=c);const ready=await nextMessage();expect(ready.type,errors).toBe('ready');const url=ready.url as string;
  await runChromeExtensionFixture(async(provider,request)=>{
   hardware.pid=request.pid;
   const cfg={...defaultConfig(),serverUrl:url,token,syncMode:'manual' as const,metadataEnabled:false,chromeOrigins:request.origins,defaultCollection:{duration:false,screenshots:false,structured:true},idlePauseSeconds:0};
   const directory=join(root,'queue'),queue=new DurableQueue(directory,cfg);await queue.initialize();
   collector=new Collector(cfg,queue,'generated-unused-helper',()=>false,()=>{},undefined,undefined,undefined,undefined,provider);
   await collector.start();await collector.settleCapture();collector.stop();collector.shutdown();
   const archived=await queue.exportArchive();expect(archived.records).toHaveLength(1);const record=archived.records[0].event;
   expect(record.metadata?.collector?.method).toBe('browser_dom');expect(record.ocrText).toContain('Visible generated article body');expect(record.ocrText).not.toMatch(/Hidden fixture secret|never captured/);expect(record.durationMs).toBe(0);expect(hardware.pixels).not.toHaveBeenCalled();
   const reopened=new DurableQueue(directory,cfg);await reopened.initialize();expect((await reopened.exportArchive()).records[0].event.id).toBe(record.id);
   collector=new Collector(cfg,reopened,'generated-unused-helper',()=>false,()=>{});await collector.upload(true);expect(reopened.stats().depth).toBe(0);
   const raw=await fetch(url+'/api/capture-browser/'+record.id,{headers:{authorization:'Bearer '+token}});expect(raw.status).toBe(200);expect((await raw.json()).ocrText).toContain('Visible generated article body');
   const inspected=nextMessage();central!.send({type:'inspect'});const result=await inspected;expect(result.type).toBe('inspection');expect(result.materials.length).toBeGreaterThan(0);expect(result.materials[0].text).toContain('Visible generated article body');expect(result.memoryJobs).toBe(0);expect(result.activityGrants).toBe(0);
   collector.shutdown();hardware.appId='com.tencent.xinWeChat';hardware.appName='WeChat';
   const bounds={x:10,y:10,width:500,height:300};
   hardware.snapshot={appId:hardware.appId,appVersion:'4.1.15',activity:'',truncated:false,nodes:[
    {id:'root',resourceId:'',role:'AXWindow',text:'',bounds},
    {id:'name',parentId:'root',resourceId:'current_chat_name_label',role:'AXStaticText',text:'Generated conversation',bounds},
    {id:'list',parentId:'root',resourceId:'chat_message_list',role:'AXList',text:'',bounds},
    ...[0,1].map(i=>({id:'message'+i,parentId:'list',childIndex:i,resourceId:'chat_bubble_item_view',role:'AXStaticText',text:'Generated repeated message',bounds})),
   ]};
   const chatQueue=new DurableQueue(join(root,'wechat-queue'),cfg);await chatQueue.initialize();
   collector=new Collector(cfg,chatQueue,'generated-unused-helper',()=>false,()=>{});await collector.start();await collector.settleCapture();collector.stop();
   const messages=(await chatQueue.exportArchive()).records,status=collector.status();expect(messages,JSON.stringify({phase:'wechat-capture',state:status.state,message:status.message,lastCaptureAt:status.lastCaptureAt,helpers:hardware.helpers})).toHaveLength(2);expect(messages.map(r=>r.event.metadata?.captureObservation?.objectIndex).sort()).toEqual([0,1]);expect(new Set(messages.map(r=>r.event.id)).size).toBe(2);expect(messages.every(r=>r.event.ocrText?.includes('Generated repeated message'))).toBe(true);
   await collector.upload(true);expect(chatQueue.stats().depth).toBe(0);const chatInspected=nextMessage();central!.send({type:'inspect'});const chatResult=await chatInspected;expect(chatResult.wechatMaterials).toHaveLength(2);expect(chatResult.wechatMaterials.every((m:any)=>m.text.includes('Generated repeated message'))).toBe(true);expect(chatResult.memoryJobs).toBe(0);
  });
 }finally{collector?.shutdown();if(central){central.kill();await new Promise<void>(r=>{if(central!.exitCode!==null)r();else central!.once('exit',()=>r());});}await rm(root,{recursive:true,force:true});}
},60000);
