import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaptureStageRegistry, type CaptureStage } from '../src/capture-stages';
import { DurableQueue } from '../src/queue';
import { encodeLocalContent, readLocalContent } from '../src/local-content';
import type { CaptureEvent } from '../src/contracts';
import { event, image } from './fixtures';

const limits={maxQueueBytes:2*1024*1024,maxQueueEvents:20};
function note(id=randomUUID(),capturedAt='2026-09-24T00:00:00Z'):CaptureEvent {
  const base=event(id);
  return {...base,source:'note',imageMime:undefined,durationMs:0,ocrText:'Generated note',capturedAt,privacy:{excluded:false,redacted:false,mode:'none'}};
}
function split():CaptureStageRegistry {return new CaptureStageRegistry().register({id:'split',version:1,consume(inputs,_checkpoint,context){return {outputs:inputs.flatMap(packet=>['left','right'].map(key=>({event:{...packet.event,id:context.deriveId([packet.event.id],key),ocrText:`${packet.event.ocrText} ${key}`}}))),held:false};}});}
function pair(version=1,configuration='default'):CaptureStageRegistry {return new CaptureStageRegistry().register({id:'pair',version,configuration,consume(inputs,checkpoint,context){let held=(checkpoint as {event?:CaptureEvent}|undefined)?.event;const outputs=[] as {event:CaptureEvent}[];for(const packet of inputs){if(!held){held=packet.event;continue;}outputs.push({event:{...held,id:context.deriveId([held.id,packet.event.id],'pair'),ocrText:`${held.ocrText} + ${packet.event.ocrText}`}});held=undefined;}if(context.flush&&held){outputs.push({event:held});held=undefined;}return {outputs,checkpoint:held?{event:held}:{},held:Boolean(held)};}});}
async function temporary(run:(directory:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'mote-stage-durable-'));try{await run(directory);}finally{await rm(directory,{recursive:true,force:true});}}

describe('durable capture stage pipeline',()=>{
  it('splits one capture into two stable IDs and replays a committed journal after a crash',async()=>temporary(async directory=>{
    const input=note(),stages=split();
    const interrupted=new DurableQueue(directory,limits,stages,()=>{throw Error('synthetic crash after journal fsync');});await interrupted.initialize();
    await expect(interrupted.enqueue(input)).rejects.toThrow('synthetic crash');
    expect(await readdir(directory)).toContain('capture-stage-journal.json');
    const journal=JSON.parse((await readLocalContent(join(directory,'capture-stage-journal.json'))).toString()) as {outputs:unknown[]};
    await writeFile(join(directory,'events',`${(journal.outputs[0] as {event:{id:string}}).event.id}.json`),encodeLocalContent(JSON.stringify(journal.outputs[0])));
    const restored=new DurableQueue(directory,limits,stages);await restored.initialize();
    const first=(await restored.nextBatch()).map(row=>row.record.event);
    expect(first).toHaveLength(2);expect(new Set(first.map(row=>row.id)).size).toBe(2);
    expect(first.map(row=>row.ocrText).sort()).toEqual(['Generated note left','Generated note right']);
    expect(await readdir(directory)).not.toContain('capture-stage-journal.json');
    const stable=new DurableQueue(directory,limits,stages);await stable.initialize();
    expect((await stable.nextBatch()).map(row=>row.record.event.id)).toEqual(first.map(row=>row.id));
  }));

  it('holds across batches and restart, then combines two inputs into one output',async()=>temporary(async directory=>{
    const first=note(),second=note(randomUUID(),'2026-09-24T00:00:05Z'),stages=pair();
    const before=new DurableQueue(directory,limits,stages);await before.initialize();expect(await before.enqueue(first)).toBe(false);expect(before.stats().depth).toBe(0);
    await expect(before.exportArchiveFile(join(directory,'incomplete-export.json'))).rejects.toThrow('Flush held');
    const restored=new DurableQueue(directory,limits,stages);await restored.initialize();expect(await restored.enqueue(second)).toBe(true);
    const combined=(await restored.next())?.record.event;expect(combined?.ocrText).toBe('Generated note + Generated note');
    expect(combined?.id).not.toBe(first.id);expect(combined?.id).not.toBe(second.id);
    const again=new DurableQueue(directory,limits,stages);await again.initialize();expect((await again.next())?.record.event.id).toBe(combined?.id);
  }));

  it('replays a durable input journal when interrupted before stage output commit',async()=>temporary(async directory=>{
    const input=note(),stages=split();
    const interrupted=new DurableQueue(directory,limits,stages,undefined,()=>{throw Error('synthetic crash after input fsync');});await interrupted.initialize();
    await expect(interrupted.enqueue(input)).rejects.toThrow('synthetic crash');
    expect(await readdir(directory)).toContain('capture-input-journal.json');
    const restored=new DurableQueue(directory,limits,stages);await restored.initialize();
    expect((await restored.nextBatch()).map(row=>row.record.event.ocrText).sort()).toEqual(['Generated note left','Generated note right']);
    expect(await readdir(directory)).not.toContain('capture-input-journal.json');
  }));

  it('retains the image blob when an interrupted screen input is recovered on restart',async()=>temporary(async directory=>{
    const input=event(),interrupted=new DurableQueue(directory,limits,undefined,undefined,()=>{throw Error('synthetic crash after input fsync');});await interrupted.initialize();
    await expect(interrupted.enqueue(input,image)).rejects.toThrow('synthetic crash');
    const restored=new DurableQueue(directory,limits);await restored.initialize();
    expect((await restored.next())?.record.event.id).toBe(input.id);
    expect(await restored.imageForBrowser(input.id)).toEqual(image);
  }));

  it('flushes held input explicitly and refuses an incompatible version while input is held',async()=>temporary(async directory=>{
    const input=note(),v1=pair(1),v2=pair(2);
    const before=new DurableQueue(directory,limits,v1);await before.initialize();await before.enqueue(input);
    const changed=new DurableQueue(directory,limits,v2);await changed.initialize();
    await expect(changed.enqueue(note(randomUUID(),'2026-09-24T00:00:05Z'))).rejects.toThrow('migration is required');
    expect(changed.stats().depth).toBe(0);
    const recovered=new DurableQueue(directory,limits,v1);await recovered.initialize();
    expect(await recovered.flushCaptureStages()).toBe(1);
    expect((await recovered.next())?.record.event.id).toBe(input.id);
    const upgraded=new DurableQueue(directory,limits,v2);await upgraded.initialize();
    expect(await upgraded.enqueue(note(randomUUID(),'2026-09-24T00:00:10Z'))).toBe(false);
  }));

  it('binds held state to stage configuration and enforces the held privacy floor on flush',async()=>temporary(async directory=>{
    const {ocrText:_text,imageMime:_mime,...base}=note();
    const activity={...base,source:'activity' as const,privacy:{excluded:false as const,redacted:false,mode:'none' as const,collection:'activity' as const}};
    const unsafe=new CaptureStageRegistry().register({id:'hold',version:1,configuration:'one',consume(inputs,checkpoint,context){const held=(checkpoint as {event?:CaptureEvent}|undefined)?.event??inputs[0]?.event;return {outputs:context.flush&&held?[{event:{...note(held.id),ocrText:'Leaked activity'}}]:[],checkpoint:held?{event:held}:{},held:Boolean(held)};}});
    const queue=new DurableQueue(directory,limits,unsafe);await queue.initialize();await queue.enqueue(activity);
    const changed=new DurableQueue(directory,limits,new CaptureStageRegistry().register({...unsafe.versions()[0],configuration:'two',consume:inputs=>({outputs:[...inputs],held:false})}));await changed.initialize();
    await expect(changed.enqueue(note())).rejects.toThrow('migration is required');
    const restored=new DurableQueue(directory,limits,unsafe);await restored.initialize();
    await expect(restored.flushCaptureStages()).rejects.toThrow('weakened privacy');
    expect(restored.stats().depth).toBe(0);
  }));

  it('refuses to hold image bytes without durable asset state',async()=>temporary(async directory=>{
    const stage=new CaptureStageRegistry().register({id:'hold-image',version:1,consume:()=>({outputs:[],checkpoint:{pending:true},held:true})});
    const queue=new DurableQueue(directory,limits,stage);await queue.initialize();
    await expect(queue.enqueue(event(),Buffer.from([0xff,0xd8,0xff,0xd9]))).rejects.toThrow('cannot hold image inputs');
    expect(queue.stats().depth).toBe(0);
  }));

  it('starts a new state series after the prior head has been ACKed',async()=>temporary(async directory=>{
    const {ocrText:_text,imageMime:_mime,...base}=note();
    const first={...base,source:'activity' as const,privacy:{excluded:false as const,redacted:false,mode:'none' as const,collection:'activity' as const}};
    const queue=new DurableQueue(directory,limits);await queue.initialize();await queue.enqueue(first);await queue.acknowledge(first.id);
    const reopened=new DurableQueue(directory,limits);await reopened.initialize();
    const second={...first,id:randomUUID(),capturedAt:'2026-09-24T00:00:05Z'};await reopened.enqueue(second);
    expect((await reopened.next())?.record.event.id).toBe(second.id);
    expect((await reopened.next())?.record.event.stateSeries?.samples).toHaveLength(1);
  }));

  it('validates every split output after the stage and rejects privacy weakening',async()=>temporary(async directory=>{
    const malicious=new CaptureStageRegistry().register({id:'malicious',version:1,consume(inputs){return {outputs:inputs.map(packet=>({event:{...packet.event,privacy:{...packet.event.privacy,excluded:true}} as CaptureEvent})),held:false};}});
    const queue=new DurableQueue(directory,limits,malicious);await queue.initialize();
    await expect(queue.enqueue(note())).rejects.toThrow('隐私');
    expect(queue.stats().depth).toBe(0);
    const downgrade=new CaptureStageRegistry().register({id:'downgrade',version:1,consume(inputs){return {outputs:inputs.map(packet=>({event:note(packet.event.id)})),held:false};}});
    const second=new DurableQueue(directory,limits,downgrade);await second.initialize();
    await expect(second.enqueue(event(),image)).rejects.toThrow('weakened privacy');
    expect(second.stats().depth).toBe(0);
  }));
});
