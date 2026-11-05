require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const {app,safeStorage,ipcMain}=require('electron');
const {createServer}=require('node:http');
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {defaultConfig}=require('../dist/config');
const {DurableQueue}=require('../dist/queue');
const {QueueStorage}=require('../dist/queue-storage');
const profile=mkdtempSync(join(tmpdir(),'mote-final-library-'));
app.setPath('userData',profile);process.env.MOTE_PROFILE='dev';
for(const key of ['MOTE_URL','MOTE_TOKEN','MOTE_ENV_FILE'])delete process.env[key];
safeStorage.isEncryptionAvailable=()=>{throw Error('Dev fixture must not access safeStorage');};
let directory=join(profile+'-profiles','dev');mkdirSync(directory,{recursive:true,mode:0o700});directory=realpathSync(directory);
const output=resolve(__dirname,'../../../.mote/final-ui-product/library');mkdirSync(output,{recursive:true});
const implementation={revision:execFileSync('git',['rev-parse','HEAD'],{cwd:resolve(__dirname,'../../..')}).toString().trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:resolve(__dirname,'../../..')}).toString().trim()),loadedFiles:Object.fromEntries(['main.js','ui-bundle.js','index.html','styles.css'].map(file=>[file,createHash('sha256').update(readFileSync(resolve(__dirname,'../dist',file))).digest('hex')]))};
const token='generated-library-owner-token-'.repeat(3),remoteId=randomUUID();
let config,main,deny=false,readFailure=false,finished=false;
const captures=[],requests=[],errors=[];
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,(event,...args)=>{if(channel==='mote:content-local'&&readFailure)throw Error('Generated local read failure');return handler(event,...args);});
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://fixture');requests.push({method:req.method,url:req.url});res.setHeader('content-type','application/json');assert.equal(req.headers.authorization,'Bearer '+token);
  const row={id:remoteId,deviceId:config.deviceId,deviceName:'这台 Mac',source:'note',capturedAt:'2026-10-29T11:00:00.000Z',appName:'中央评审记录',ocrText:'中央保存的原文\nGenerated remote original <script>literal</script>',attributionContext:{recordContextStatements:[{captureId:remoteId,version:1,description:'中央记录的独立说明'}]}};
  if(url.pathname==='/api/capture-browser'||url.pathname==='/api/context/search'){
    assert.equal(url.searchParams.get('deviceId'),config.deviceId);if(deny){res.statusCode=403;res.end('{}');return;}
    if(url.pathname==='/api/context/search'){const query=url.searchParams.get('query');res.end(JSON.stringify({items:query==='中央'?[{id:remoteId,ref:'capture:'+remoteId,title:row.appName,snippet:row.ocrText,origin:{deviceId:config.deviceId,source:'note',capturedAt:row.capturedAt}}]:[],nextCursor:null}));}
    else res.end(JSON.stringify({items:[row],totalCount:1,nextCursor:null}));return;
  }
  if(url.pathname==='/api/capture-browser/'+remoteId){res.end(JSON.stringify(row));return;}
  if(url.pathname==='/api/conversations'||url.pathname==='/api/query-runs'){res.end('{"items":[]}');return;}
  if(url.pathname==='/api/connections/self'){res.end(JSON.stringify({credential:{id:'fixture',scope:'owner'},node:{version:'fixture',profile:'fixture',protocol:{min:1,max:1}},capabilities:{ingest:true,ownSources:true,archiveRead:true}}));return;}
  res.statusCode=404;res.end('{}');
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,label)=>{for(let i=0;i<400;i++){if(await check())return;await delay(25);}throw Error('Timed out: '+label);};
const timeout=setTimeout(()=>{console.error('Final library fixture timed out');app.exit(1);},60000);
app.on('browser-window-created',(_event,window)=>{
  if(main)return;main=window;window.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  window.webContents.once('did-finish-load',()=>void(async()=>{
    const js=code=>window.webContents.executeJavaScript(code);
    const shot=async(name)=>{await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const image=await window.webContents.capturePage(),file=join(output,name+'.png');writeFileSync(file,image.toPNG());captures.push({name,file,pixels:image.getSize(),viewport:await js('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,searchHeight:document.querySelector(".content-search").getBoundingClientRect().height})'),at:new Date().toISOString()});};
    const search=async value=>{await js('document.querySelector("#content-search").value='+JSON.stringify(value)+';document.querySelector("#content-search").dispatchEvent(new Event("input",{bubbles:true}))');await delay(230);await until(()=>js('document.querySelector("#content-status").getAttribute("aria-busy")==="false"'),'query completes');};
    await until(()=>js('!!document.querySelector("[data-presentation-nav]")&&!document.querySelector("#settings-fields").disabled'),'ready');assert.equal(window.isVisible(),false);window.setContentSize(1440,936);
    await js('document.querySelector("aside [data-nav=records]").click()');await until(()=>js('document.querySelectorAll("#content-feed .content-row").length===31'),'first page');assert.equal(await js('document.querySelector(".content-search").getBoundingClientRect().height'),37);await shot('content');
    await js('window.scrollTo(0,450);document.querySelectorAll("#content-feed .content-row")[8].click()');await until(()=>js('!document.querySelector("[data-page=content-reader]").hidden&&document.querySelector("#content-detail-body").textContent.includes("原文")'),'inline local reader');
    assert.equal(await js('document.querySelector("#content-detail-dialog").matches(":modal")'),false);assert.equal(await js('document.querySelector("#content-processing").open'),false);await shot('local-reader');
    await js('document.querySelector("#content-detail-close").click()');assert.equal(await js('window.scrollY'),450);assert.equal(await js('document.querySelectorAll("#content-feed .content-row").length'),31);
    await js('window.scrollTo(0,0);document.querySelector("[data-content-scope=local]").click()');await until(()=>js('document.querySelectorAll("#content-feed .content-row").length===30'),'local scope');await search('旧记录');
    assert.equal(await js('document.querySelectorAll("#content-feed .content-row").length'),1);assert.equal(await js('document.querySelector("[data-content-scope=local]").getAttribute("aria-pressed")'),'true');await shot('content-search');
    await js('document.querySelector("#content-feed .content-row").click()');await until(()=>js('document.querySelector("#content-detail-description").textContent==="本机生成记录的独立说明"'),'local description');
    assert.equal(await js('document.querySelector("#content-detail-body").textContent.includes("本机生成记录的独立说明")'),false);assert.equal(await js('document.querySelector("#content-detail-body script")'),null);
    await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');assert.equal(await js('document.querySelector("[data-page=records]").hidden'),false);assert.equal(await js('document.querySelector("#content-search").value'),'旧记录');assert.equal(await js('document.querySelectorAll("#content-feed .content-row").length'),1);
    await search('没有这种记录');assert.equal(await js('document.querySelector("#content-feed").textContent'),'没有符合条件的内容');await shot('content-no-match');
    await search('中央');await js('document.querySelector("[data-content-scope=received]").click()');await until(()=>js('document.querySelectorAll("#content-feed .content-row").length===1'),'remote search');await js('document.querySelector("#content-feed .content-row").click()');await until(()=>js('document.querySelector("#content-detail-description").textContent==="中央记录的独立说明"'),'remote reader');await shot('central-reader');
    deny=true;await js('document.querySelector("#content-refresh").click()');await until(()=>js('document.querySelector("[data-page=content-reader]").hidden'),'revocation closes reader');assert.equal(await js('document.querySelector("#content-detail-body").textContent'),'');assert.equal(await js('document.querySelectorAll("#content-feed .content-row").length'),0);assert.equal(await js('document.querySelector("#content-feed").textContent'),'', 'Denied archive must not be presented as empty');await shot('content-denied');
    deny=false;await js('document.querySelector("[data-content-scope=local]").click()');await search('旧记录');readFailure=true;await js('document.querySelector("#content-refresh").click()');await until(()=>js('document.querySelector("#content-status").textContent.includes("内容暂不可完整读取")'),'read failure');assert.equal(await js('document.querySelectorAll("#content-feed .content-row").length'),1);await shot('content-read-error');
    readFailure=false;await js('document.querySelector("#content-refresh").click()');await until(()=>js('document.querySelector("#content-status").classList.contains("visually-hidden")'),'retry');
    window.setContentSize(820,620);await shot('content-compact');assert(await js('document.documentElement.scrollWidth<=innerWidth'));assert.deepEqual(errors,[]);assert(requests.some(r=>r.url.startsWith('/api/context/search?')));assert.equal((await js('window.mote.status()')).running,false);
    writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,implementation,generatedOnly:true,hidden:true,electron:process.versions.electron,palette:'9bf780ac',realRendererPreloadIpc:true,liveModel:false,checks:['all device-scoped pages','search beyond first 30 queue items','existing central search endpoint','inline reader exact body/description','back and Escape preserve query/filter/scroll','no match','denial clears central reader','temporary local read preserves known rows','retry','compact no horizontal overflow'],captures},null,2));finished=true;clearTimeout(timeout);console.log(JSON.stringify({passed:true,output,captures:captures.length}));app.quit();
  })().catch(error=>{console.error(error.stack);console.error(errors);clearTimeout(timeout);app.exit(1);}));
});
app.on('window-all-closed',()=>{if(!finished)app.exit(1);});
app.on('quit',()=>{server.close();rmSync(profile,{recursive:true,force:true});rmSync(profile+'-profiles',{recursive:true,force:true});});
server.listen(0,'127.0.0.1',()=>void(async()=>{
  config={...defaultConfig(),serverUrl:'http://127.0.0.1:'+server.address().port,deviceName:'这台 Mac',metadataEnabled:false,syncMode:'manual',credentialScope:'owner'};
  writeFileSync(join(directory,'config.json'),JSON.stringify({version:4,developmentToken:token,config}),{mode:0o600});writeFileSync(join(directory,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});
  const storage=new QueueStorage(directory,'dev',config.deviceId),queue=new DurableQueue(await storage.open(''),config);await queue.initialize();
  for(let i=0;i<45;i++)await queue.enqueue({id:randomUUID(),deviceId:config.deviceId,deviceName:config.deviceName,platform:'macos',source:'note',capturedAt:new Date(Date.UTC(2026,9,29,9,i)).toISOString(),appId:'dev.mote.notes',appName:'记录',durationMs:0,ocrText:(i===0?'旧记录':'评审准备 '+i)+'\n原文 Generated original <script>literal</script>',metadata:{version:1,observedAt:'2026-10-29T00:00:00.000Z',collector:{method:'manual'},ownerDescription:'本机生成记录的独立说明'},privacy:{excluded:false,redacted:false,mode:'none'}});
  require('../dist/main');
})().catch(error=>{console.error(error.stack);app.exit(1);}));
