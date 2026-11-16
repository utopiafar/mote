import test from 'node:test';
import assert from 'node:assert/strict';
import {FILE_MAX_BYTES,FILE_PART_BYTES,fileRevisionSchema,filePartCount,filePartSize,filePartReceipts} from '../dist/files.js';
const hash='a'.repeat(64),row=part=>({part,hash,bytes:FILE_PART_BYTES});
test('original size and offset contracts use exact integers instead of the old archive capacity',()=>{
 const input={sourceId:'generated',item:{externalId:'generated.bin',revision:'generated',observedAt:'2026-11-17T00:00:00Z',kind:'file',layer:'original'},sha256:hash,sizeBytes:512*1024*1024+17};
 assert.equal(fileRevisionSchema.parse(input).sizeBytes,input.sizeBytes);assert.equal(filePartCount(FILE_MAX_BYTES),2147483648);assert.equal(filePartSize(FILE_MAX_BYTES,2147483647),FILE_PART_BYTES-1);
 for(const size of [-1,1.5,FILE_MAX_BYTES+1,Infinity,NaN]){assert.equal(fileRevisionSchema.safeParse({...input,sizeBytes:size}).success,false);assert.throws(()=>filePartCount(size));}
 for(const part of [-1,1.5,2147483648,Number.MAX_SAFE_INTEGER])assert.throws(()=>filePartSize(FILE_MAX_BYTES,part));
});
test('generated receipt metadata crosses pages without accumulating the full list',async()=>{
 let count=0,reads=0;const first={parts:Array.from({length:256},(_,i)=>row(i)),nextPart:255};
 for await(const receipt of filePartReceipts(first,async after=>{assert.equal(after,255);reads++;return {parts:Array.from({length:44},(_,i)=>row(i+256)),nextPart:null};},300*FILE_PART_BYTES)){assert.equal(receipt.part,count++);}
 assert.equal(count,300);assert.equal(reads,1);
});
test('malformed pages, duplicate receipts and missing continuation cannot become acknowledged originals',async()=>{
 for(const page of [{parts:[row(0),row(0)]},{parts:[row(1),row(0)]},{parts:[],nextPart:0},{parts:[row(0)],nextPart:1},{parts:[{...row(0),hash:'forged'}]},{parts:[{...row(0),bytes:1}]},{parts:Array.from({length:257},(_,i)=>row(i))}])await assert.rejects(async()=>{for await(const ignored of filePartReceipts(page,async()=>{throw Error('Unexpected continuation');},300*FILE_PART_BYTES))void ignored;});
 await assert.rejects(async()=>{for await(const ignored of filePartReceipts({parts:Array.from({length:256},(_,i)=>row(i)),nextPart:255},async()=>undefined,300*FILE_PART_BYTES))void ignored;},/page/);
});
