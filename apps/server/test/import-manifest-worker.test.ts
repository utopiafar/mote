import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {formatWork} from '../src/format-work.js';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(t:any){const workspace=realpathSync(mkdtempSync(join(tmpdir(),'mote-manifest-worker-')));mkdirSync(join(workspace,'inputs'));const path=join(workspace,'inputs','generated.txt'),original='Generated original';writeFileSync(path,original);t.after(()=>rmSync(workspace,{recursive:true,force:true}));const file={id:randomUUID(),hash:digest(original),sizeBytes:Buffer.byteLength(original),name:'generated.txt',relativePath:'generated.txt',mimeType:'text/plain',createdAt:'2025-01-01T00:00:00.000Z'},manifest=join(workspace,'records.jsonl'),output=join(workspace,'prepared.jsonl');const record={item:{externalId:'fixture',revision:'1',observedAt:file.createdAt,title:'Generated',text:'Generated original',kind:'file',layer:'original'},evidencePaths:[path],attachments:[]};writeFileSync(manifest,JSON.stringify(record)+'\n');return {workspace,path,file,manifest,output,record,task:{kind:'manifest' as const,workspace,path:manifest,output,inputs:[{path,file}]}};}

test('manifest worker rejects an invalid later line before publishing any prepared records',async t=>{
 const {task,manifest,output,record}=fixture(t);writeFileSync(manifest,JSON.stringify(record)+'\nnot-json\n');
 await assert.rejects(formatWork(task),/manifest line 2/);assert.equal(existsSync(output),false);
 writeFileSync(manifest,JSON.stringify(record)+'\n');const result=await formatWork(task);assert.equal(result.count,1);assert.equal(result.samples[0].text,record.item.text);assert.ok(existsSync(output));
});
test('manifest validation streams original hashes and enforces reviewed preview identity',async t=>{
 const {task,path,manifest}=fixture(t);writeFileSync(path,'Modified generated original');await assert.rejects(formatWork(task),/input file changed/);
 writeFileSync(path,'Generated original');await assert.rejects(formatWork({...task,expectedHash:'0'.repeat(64)}),/preview changed/);
 const value=await formatWork({...task,expectedHash:digest(JSON.stringify({item:{externalId:'fixture',revision:'1',observedAt:'2025-01-01T00:00:00.000Z',title:'Generated',text:'Generated original',kind:'file',layer:'original'},evidencePaths:[path],attachments:[]})+'\n')});assert.equal(value.count,1);assert.ok(manifest);
});
test('cancellation during worker admission cannot publish a preview or consume the next worker slot',async t=>{
 const {task,output}=fixture(t),controller=new AbortController(),pending=formatWork(task,controller.signal);controller.abort();await assert.rejects(pending);assert.equal(existsSync(output),false);
 const result=await formatWork(task);assert.equal(result.count,1);
});
