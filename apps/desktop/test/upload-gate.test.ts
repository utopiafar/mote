import {describe,it,expect,vi} from 'vitest';
import {reviewUpload,defaultUploadGate,uploadGateConfig} from '../src/upload-gate';
describe('upload gate',()=>{
 it('skips OCR without explicit rules and while disabled',async()=>{const ocr=vi.fn();expect(await reviewUpload(defaultUploadGate,ocr)).toBe('allow');expect(await reviewUpload({...defaultUploadGate,enabled:false,blockedText:['private']},ocr)).toBe('allow');expect(ocr).not.toHaveBeenCalled();});
 it('matches only explicit literal owner rules',async()=>{const c={...defaultUploadGate,blockedText:['private.value']};expect(await reviewUpload(c,async()=>'private value')).toBe('allow');expect(await reviewUpload(c,async()=>'my private.value')).toBe('drop');});
 it('defaults failures to quarantine and supports explicit alternatives',async()=>{for(const failureAction of ['hold','drop','allow'] as const)expect(await reviewUpload({...defaultUploadGate,blockedText:['secret'],failureAction},async()=>{throw Error('ocr unavailable');})).toBe(failureAction);});
 it('rejects unbounded or invalid rules',()=>{expect(()=>uploadGateConfig({...defaultUploadGate,blockedText:['']})).toThrow();expect(()=>uploadGateConfig({...defaultUploadGate,failureAction:'guess'})).toThrow();});
});
it('quarantine survives normal retry and restart until explicit review',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {DurableQueue}=await import('../src/queue'),{defaultConfig}=await import('../src/config'),{event,image}=await import('./fixtures');
 const dir=await mkdtemp(join(tmpdir(),'mote-gate-'));try{const q=new DurableQueue(dir,defaultConfig());await q.initialize();await q.enqueue(event(),image,true);await q.resetRetries();expect(await q.next()).toBeUndefined();const restored=new DurableQueue(dir,defaultConfig());await restored.initialize();expect(await restored.next()).toBeUndefined();await restored.approveReview(event().id);expect((await restored.next())?.record.event.id).toBe(event().id);await expect(restored.rejectReview(event().id)).rejects.toThrow();await restored.acknowledge(event().id,true);await restored.enqueue(event(),image,true);await restored.rejectReview(event().id);expect(restored.reviewPending()).toEqual([]);expect(await restored.next()).toBeUndefined();}finally{await rm(dir,{recursive:true,force:true});}
});
