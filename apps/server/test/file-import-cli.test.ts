import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp,mkdir,open,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('file CLI preview matches authenticated archive receipt and bytes above the 16 MiB shard boundary',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-file-cli-'))),selected=join(root,'selected'),profile=join(root,'profile'),temporary=join(root,'temporary');
 let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 t.after(async()=>{await node?.app.close();await rm(root,{recursive:true,force:true});});
 for(const path of [selected,profile,temporary])await mkdir(path,{mode:0o700});
 const MiB=1024*1024,expected=new Map<string,{size:number;sha256:string;modifiedAt:string}>();
 for(const [title,size] of [['small.m4a',1024],['large.m4a',16*MiB+1],['oversized.m4a',512*MiB+1]] as const){
  const path=join(selected,title),handle=await open(path,'wx',0o600);
  try{
   await handle.truncate(size);await handle.write(Buffer.from('Generated '+title));
   if(size<=512*MiB){
    const digest=createHash('sha256');for await(const bytes of createReadStream(path))digest.update(bytes);
    expected.set(title,{size,sha256:digest.digest('hex'),modifiedAt:(await handle.stat()).mtime.toISOString()});
   }
  }finally{await handle.close();}
 }
 const token='generated-file-cli-owner',config:Config={dataDir:join(root,'central'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:100*MiB,maxExportBytes:MiB,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',contentEncryptionEnabled:true,dataKey:'74'.repeat(32)};
 node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model authorized for generated CLI fixtures');},close:async()=>{}}});
 const requests:{url:string;authorization:string|undefined;version:string|string[]|undefined}[]=[];
 node.app.addHook('onRequest',async request=>{requests.push({url:request.url,authorization:request.headers.authorization,version:request.headers['x-mote-ingress-version']});});
 const url=await node.app.listen({host:'127.0.0.1',port:0}),configFile=join(profile,'mote.yaml');
 await writeFile(configFile,`version: 1\nrevision: 0\nserver:\n  profile: test\n  host: 127.0.0.1\n  port: ${new URL(url).port}\n  token: ${token}\n`,{mode:0o600});
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_'))),MOTE_CONFIG_FILE:configFile,TMPDIR:temporary,TSX_DISABLE_CACHE:'1'};
 const script=fileURLToPath(new URL('../../../scripts/import-files.ts',import.meta.url)),cwd=fileURLToPath(new URL('../../../',import.meta.url));
 const run=(...args:string[])=>promisify(execFile)(process.execPath,['--import','tsx',script,'--root',selected,...args],{cwd,env});
 await assert.rejects(run('--retention','snapshot'),/Confirm with --allow-transient-upload/);
 const preview=await run('--retention','archive','--dry-run');
 assert.match(preview.stdout,/Would send 2 changed files; skipped 1; deletion scan not applied\./);
 assert.equal(requests.length,0,'preview and missing snapshot consent must not contact Central');
 assert.deepEqual(await readdir(profile),['mote.yaml']);assert.deepEqual(await readdir(temporary),[]);
 const imported=await run('--retention','archive');
 assert.match(imported.stdout,/Received 2 changed files; skipped 1; deletion scan not applied\./);
 assert.ok(requests.length>0);assert.ok(requests.every(request=>request.authorization==='Bearer '+token&&request.version==='2'));
 assert.equal(requests.filter(request=>/\/parts\/\d+$/.test(request.url)).length,6,'large audio must traverse five real upload parts plus the small file part');
 const versions=node.store.db.prepare('SELECT capture_id,manifest FROM file_versions').all();assert.equal(versions.length,2);
 for(const row of versions){
  const manifest=JSON.parse(String(row.manifest)),item=manifest.item,wanted=expected.get(item.title);assert.ok(wanted);
  assert.equal(manifest.sizeBytes,wanted.size);assert.equal(manifest.sha256,wanted.sha256);assert.equal(item.metadata.file.sizeBytes,wanted.size);assert.equal(item.modifiedAt,wanted.modifiedAt);
  assert.equal(item.mimeType,'audio/mp4');assert.equal(item.uri,pathToFileURL(join(selected,item.title)).href);assert.equal(item.text,'');assert.equal(item.layer,'original');
  assert.equal(item.localOriginal,undefined);assert.equal(item.localOriginalBase64,undefined);
  assert.equal(node.sources.getItem(manifest.sourceId,item.externalId)?.captureId,String(row.capture_id));
  const digest=createHash('sha256');let bytes=0;
  for(const part of node.files.bytes(String(row.capture_id))){assert.ok(part.length<=4*MiB);digest.update(part);bytes+=part.length;}
  assert.equal(bytes,wanted.size);assert.equal(digest.digest('hex'),wanted.sha256);
 }
 const repeated=await run('--retention','archive');
 assert.match(repeated.stdout,/Received 0 changed files; skipped 1; deletion scan not applied\./);
 assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM file_versions').get()!.n,2);
});
