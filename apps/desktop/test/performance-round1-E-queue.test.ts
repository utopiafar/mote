import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableQueue} from '../src/queue';
import {event,image} from './fixtures';

let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'mote-E-batch-'));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const generated=(i:number)=>event(`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);

it('retains equal-time insertion order, due retry/held filtering, and the 25-item cap with a first observer',async()=>{
  const queue=new DurableQueue(root,{maxQueueBytes:16*1024*1024,maxQueueEvents:100});await queue.initialize();
  const ids=[99,3,2,...Array.from({length:28},(_,i)=>i+4)];
  for(const id of ids)await queue.enqueue(generated(id),image);
  await queue.failed(generated(3).id,10000,()=>0.5);await queue.blockSync(generated(2).id,'Generated held');
  const first:string[]=[];
  const batch=await queue.nextBatch(100,10001,undefined,entry=>{first.push(entry.record.event.id);});
  expect(batch).toHaveLength(25);expect(first).toEqual([generated(99).id]);
  expect(batch.map(item=>item.record.event.id)).toEqual(ids.filter(id=>id!==3&&id!==2).slice(0,25).map(id=>generated(id).id));
  batch[0].record.event.ocrText='Changed returned clone';expect(queue.recordForHistory(generated(99).id)?.event.ocrText).toBe('GENERATED FIXTURE');
  expect((await queue.nextBatch(1,12000))[0].record.event.id).toBe(generated(99).id);
});

it('retains the exact base64 admission formula and oversized-first progress',async()=>{
  const queue=new DurableQueue(root,{maxQueueBytes:32*1024*1024,maxQueueEvents:100});await queue.initialize();
  const pixels=Buffer.alloc(1_600_000);pixels[0]=255;pixels[1]=216;pixels[pixels.length-2]=255;pixels[pixels.length-1]=217;
  await queue.enqueue(generated(1),pixels);await queue.enqueue(generated(2),pixels);
  expect((await queue.nextBatch(25)).map(entry=>entry.record.event.id)).toEqual([generated(1).id]);
  await queue.acknowledge(generated(1).id);await queue.acknowledge(generated(2).id);
  const oversized=Buffer.concat([pixels.subarray(0,-2),Buffer.alloc(2_000_000),pixels.subarray(-2)]);
  await queue.enqueue(generated(3),oversized);
  expect((await queue.nextBatch(25))[0].image).toEqual(oversized);
});
