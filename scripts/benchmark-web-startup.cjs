const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
// Explicit fixture input only. All API traffic stays on the supplied loopback fixture central.
const {parseArgs}=require('node:util');
const {values}=parseArgs({options:{comparison:{type:'string'},connection:{type:'string'},out:{type:'string'},'generated-fixture':{type:'boolean'}}});
if(!values.comparison||!values.connection||!values.out||!values['generated-fixture'])throw Error('Pass --comparison, --connection, --out and --generated-fixture');
const config=JSON.parse(fs.readFileSync(values.comparison)),fixture=JSON.parse(fs.readFileSync(values.connection));
const fixtureUrl=new URL(fixture.server);
if(fixtureUrl.protocol!=='http:'||!['127.0.0.1','localhost'].includes(fixtureUrl.hostname)||fixtureUrl.username||fixtureUrl.password)throw Error('Dedicated loopback fixture central required');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'mote-paint-'));app.setPath('userData',scratch);app.on('window-all-closed',()=>{});
let directory=config.currentDirectory;
const server=http.createServer(async(req,res)=>{try{if(req.url.startsWith('/api/')){const result=await fetch(fixture.server+req.url,{headers:{Authorization:'Bearer '+fixture.ownerToken},signal:AbortSignal.timeout(10000)});res.writeHead(result.status,{'Content-Type':result.headers.get('content-type')??'application/json'});res.end(Buffer.from(await result.arrayBuffer()));return;}
 const name=decodeURIComponent(req.url.split('?')[0]);const file=path.join(directory,name==='/'?'index.html':name);if(!file.startsWith(directory+path.sep)){res.writeHead(404);res.end();return;}
 const mime=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html';res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(fs.readFileSync(file));}catch(error){res.writeHead(500);res.end('Generated fixture failed');}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{await app.whenReady();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;const samples=[];
 for(let round=0;round<5;round++)for(const variant of ['baseline','current']){directory=config[variant+'Directory'];const w=new BrowserWindow({show:false,width:1360,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'fixture-'+round+'-'+variant}}),wc=w.webContents;try{
 await w.loadURL(url);await wc.executeJavaScript(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({url:'',token:fixture.ownerToken}))});true`);await wc.session.clearCache();await new Promise(resolve=>{wc.once('did-finish-load',resolve);wc.reloadIgnoringCache();});
 const end=Date.now()+20000;let ready=false;
 while(Date.now()<end){try{ready=await wc.executeJavaScript(`!!document.querySelector('.capture-card')&&document.body.innerText.includes('已登录 ·')`);}catch{}if(ready)break;await pause(20);}if(!ready)throw Error('Generated home did not load');
 const metrics=await wc.executeJavaScript(`(()=>{const p=performance.getEntriesByType('paint');const n=performance.getEntriesByType('navigation')[0];return {readyMs:performance.now(),fcpMs:p.find(p=>p.name==='first-contentful-paint')?.startTime??null,domInteractiveMs:n.domInteractive,jsBytes:performance.getEntriesByType('resource').filter(r=>r.name.includes('/assets/')&&r.name.endsWith('.js')).reduce((n,r)=>n+r.decodedBodySize,0)};})()`);samples.push({round,variant,...metrics});
 }finally{w.destroy();}}
 fs.writeFileSync(values.out,JSON.stringify({fixtureOnly:true,environment:'Electron offscreen Chromium, 1360x1000, loopback, same generated central archive, five alternating cold-cache rounds',samples},null,2));console.log('Generated frontend comparison completed');
})().then(()=>{server.close();fs.rmSync(scratch,{recursive:true,force:true});app.exit(0);},e=>{console.error(e.stack);server.close();app.exit(1);});
