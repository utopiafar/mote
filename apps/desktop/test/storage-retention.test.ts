import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,readFile,writeFile,mkdir,rm,stat,utimes,symlink,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import { buildFixtureCentral } from './central-fixture.mjs';
import {defaultConfig} from '../src/config';
import {DurableQueue} from '../src/queue';
import {LocalSourceManager} from '../src/source-manager';
import {DEFAULT_SOURCE_OPTIONS} from '../src/source-types';
import {MeetingRecordingManager} from '../src/meeting-recording';
import {event,image} from './fixtures';

vi.mock('electron',async()=>{const {EventEmitter}=await import('node:events');return {powerMonitor:new EventEmitter(),desktopCapturer:{getSources:()=>{throw Error('No capture device in storage fixture');}},nativeImage:{},screen:{},systemPreferences:{getMediaAccessStatus:()=>'granted'}};});
import {Collector} from '../src/collector';
import {createSourcesPlugin} from '../src/plugins/sources';
import {SettingsCoordinator} from '../src/settings-coordinator';
import {DatabaseSync} from 'node:sqlite';

const roots:string[]=[],cleanup:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllGlobals();vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){const directory=await realpath(await mkdtemp(join(tmpdir(),'mote-mac-storage-')));roots.push(directory);let models=0;
 const token='generated-mac-storage-'+randomUUID(),node=await buildFixtureCentral(join(directory,'central'),token,{agent:{configured:false,async query(){models++;throw Error('No model in Mac storage fixture');},async close(){}}});cleanup.push(()=>node.app.close());
 const origin=await node.app.listen({host:'127.0.0.1',port:0}),config={...defaultConfig(),serverUrl:origin,token,packedUpload:false,syncMode:'manual' as const},nativeFetch=globalThis.fetch;
 return {directory,node,origin,config,nativeFetch,get models(){return models;},get:(path:string,init:RequestInit={})=>nativeFetch(origin+path,{...init,headers:{authorization:'Bearer '+token,...Object.fromEntries(new Headers(init.headers))}})};
}
function collector(config:ReturnType<typeof defaultConfig>,queue:DurableQueue){const value=new Collector(config,queue,'/must-not-run-native-helper',()=>true,()=>{});cleanup.push(()=>value.shutdown());return value;}
async function sources(f:Awaited<ReturnType<typeof fixture>>,directory:string,paused:boolean){const value=new LocalSourceManager(directory,{...f.config,syncPaused:paused},'/must-not-run-native-helper',true);vi.spyOn((value as any).watcher,'setTargets').mockResolvedValue(undefined);cleanup.push(()=>value.close());await value.initialize();return value;}
async function audio(f:Awaited<ReturnType<typeof fixture>>,connection:()=>ReturnType<typeof defaultConfig>&{generation:number},bytes:Buffer){const manager=new MeetingRecordingManager({directory:join(f.directory,'meetings'),connection,permissions:()=>({microphone:'granted',systemAudio:'granted'}),backend:{async start({outputFile}){return {async stop(){await writeFile(outputFile,bytes,{mode:0o600});return {filePath:outputFile,durationMs:60000,microphone:true,systemAudio:true,warnings:[]};}};}}});cleanup.push(()=>manager.close());await manager.initialize();return manager;}

it('real capture receipts retain generated screenshots and notes across restart and Central history deletion without retransmission',async()=>{
 const f=await fixture(),path=join(f.directory,'queue'),screen=event(randomUUID()),jpeg=await sharp({create:{width:4,height:4,channels:3,background:'#34658a'}}).jpeg().toBuffer();
 screen.deviceId=f.config.deviceId;const note={...screen,id:randomUUID(),source:'note' as const,durationMs:0,imageMime:undefined,ocr:undefined,ocrText:'Generated permanent local note',privacy:{excluded:false as const,redacted:false,mode:'none' as const}};
 let lost=false,writes=0;vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await f.nativeFetch(input,init);if(String(input).endsWith('/api/captures')&&init?.method==='POST'){writes++;if(!lost){lost=true;await response.body?.cancel();throw Error('Generated lost complete ACK');}}return response;});
 const queue=new DurableQueue(path,f.config);await queue.initialize();await queue.enqueue(screen,jpeg);await queue.enqueue(note);const first=collector(f.config,queue);await first.upload(true);expect(queue.stats().depth).toBe(2);expect(queue.recordForHistory(screen.id)?.archiveAcknowledgment).toBeUndefined();first.shutdown();
 const reopened=new DurableQueue(path,f.config);await reopened.initialize();await reopened.resetRetries();const resumed=collector(f.config,reopened);await resumed.upload(true);expect(reopened.stats().depth).toBe(0);expect(await reopened.next()).toBeUndefined();expect(reopened.contentRecords()).toHaveLength(2);expect(await reopened.imageForBrowser(screen.id)).toEqual(jpeg);expect(reopened.recordForHistory(note.id)?.event.ocrText).toBe(note.ocrText);expect(reopened.recordForHistory(screen.id)?.archiveAcknowledgment?.origin).toBe(f.origin);expect(writes).toBe(3);
 const archive=join(f.directory,'saved-queue.json');await reopened.exportArchiveFile(archive);const imported=new DurableQueue(join(f.directory,'restored-queue'),f.config);await imported.initialize();expect(await imported.importArchiveFile(archive)).toBe(2);expect(await imported.next()).toBeUndefined();expect(imported.contentRecords()).toHaveLength(2);expect(await imported.imageForBrowser(screen.id)).toEqual(jpeg);
 const deleted=await f.get('/api/captures/'+screen.id,{method:'DELETE'});expect(deleted.ok).toBe(true);expect((await f.get('/api/captures/'+screen.id)).status).toBe(404);resumed.shutdown();
 const again=new DurableQueue(path,f.config);await again.initialize();await collector(f.config,again).upload(true);expect(writes).toBe(3);expect(await again.imageForBrowser(screen.id)).toEqual(jpeg);expect(again.recordForHistory(screen.id)?.event.capturedAt).toBe(screen.capturedAt);expect(f.models).toBe(0);
});

it('actual meeting bytes survive a mismatched whole receipt, a late ABA receipt, exact recovery and shutdown',async()=>{
 const f=await fixture(),bytes=Buffer.alloc(4*1024*1024+17,37);let connection={...f.config,generation:0},parts=0,corrupt=true,hold=false,release=()=>{},entered=()=>{};let gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;});
 vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await f.nativeFetch(input,{...init,signal:undefined}),path=new URL(String(input)).pathname;if(init?.method==='PUT'&&path.includes('/parts/'))parts++;if(init?.method==='POST'&&(path.endsWith('/commit')||path==='/api/file-sync/v1/uploads')){const body=await response.clone().json();if(path.endsWith('/commit')&&corrupt){corrupt=false;return new Response(JSON.stringify({...body,sha256:'f'.repeat(64)}),{status:200});}if(hold&&body.ack){entered();await gate;}}return response;});
 const manager=await audio(f,()=>connection,bytes);await manager.acknowledgeNotice();await manager.start();await manager.stop();expect(manager.status().pendingUploads).toBe(1);expect(manager.status().lastSession?.captureId).toBeUndefined();const id=manager.status().lastSession!.id,path=join(f.directory,'meetings',id,'meeting.m4a');expect(hash(await readFile(path))).toBe(hash(bytes));expect(parts).toBe(2);
 hold=true;const attempt=manager.flushUploads();await seen;connection={...connection,serverUrl:'https://other-central.invalid',generation:1};connection={...connection,serverUrl:f.origin,generation:2};release();await attempt;expect(manager.status().pendingUploads).toBe(1);expect(manager.status().lastSession?.captureId).toBeUndefined();expect(parts).toBe(2);
 hold=false;await manager.flushUploads();expect(manager.status().lastSession).toMatchObject({state:'uploaded',uploadOrigin:f.origin});expect(manager.status().pendingUploads).toBe(0);expect(parts).toBe(2);await manager.close();expect(hash(await readFile(path))).toBe(hash(bytes));
 const captureId=manager.status().lastSession!.captureId!;expect((await f.get('/api/files/'+captureId,{method:'DELETE'})).ok).toBe(true);expect(hash(await readFile(path))).toBe(hash(bytes));expect(f.models).toBe(0);
});

it('real source scope narrowing persists local isolation, frees only exact-ACK transport, and expansion admits a fresh revision',async()=>{
 const f=await fixture(),selected=join(f.directory,'selected'),state=join(f.directory,'sources');await mkdir(selected);for(const name of ['keep.txt','withdraw.md']){await writeFile(join(selected,name),'Generated '+name);await utimes(join(selected,name),1,1);}
 const alias=join(f.directory,'selected-alias-parent');await symlink(f.directory,alias);
 let manager=await sources(f,state,true);const id=await manager.addFiles(join(alias,'selected'),DEFAULT_SOURCE_OPTIONS);await manager.sync(true);const original=manager.pendingContent(),keep=original.find(row=>row.item.title==='keep.txt')!.item,withdraw=original.find(row=>row.item.title==='withdraw.md')!.item;expect(original).toHaveLength(2);expect(manager.status()[0].source.retention).toBe('archive');
 await manager.update(id,{...manager.status()[0].source,extensions:['.txt']});await manager.sync(true);expect(manager.status()[0]).toMatchObject({pending:1,blocked:1,failures:[{status:403,localPolicy:true}]});expect(await readFile(join(withdraw.localOriginal!.directory,'0'),'utf8')).toBe('Generated withdraw.md');await manager.close();
 manager=await sources(f,state,false);await manager.sync(true);await manager.flushPending(new AbortController().signal);expect(f.node.sources.getItem(id,keep.externalId)?.revision).toBe(keep.revision);expect(f.node.sources.getItem(id,withdraw.externalId)).toBeUndefined();expect(manager.connectionActivity().pending).toBe(1);expect(manager.status()[0]).toMatchObject({pending:0,blocked:1});await expect(stat(keep.localOriginal!.directory)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(selected,'keep.txt'),'utf8')).toBe('Generated keep.txt');expect(await readFile(join(withdraw.localOriginal!.directory,'0'),'utf8')).toBe('Generated withdraw.md');
 await manager.update(id,{...manager.status()[0].source,extensions:['.txt','.md']});await manager.sync(true);await manager.flushPending(new AbortController().signal);const restored=f.node.sources.getItem(id,withdraw.externalId);expect(restored).toBeDefined();expect(restored!.revision).not.toBe(withdraw.revision);expect(manager.status()[0].blocked).toBe(1);expect(manager.pendingContent().some(row=>row.item.revision===withdraw.revision)).toBe(true);expect(await readFile(join(withdraw.localOriginal!.directory,'0'),'utf8')).toBe('Generated withdraw.md');expect(f.node.sources.getItem(id,keep.externalId)?.revision).toBe(keep.revision);expect(f.models).toBe(0);
});

it('a scope withdrawal during an actual head preflight blocks late dispatch even if the transport ignores cancellation',async()=>{
 const f=await fixture(),selected=join(f.directory,'selected');await mkdir(selected);await writeFile(join(selected,'pending.txt'),'Generated scope preflight original');let uploads=0,release=()=>{},entered=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;});
 const manager=await sources(f,join(f.directory,'sources'),true),id=await manager.addFiles(selected,DEFAULT_SOURCE_OPTIONS);await manager.sync(true);await manager.setSyncPaused(false);
 vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await f.nativeFetch(input,{...init,signal:undefined});const path=new URL(String(input)).pathname;if(path.endsWith('/head')){entered();await gate;}if(path.endsWith('/uploads')&&init?.method==='POST')uploads++;return response;});
 const attempt=manager.flushPending(new AbortController().signal).catch(error=>error);await seen;const update=manager.update(id,{...manager.status()[0].source,excludedPaths:['pending.txt']});await Promise.resolve();release();await attempt;await update;await manager.sync(true);expect(uploads).toBe(0);expect(manager.status()[0]).toMatchObject({pending:0,blocked:1,failures:[{localPolicy:true}]});expect(manager.pendingContent()[0].item.localOriginal).toBeDefined();expect(await readFile(join(selected,'pending.txt'),'utf8')).toBe('Generated scope preflight original');
});

it('a real event rename failure retains old records and the sole journaled input for recovery',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-mac-write-failure-')));roots.push(root);const first=event(randomUUID()),second=event(randomUUID()),queue=new DurableQueue(root,{});await queue.initialize();await queue.enqueue(first,image);await mkdir(join(root,'events',second.id+'.json'));
 await expect(queue.enqueue(second,image)).rejects.toMatchObject({code:'EISDIR'});expect(queue.recordForHistory(first.id)?.event).toEqual(first);expect(await readFile(join(root,'blobs',hash(image)+'.jpg'))).toEqual(image);expect(JSON.parse(await readFile(join(root,'capture-input-journal.json'),'utf8')).event.id).toBe(second.id);
 await rm(join(root,'events',second.id+'.json'),{recursive:true});const reopened=new DurableQueue(root,{});await reopened.initialize();expect(reopened.stats().depth).toBe(2);expect(reopened.contentRecords().map(row=>row.event.id).sort()).toEqual([first.id,second.id].sort());expect(await reopened.imageForBrowser(second.id)).toEqual(image);
});


it('an actual capture accepted before an ABA settings change cannot stamp a late local ACK in the new generation',async()=>{
 const f=await fixture(),queue=new DurableQueue(join(f.directory,'queue'),f.config);await queue.initialize();const sample=event(randomUUID());sample.deviceId=f.config.deviceId;const jpeg=await sharp({create:{width:4,height:4,channels:3,background:'#478123'}}).jpeg().toBuffer();await queue.enqueue(sample,jpeg);let release=()=>{},entered=()=>{},held=true;const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;});
 vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await f.nativeFetch(input,{...init,signal:undefined});if(held&&init?.method==='POST'&&String(input).endsWith('/api/captures')){entered();await gate;}return response;});
 const client=collector(f.config,queue),attempt=client.upload(true);await seen;client.updateConfig({...f.config,serverUrl:'https://other-central.invalid',token:'generated-other-token'});client.updateConfig(f.config);release();await attempt;expect(queue.stats().depth).toBe(1);expect(queue.recordForHistory(sample.id)?.archiveAcknowledgment).toBeUndefined();expect(await queue.imageForBrowser(sample.id)).toEqual(jpeg);expect((await f.get('/api/captures/'+sample.id)).status).toBe(200);
 held=false;await queue.resetRetries();await client.upload(true);expect(queue.stats().depth).toBe(0);expect(queue.recordForHistory(sample.id)?.archiveAcknowledgment?.origin).toBe(f.origin);
});


it('the production source plugin includes a saved meeting in the real settings connection guard',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-mac-meeting-binding-')));roots.push(root);const id=randomUUID(),startedAt='2020-01-01T00:00:00Z',config={...defaultConfig(),serverUrl:'',token:undefined};await mkdir(join(root,'meetings',id),{recursive:true});await writeFile(join(root,'meetings',id,'meeting.m4a'),'Generated saved audio');await writeFile(join(root,'meetings','meetings.json'),JSON.stringify({version:1,noticeAcknowledgedAt:startedAt,sessions:[{id,startedAt,endedAt:'2020-01-01T00:01:00Z',state:'completed',durationMs:60000,microphone:true,systemAudio:true,noticeAcknowledgedAt:startedAt,platform:'macos',warnings:[],audioFile:'meeting.m4a'}]}));
 const plugin=createSourcesPlugin({directory:root,settings:()=>config,helperPath:'/must-not-run-native-helper'});vi.spyOn((plugin.manager as any).watcher,'setTargets').mockResolvedValue(undefined);cleanup.push(()=>plugin.close());await plugin.initialize();expect(plugin.manager.connectionActivity()).toMatchObject({pending:1});let changed=false;
 const coordinator=new SettingsCoordinator({collector:{suspendForSettings:async()=>async()=>{},connectionActivity:()=>({pending:0,inFlight:false})},sources:plugin.manager,queue:{stats:()=>({depth:0})},notes:{hasPrepared:()=>false},running:()=>false,quitting:()=>false,recoveryRequired:()=>undefined} as never);
 await expect(coordinator.connectionChange(async()=>{changed=true;})).rejects.toThrow();expect(changed).toBe(false);expect(await readFile(join(root,'meetings',id,'meeting.m4a'),'utf8')).toBe('Generated saved audio');
});

it('an unproven saved source scope isolates its old revision and current scanning obtains a fresh admission',async()=>{
 const f=await fixture(),selected=join(f.directory,'selected');await mkdir(selected);await writeFile(join(selected,'old.txt'),'Generated unknown-scope original');const directory=join(f.directory,'sources');let manager=await sources(f,directory,true);const id=await manager.addFiles(selected,DEFAULT_SOURCE_OPTIONS);await manager.sync(true);const old=manager.pendingContent()[0].item,binding=(manager as any).binding;await manager.close();
 const db=new DatabaseSync(join(directory,'nodes',binding,id+'.json.sqlite'));db.prepare("DELETE FROM entries WHERE section='state' AND key='sourceScope'").run();db.close();
 manager=await sources(f,directory,false);await manager.sync(true);await manager.flushPending(new AbortController().signal);expect(manager.status()[0]).toMatchObject({pending:0,blocked:1,failures:[{localPolicy:true}]});expect(manager.pendingContent().some(row=>row.item.revision===old.revision)).toBe(true);expect(await readFile(join(old.localOriginal!.directory,'0'),'utf8')).toBe('Generated unknown-scope original');expect(f.node.sources.getItem(id,old.externalId)?.revision).not.toBe(old.revision);expect(f.models).toBe(0);
});


it('a completed old-origin disk ACK cannot publish a new-origin summary after its completion callback is delayed',async()=>{
 const f=await fixture(),queue=new DurableQueue(join(f.directory,'queue'),f.config);await queue.initialize();const sample={...event(randomUUID()),deviceId:f.config.deviceId,source:'note' as const,durationMs:0,imageMime:undefined,ocr:undefined,ocrText:'Generated receipt completion fence',privacy:{excluded:false as const,redacted:false,mode:'none' as const}};await queue.enqueue(sample);let release=()=>{},entered=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;}),acknowledge=queue.acknowledge.bind(queue);
 vi.spyOn(queue,'acknowledge').mockImplementation(async(...args)=>{await acknowledge(...args);entered();await gate;});
 const client=collector(f.config,queue),attempt=client.upload(true);await seen;expect(queue.recordForHistory(sample.id)?.archiveAcknowledgment?.origin).toBe(f.origin);client.updateConfig({...f.config,serverUrl:'https://other-central.invalid',token:'generated-other-token'});release();await attempt;
 expect(queue.recordForHistory(sample.id)?.archiveAcknowledgment?.origin).toBe(f.origin);expect(queue.stats().archiveAcknowledgment?.origin).not.toBe('https://other-central.invalid');expect(client.status().lastUploadAt).toBeUndefined();expect(queue.stats().depth).toBe(0);expect(queue.contentRecords()).toHaveLength(1);
});

it('a meeting projects success only after its receipt write and preserves that origin through a late completion',async()=>{
 const f=await fixture(),bytes=Buffer.from('Generated receipt durability audio');let connection={...f.config,generation:0},received=false,release=()=>{},entered=()=>{},finish=()=>{},committed=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;}),completion=new Promise<void>(resolve=>{finish=resolve;}),saved=new Promise<void>(resolve=>{committed=resolve;});
 vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await f.nativeFetch(input,init);if(String(input).endsWith('/commit'))received=true;return response;});
 const manager=await audio(f,()=>connection,bytes),persist=(manager as any).persist.bind(manager);vi.spyOn(manager as any,'persist').mockImplementation(async(...args:unknown[])=>{if(received&&args[1]){entered();await gate;await persist(...args);committed();await completion;}else await persist(...args);});await manager.acknowledgeNotice();await manager.start();const stopping=manager.stop();await seen;
 try{expect(manager.status().lastSession?.state).toBe('completed');expect(manager.status().lastSession?.captureId).toBeUndefined();release();await saved;expect(manager.status().lastSession).toMatchObject({state:'uploaded',uploadOrigin:f.origin});connection={...connection,serverUrl:'https://other-central.invalid',generation:1};}finally{release();finish();await stopping;}
 expect(manager.status().lastSession).toMatchObject({state:'uploaded',uploadOrigin:f.origin});expect(await readFile(join(f.directory,'meetings',manager.status().lastSession!.id,'meeting.m4a'))).toEqual(bytes);
});

it('a real meeting receipt rename failure stays pending and restart consumes the exact Central receipt without resending audio',async()=>{
 const f=await fixture(),bytes=Buffer.from('Generated receipt write failure audio'),connection={...f.config,generation:0},state=join(f.directory,'meetings','meetings.json'),saved=state+'.saved';let parts=0,commits=0,captureId='';
 vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const response=await f.nativeFetch(input,init),path=new URL(String(input)).pathname;if(init?.method==='PUT'&&path.includes('/parts/'))parts++;if(path.endsWith('/commit')){commits++;captureId=(await response.clone().json()).id;await rename(state,saved);await mkdir(state);}return response;});
 const manager=await audio(f,()=>connection,bytes);await manager.acknowledgeNotice();await manager.start();await manager.stop();const session=manager.status().lastSession!;
 expect(manager.status().pendingUploads).toBe(1);expect(session).toMatchObject({state:'completed',uploadOrigin:f.origin});expect(session.captureId).toBeUndefined();expect(session.uploadedAt).toBeUndefined();expect(session.error).toMatch(/EISDIR/);expect((await f.get('/api/files')).ok).toBe(true);expect(parts).toBe(1);expect(commits).toBe(1);expect(await readFile(join(f.directory,'meetings',session.id,'meeting.m4a'))).toEqual(bytes);
 await manager.close();await rm(state,{recursive:true});await rename(saved,state);const restarted=await audio(f,()=>connection,bytes);expect(restarted.status().pendingUploads).toBe(0);expect(restarted.status().sessions).toHaveLength(1);expect(restarted.status().lastSession).toMatchObject({id:session.id,state:'uploaded',captureId,uploadOrigin:f.origin});expect(parts).toBe(1);expect(commits).toBe(1);expect((await (await f.get('/api/files')).json()).items).toHaveLength(1);expect(await readFile(join(f.directory,'meetings',session.id,'meeting.m4a'))).toEqual(bytes);expect(f.models).toBe(0);
});
