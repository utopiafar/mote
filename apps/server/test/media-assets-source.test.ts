import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MEDIA_CATALOG,MediaAssets} from '../src/media-assets.js';

test('automatic dialogue installation succeeds through the mirror when the official source is unreachable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-model-source-')),original=MEDIA_CATALOG.dialogue,data=Buffer.from('generated model bytes');
 const names=['config.json','model.bin','tokenizer.json','vocabulary.txt','segmentation.onnx','speaker.onnx'];
 MEDIA_CATALOG.dialogue={version:'generated-source-fallback',files:names.map(name=>({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),official:`https://huggingface.co/generated/${name}`,mirror:`https://hf-mirror.com/generated/${name}`}))};
 const hosts:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0])=>{
  const host=new URL(String(input)).hostname;hosts.push(host);
  if(host==='huggingface.co')throw Error('official source unavailable');
  return new Response(data);
 });
 const assets=new MediaAssets(root);
 t.after(async()=>{await assets.close();MEDIA_CATALOG.dialogue=original;await rm(root,{recursive:true,force:true});});
 await assert.rejects(assets.installAsync('dialogue','official'));
 assert.equal(assets.ready('dialogue'),false);
 await assets.installAsync('dialogue','auto');
 assert.equal(assets.ready('dialogue'),true);
 assert.deepEqual([...new Set(hosts)],['huggingface.co','hf-mirror.com']);
});
