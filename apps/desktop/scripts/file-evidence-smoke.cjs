const {mkdtemp,mkdir,writeFile,rm,realpath}=require('node:fs/promises');const {tmpdir}=require('node:os');const {join}=require('node:path');const {randomUUID}=require('node:crypto');const assert=require('node:assert/strict');
const {LocalSourceManager}=require('../dist/source-manager');const {DEFAULT_SOURCE_OPTIONS}=require('../dist/source-types');
(async()=>{const root=await realpath(await mkdtemp(join(tmpdir(),'mote-file-read-e2e-')));let node,manager;try{
 const {buildApp}=await import('../../server/dist/app.js');let reader;
 node=await buildApp({dataDir:join(root,'central'),token:'generated-read-only-evidence-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false},{createModelAgent:async(_s,r)=>{reader=r;return {configured:true,close:async()=>{},query:async()=>({answer:'',citations:[],trace:[],runId:randomUUID()})};}});await node.app.listen({port:0,host:'127.0.0.1'});
 const directory=join(root,'selected');await mkdir(directory);const text='Generated evidence with original quotation. '.repeat(500);await writeFile(join(directory,'fixture.txt'),text);
 manager=new LocalSourceManager(join(root,'device'),{serverUrl:'http://127.0.0.1:'+node.app.server.address().port,token:'generated-read-only-evidence-token',deviceId:'generated-device'},'/never-run-calendar');await manager.initialize();await manager.addFiles(directory,{...DEFAULT_SOURCE_OPTIONS,indexMode:'lightweight',allowRead:true});await manager.sync();
 const parent=node.store.list({source:'file'}).items[0];assert.equal(parent.provenance.document.fileIndex.coverage,'lightweight');assert.equal(node.files.detail(parent.id).hasOriginal,false);
 const pending=reader.readFileEvidence({id:parent.id,offset:9000,length:100});await new Promise(r=>setTimeout(r,50));await manager.sync();const response=await pending;
 assert.equal(response.status,'ready');assert.equal(response.record.ocrText,text.slice(9000,9100));assert.equal(response.record.provenance.document.fileIndex.offset,9000);
 await writeFile(join(directory,'fixture.txt'),'changed content');const second=reader.readFileEvidence({id:parent.id,offset:10000,length:100});
 let superseded=false;
 for(let attempt=0;attempt<20&&!superseded;attempt++){
   await new Promise(r=>setTimeout(r,100));
   await manager.sync();
   superseded=!node.store.isCurrentEvidence(parent.id);
 }
 assert.equal((await second).status,'version_changed');assert.equal(superseded,true);
 console.log('PASS: generated desktop file -> unified index protocol -> central read request -> device authorization/version checks -> exact excerpt -> changed-version invalidation. No personal content or live model.');
}finally{await manager?.close();await node?.app.close();await rm(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
