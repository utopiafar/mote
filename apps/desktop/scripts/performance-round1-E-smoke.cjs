require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const assert=require('node:assert/strict');
const {app,nativeImage,BrowserWindow}=require('electron');
const {mkdtempSync,mkdirSync}=require('node:fs');
const {mkdtemp,mkdir,writeFile,rm,readdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const {createServer}=require('node:http');
const {Collector}=require('../dist/collector');
const {DurableQueue}=require('../dist/queue');
const {LocalSourceManager}=require('../dist/source-manager');
const {defaultConfig}=require('../dist/config');
const {DEFAULT_SOURCE_OPTIONS}=require('../dist/source-types');
const profile=mkdtempSync(join(tmpdir(),'mote-E-electron-profile-'));
mkdirSync(join(profile,'session'));
app.setPath('userData',profile);app.setPath('sessionData',join(profile,'session'));
app.whenReady().then(async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-E-electron-data-'));
  let collector,manager;const sent=[];
  const server=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.url,'/api/captures/batch');
      sent.push(...body.captures);res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({results:body.captures.map(item=>({id:item.id,status:201,duplicate:false,receipt:{version:2,id:item.id,kind:'capture',state:'received',duplicate:false}}))}));
    }catch(error){res.writeHead(500);res.end('{}');process.stderr.write(String(error)+'\n');}
  });
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const config={...defaultConfig(),serverUrl:'http://127.0.0.1:'+server.address().port,token:'generated-only',syncMode:'manual',packedUpload:true};
    const queue=new DurableQueue(join(directory,'queue'),config);await queue.initialize();
    const image=nativeImage.createFromBitmap(Buffer.alloc(64,120),{width:4,height:4}).toJPEG(70);
    const ids=[randomUUID(),randomUUID(),randomUUID()];
    for(const id of ids)await queue.enqueue({id,deviceId:config.deviceId,deviceName:'Generated E Electron',platform:'macos',capturedAt:'2026-10-20T00:00:00.000Z',durationMs:0,appId:'dev.mote.generated',appName:'Generated E',source:'screen',imageMime:'image/jpeg',ocrText:'GENERATED',privacy:{excluded:false,redacted:true,mode:'local',reason:'Generated pixels only'}},image);
    assert.equal((await readdir(join(directory,'queue','blobs'))).length,1);
    let selections=0;const select=queue.nextBatch.bind(queue);queue.nextBatch=async(...args)=>{selections++;return select(...args);};
    const diagnostics={status:()=>({enabled:false}),recordUpload:()=>{throw Error('Disabled diagnostic work');},close:async()=>{}};
    collector=new Collector(config,queue,'/never-run-native',()=>true,()=>{},diagnostics);
    await collector.upload(true);assert.equal(queue.stats().depth,0);assert.equal(selections,1);
    assert.deepEqual(sent.map(item=>item.id),ids);assert(sent.every(item=>item.imageBase64===image.toString('base64')));
    const reopened=new DurableQueue(join(directory,'queue'),config);await reopened.initialize();assert.equal(reopened.stats().depth,0);
    const selected=join(directory,'generated-files');await mkdir(selected);
    for(const name of ['a.txt','b.txt'])await writeFile(join(selected,name),'Generated file input');
    manager=new LocalSourceManager(join(directory,'sources'),{serverUrl:'',token:'',deviceId:config.deviceId},'/never-run-native',true);
    await manager.initialize();await manager.addFiles(selected,DEFAULT_SOURCE_OPTIONS);await manager.sync();
    assert.equal(manager.pendingStats().pendingRecords,2);assert.equal(manager.status()[0].scanComplete,true);
    assert.equal(BrowserWindow.getAllWindows().length,0);
    process.stdout.write(JSON.stringify({ok:true,generatedOnly:true,electron:process.versions.electron,packedSelections:selections,sharedImages:3,queueACKAndRestart:true,managerAddFilesAndSync:true,windowsCreated:0,realCapture:false})+'\n');
  }finally{
    await manager?.close();collector?.shutdown();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});await rm(profile,{recursive:true,force:true});
  }
}).then(()=>app.quit()).catch(error=>{process.stderr.write(String(error.stack??error)+'\n');app.exit(1);});
