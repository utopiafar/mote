// Actual desktop source manager, workers and central HTTP/SQLite; generated files only.
const {mkdtemp,mkdir,writeFile,rm,realpath}=require('node:fs/promises');
const {tmpdir}=require('node:os');const {join}=require('node:path');const {createHash}=require('node:crypto');const assert=require('node:assert/strict');
const {LocalSourceManager}=require('../apps/desktop/dist/source-manager');const {DEFAULT_SOURCE_OPTIONS}=require('../apps/desktop/dist/source-types');
(async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-fair-upload-')));let node,manager;
 try{
  const {buildApp}=await import('../apps/server/dist/app.js');
  node=await buildApp({dataDir:join(root,'central'),token:'generated-fair-upload-token-000000000',tokenPath:'unused',host:'127.0.0.1',port:0,maxStorageBytes:200*1024*1024,maxExportBytes:30*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'});
  const sequence=[];node.app.addHook('onResponse',async(req,reply)=>{if(reply.statusCode>=400)throw Error('Fixture request failed '+reply.statusCode);if(req.url.includes('/parts/'))sequence.push('part:'+req.url.split('/').at(-1));if(req.url==='/api/file-sync/v1/manifests')sequence.push('small-manifest');if(req.url.endsWith('/commit'))sequence.push('commit');});
  await node.app.listen({host:'127.0.0.1',port:0});
  const large=join(root,'large'),small=join(root,'small');await mkdir(large);await mkdir(small);
  const bytes=Buffer.alloc(20*1024*1024+13,76);await writeFile(join(large,'history.txt'),bytes);
  for(let start=0;start<400;start+=40)await Promise.all(Array.from({length:40},(_,j)=>writeFile(join(small,`note-${String(start+j).padStart(3,'0')}.txt`),`Generated note ${start+j}; recorded ${new Date(Date.UTC(2025,0,1+start+j)).toISOString()}. No personal content.`)));
  manager=new LocalSourceManager(join(root,'device'),{serverUrl:node.app.listeningOrigin,token:'generated-fair-upload-token-000000000',deviceId:'generated-device',syncMode:'manual'},'/never-run-calendar',true);
  await manager.initialize();await manager.addFiles(large,{...DEFAULT_SOURCE_OPTIONS,retention:'archive'});await manager.sync();await manager.addFiles(small,{...DEFAULT_SOURCE_OPTIONS,retention:'snapshot'});await manager.sync();
  assert.equal(manager.pendingStats().pendingRecords,401);let turns=0;
  await manager.flushPending(new AbortController().signal,async()=>{turns++;});
  assert.equal(manager.pendingStats().pendingRecords,0);assert.equal(Number(node.store.db.prepare('SELECT count(*) n FROM file_heads').get().n),401);
  assert.equal(sequence[0],'part:0');assert.ok(sequence.indexOf('small-manifest')>0&&sequence.indexOf('small-manifest')<sequence.indexOf('part:1'));assert.ok(sequence.indexOf('commit')>sequence.indexOf('small-manifest'));assert.ok(turns>=6);
  const row=node.store.db.prepare('SELECT capture_id FROM file_versions WHERE object_hash IS NOT NULL').get();assert.ok(row);
  const digest=createHash('sha256');for await(const part of node.files.bytes(row.capture_id))digest.update(part);assert.equal(digest.digest('hex'),createHash('sha256').update(bytes).digest('hex'));
  console.log(JSON.stringify({ok:true,generatedFiles:401,largeBytes:bytes.length,turns,sequence,personalDataUsed:false,realModelCalls:0,transport:'actual loopback HTTP with production desktop source manager and central'}));
 }finally{await manager?.close();await node?.app.close();await rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
