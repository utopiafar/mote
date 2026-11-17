import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DurableQueue,QueueImportFailure} from '../src/queue';
import {queueImportPresentation} from '../src/queue-import-presentation';
import {event} from './fixtures';
const fault=vi.hoisted(()=>({directory:'',failed:false}));
vi.mock('node:fs/promises',async original=>{
 const actual=await original<typeof import('node:fs/promises')>();
 return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{const file=await actual.open(...args);if(String(args[0])===fault.directory&&!fault.failed){fault.failed=true;return new Proxy(file,{get(target,key){if(key==='sync')return async()=>{throw Error('Generated directory fsync failure after event rename');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}return file;}};
});
let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'mote-import-report-'));fault.directory='';fault.failed=false;});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
const limits={maxQueueBytes:1024*1024,maxQueueEvents:10};
async function setup(){
 const source=new DurableQueue(join(root,'source'),limits);await source.initialize();await source.enqueue({...event(),source:'note',durationMs:0,ocrText:'Generated exact original',imageMime:undefined,privacy:{excluded:false,redacted:false,mode:'none'}},undefined);
 const path=join(root,'backup.json');await source.exportArchiveFile(path);const target=new DurableQueue(join(root,'target'),limits);await target.initialize();return {path,target};
}
it('reports validation failure without claiming a successful restore or modifying existing records',async()=>{
 const {target}=await setup(),path=join(root,'invalid.json');await writeFile(path,'{}');const error=await target.importArchiveFile(path).catch(error=>error);expect(error).toBeInstanceOf(QueueImportFailure);expect(error.report).toEqual({phase:'validation',imported:0,currentRecordUnconfirmed:false});expect(target.stats().depth).toBe(0);expect(queueImportPresentation({canceled:false,state:'incomplete',file:{name:'backup.json',path},...error.report,error:error.message})).toEqual({phase:'error',message:'备份未导入'});
});
it('ignores retired count settings and restores both originals durably without duplicating a retry',async()=>{
 const {path}=await setup(),directory=join(root,'quota-target'),target=new DurableQueue(directory,{...limits,maxQueueEvents:1});await target.initialize();const existing={...event(),id:'f50650f0-fb31-4215-90cd-c96dc62d5e93',source:'note' as const,imageMime:undefined,ocrText:'Existing original',durationMs:0,privacy:{excluded:false as const,redacted:false,mode:'none' as const}};await target.enqueue(existing,undefined);
 expect(await target.importArchiveFile(path)).toBe(1);expect(target.stats().depth).toBe(2);expect(target.recordForHistory(existing.id)?.event.ocrText).toBe('Existing original');expect(target.recordForHistory(event().id)?.event.ocrText).toBe('Generated exact original');
 const reopened=new DurableQueue(directory,{...limits,maxQueueEvents:1});await reopened.initialize();expect(reopened.stats().depth).toBe(2);expect(reopened.recordForHistory(existing.id)?.event.ocrText).toBe('Existing original');expect(reopened.recordForHistory(event().id)?.event.ocrText).toBe('Generated exact original');expect(await reopened.importArchiveFile(path)).toBe(0);expect(reopened.stats().records).toBe(2);
});
it('marks a rename-with-failed-fsync uncertain, then reopens and deduplicates the same backup',async()=>{
 const {target,path}=await setup();fault.directory=join(root,'target','events');const error=await target.importArchiveFile(path).catch(error=>error);expect(error).toBeInstanceOf(QueueImportFailure);expect(error.report).toEqual({phase:'saving',imported:0,total:1,currentRecordUnconfirmed:true});expect(await readFile(join(fault.directory,event().id+'.json'),'utf8')).toContain('Generated exact original');
 const reopened=new DurableQueue(join(root,'target'),limits);await reopened.initialize();expect(reopened.stats().depth).toBe(1);expect(await reopened.importArchiveFile(path)).toBe(0);expect(reopened.stats().depth).toBe(1);const presentation=queueImportPresentation({canceled:false,state:'incomplete',file:{name:'backup.json',path},...error.report,error:error.message});expect(presentation.phase).toBe('error');expect(presentation.message).toContain('待核实');
});
it('reports the confirmed lower bound when a later record write fails and preserves explicit retry',async()=>{
 const {target,path}=await setup();const archive=JSON.parse(await readFile(path,'utf8')),second={...archive.records[0],event:{...archive.records[0].event,id:'f50650f0-fb31-4215-90cd-c96dc62d5e93',ocrText:'Generated second original'}};archive.records.push(second);await writeFile(path,JSON.stringify(archive));
 let saved=false;const error=await target.importArchiveFile(path,progress=>{if(progress.completed===1&&!saved){saved=true;fault.directory=join(root,'target','events');}}).catch(error=>error);expect(error.report).toEqual({phase:'saving',imported:1,total:2,currentRecordUnconfirmed:true});expect(target.stats().depth).toBe(1);const reopened=new DurableQueue(join(root,'target'),limits);await reopened.initialize();expect(reopened.stats().depth).toBe(2);expect(await reopened.importArchiveFile(path)).toBe(0);expect(queueImportPresentation({canceled:false,state:'incomplete',file:{name:'backup.json',path},...error.report,error:error.message}).message).toContain('已确认保存 1 条');
});
