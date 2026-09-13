import { it, expect } from 'vitest';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ModelStore, QWEN_MODEL, VisionModelStore } from '../dist/index.js';
const require = createRequire(import.meta.url);

it('concurrent independent processes never mutate an already installed model inode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mote-model-processes-'));
  const body = Buffer.from('synthetic-complete-model');
  const spec = { ...QWEN_MODEL.files[0], size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const childPath = join(dir, 'download.cjs');
  await writeFile(childPath, `
    const {ModelStore}=require(${JSON.stringify(require.resolve('../dist/index.js'))});
    const spec=${JSON.stringify(spec)}, bytes=Buffer.from(${JSON.stringify(body.toString())});
    let release; const ready=new Promise(r=>release=r); process.on('message',()=>release());
    const slow=process.argv[2]==='slow';
    const store=new ModelStore(${JSON.stringify(dir)},spec,async()=>slow?new Response(new ReadableStream({async start(c){c.enqueue(bytes.subarray(0,7));await ready;c.enqueue(bytes.subarray(7));c.close();}})):new Response(bytes),1);
    store.download({source:'official',onProgress:p=>{if(slow&&p.bytes===7)process.send('partial');}})
      .then(()=>process.send('done',()=>process.exit(0))).catch(e=>{process.send('error:'+e.message,()=>process.exit(1));});
  `);
  const children: ReturnType<typeof fork>[] = [];
  const launch = (mode: string) => { const child = fork(childPath, [mode], { stdio: ['ignore','ignore','inherit','ipc'] }); children.push(child); return child; };
  const waitFor = (child: ReturnType<typeof fork>, expected: string) => new Promise<void>((resolve, reject) => {
    const onMessage = (m: unknown) => { if (m === expected) { child.off('message', onMessage); resolve(); } else if (String(m).startsWith('error')) reject(new Error(String(m))); };
    child.on('message', onMessage); child.once('error', reject);
  });
  try {
    const slow = launch('slow'); await waitFor(slow, 'partial');
    const fast = launch('fast'); await waitFor(fast, 'done');
    expect((await new ModelStore(dir, spec).inspect()).state).toBe('ready');
    const done = waitFor(slow, 'done'); slow.send('continue'); await done;
    expect((await new ModelStore(dir, spec).inspect()).state).toBe('ready');
  } finally { for (const child of children) child.kill(); await rm(dir, {recursive:true,force:true}); }
}, 15000);

it('two-file Qwen bundles remain unavailable until both hashes match and custom directories map both files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mote-model-bundle-'));
  const payloads = [Buffer.from('synthetic-language'), Buffer.from('synthetic-vision')];
  const manifest = { ...QWEN_MODEL, files: QWEN_MODEL.files.map((f,i) => ({...f,size:payloads[i].length,sha256:createHash('sha256').update(payloads[i]).digest('hex')})), totalBytes: payloads.reduce((n,b)=>n+b.length,0) };
  const urls: string[] = [];
  const store = new VisionModelStore(dir,manifest,async url => { urls.push(String(url)); return new Response(payloads[String(url).endsWith('mmproj.gguf') ? 1 : 0]); },1);
  try {
    const language=join(dir,'external.gguf');await writeFile(language,payloads[0]);await store.importFiles([language]);
    expect((await store.inspect()).state).toBe('partial');await expect(store.verifiedPaths()).rejects.toThrow();
    await store.download({source:'custom',customUrl:'https://nas.example/models/qwen'});
    expect(urls).toEqual(['https://nas.example/models/qwen/mmproj.gguf']);
    expect((await store.inspect()).state).toBe('ready');
    const bad=join(dir,'bad.gguf');await writeFile(bad,Buffer.alloc(payloads[1].length));
    await expect(store.importFiles([language,bad])).rejects.toThrow();
    expect((await store.inspect()).state).toBe('ready');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
