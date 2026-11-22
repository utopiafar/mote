import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from '../src/config';
import {DurableQueue} from '../src/queue';
import {LocalSourceManager} from '../src/source-manager';
import {DEFAULT_SOURCE_OPTIONS} from '../src/source-types';
import {Collector} from '../src/collector';
import {canSendFromTray,showTraySendFailure} from '../src/tray-send';
import {event,image} from './fixtures';
vi.mock('electron',async()=>{const {EventEmitter}=await import('node:events');return {powerMonitor:new EventEmitter(),systemPreferences:{getMediaAccessStatus:()=> 'denied'},desktopCapturer:{},nativeImage:{},screen:{}};});
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.restoreAllMocks();});

it('disables an actually empty queue but preserves source-only and captured pending records in the tray total',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'mote-tray-pending-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const config={...defaultConfig(),serverUrl:'',syncMode:'manual' as const,syncPaused:false},queue=new DurableQueue(join(dir,'queue'),config);await queue.initialize();
  const sources=new LocalSourceManager(join(dir,'sources'),config,'/unused-generated-helper',true);await sources.initialize();cleanup.push(()=>sources.close());
  const collector=new Collector(config,queue,'/unused-generated-helper',()=>false,()=>{},undefined,undefined,sources);cleanup.push(async()=>collector.shutdown());
  expect(collector.status().sync.pendingRecords).toBe(0);expect(canSendFromTray(collector.status())).toBe(false);
  const file=join(dir,'generated.txt');await writeFile(file,'Generated source-only original.');await sources.addFiles(file,DEFAULT_SOURCE_OPTIONS);await sources.sync(true);
  const sourceOnly=collector.status();expect(sourceOnly.queueDepth).toBe(0);expect(sourceOnly.sync.pendingRecords).toBeGreaterThan(0);expect(canSendFromTray(sourceOnly)).toBe(true);
  await queue.enqueue(event(),image);const both=collector.status();expect(both.queueDepth).toBe(1);expect(both.sync.pendingRecords).toBe(sourceOnly.sync.pendingRecords+1);expect(canSendFromTray(both)).toBe(true);
  expect(canSendFromTray({...both,config:{...both.config,syncPaused:true}})).toBe(false);
  expect(canSendFromTray({...both,sync:{...both.sync,state:'uploading'}})).toBe(false);
  expect(collector.status().running).toBe(false);
});

it('shows a readable failure first, discloses exact diagnostics only on request, and never retries the send',async()=>{
  const cause=Object.assign(Error('HTTP 503 generated protocol detail <literal>'),{httpStatus:503}),show=vi.fn(async()=>({response:0}));
  await showTraySendFailure(cause,show);expect(show).toHaveBeenCalledTimes(1);expect(show.mock.calls[0][0]).toMatchObject({title:'立即发送',message:'发送待确认。查看同步状态再重试。',cancelId:0});expect(JSON.stringify(show.mock.calls[0])).not.toContain(cause.message);
  const explicit=vi.fn().mockResolvedValueOnce({response:1}).mockResolvedValueOnce({response:0});await showTraySendFailure(cause,explicit);expect(explicit).toHaveBeenCalledTimes(2);expect(explicit.mock.calls[1][0]).toMatchObject({title:'技术详情',message:cause.message});
});
