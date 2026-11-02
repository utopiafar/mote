require('../../../scripts/fixture-background.cjs');
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');
const {execFileSync}=require('node:child_process');const {createServer}=require('node:http');
const assert=require('node:assert/strict');
const repo=resolve(__dirname,'../../..'),temporary=mkdtempSync(join(tmpdir(),'mote-u08-page-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// History: an earlier bridge-enabled run proved a deliberately transferred
// port keeps the document's authority until the next load (calls=2) —
// the open web has no pre-commit revocation signal for opaque frames, so
// this component ships render-only and issues no channel until a
// verified platform-owned navigation guard exists.
let releaseSlow;const slowGate=new Promise(r=>{releaseSlow=r});
const nonce='nonce-'+Math.random().toString(36).slice(2),documentKey='key-'+Math.random().toString(36).slice(2);
const requestEnvelope=(key,id='r-preload',mark)=>JSON.stringify({contractVersion:'1',nonce,documentKey:key,instanceId:'inst:one',generation:1,requestId:id,kind:'request',method:'read',...(mark?{payload:{mark}}:{})});
execFileSync(join(repo,'node_modules/.bin/esbuild'),['apps/web/test/custom-page-harness.tsx','--bundle','--format=iife','--outfile='+join(temporary,'bundle.js'),'--jsx=automatic'],{cwd:repo});
const hits={};const files={
 '/harness.html':{type:'text/html'},
 '/entry1.html':{type:'text/html',body:`<script>new Image().src='/ran1';
// The entry still tries its leaked-key request and navigates itself —
// and reports every channel envelope or port it was actually handed.
let channels=0,ports=0;
addEventListener('message',e=>{if(e.data&&e.data.kind==='channel')channels++;ports+=e.ports.length;});
setTimeout(()=>{parent.postMessage({kind:'entry1-report',channels,ports},'*');window.location.href='/entry2.html';},120);
parent.postMessage(${requestEnvelope(documentKey)},'*');
</script>`},
 // The replacement reuses the leaked nonce but never learns the rotated
 // document key — it posts BEFORE its own load event.
 // The replacement holds the leaked nonce+documentKey but never received a
// port — its window.postMessage requests have no carrier. Its own load is
// held by a slow subresource until AFTER the old invocation settles, so
// the request provably runs before its load event.
'/entry2.html':{type:'text/html',body:`<script>new Image().src='/ran2';
window.received=[];
addEventListener('message',e=>window.received.push(e.data));
parent.postMessage(${requestEnvelope(documentKey,'r-replacement','e2')},'*');
window.addEventListener('load',()=>{parent.postMessage({kind:'fixture-report',received:window.received.length,channels:window.received.filter(m=>m&&m.kind==='channel').length},'*');});
</script><img src="/slow">`},
};
async function run(){
 const server=createServer((req,res)=>{hits[req.url]=Date.now();
  if(req.url==='/slow'){res.setHeader('content-type','image/gif');slowGate.then(()=>{hits['/slow-served']=Date.now();res.end(Buffer.from('R0lGODlhAQABAAAAACw=','base64'));});return;}
  if(req.url==='/harness.html'){res.setHeader('content-type','text/html');res.end(`<!doctype html><div id="root"></div><script>window.__HARNESS__=${JSON.stringify({nonce,documentKey})};</script><script src="/bundle.js"></script>`);return;}
  if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');res.end(require('node:fs').readFileSync(join(temporary,'bundle.js')));return;}
  const entry=files[req.url];if(!entry){res.statusCode=404;res.end();return;}
  res.setHeader('content-type',entry.type);res.end(entry.body);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 await app.whenReady();
 const window=new BrowserWindow({width:900,height:700,show:false,webPreferences:{sandbox:false,nodeIntegration:false,contextIsolation:true}});
 // The entry URL is only bound after the port exists — regenerate the
 // harness page's config through a serving-time global instead.
 await window.loadURL(`http://127.0.0.1:${port}/harness.html`);
 window.webContents.on('console-message',e=>console.log('[ui]',e.message.slice(0,300)));const js=code=>window.webContents.executeJavaScript(code);
 const until=async(fn,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await pause(80);}throw Error('timed out: '+label);};
await until(()=>js(`!!document.querySelector('iframe.plugin-custom-page')`),'component mounted');
 // Fail-closed: the component renders the entry but issues no channel —
 // entry1 still posts its leaked-key request and navigates itself; the
 // replacement posts pre-load while its load is held. No carrier exists
 // for any of them: invokeCalls must stay zero and the replacement
 // itself must observe zero responses.
 await until(()=>hits['/ran2']&&hits['/slow'],'replacement ran and its load is held');
 assert.ok(!hits['/slow-served'],'replacement load is still held');
 releaseSlow();
 await until(()=>js('window.got&&window.got.some(m=>m&&m.kind==="fixture-report")'),'replacement reports its own observation');
 await pause(150);
 const channelsCreated=await js('window.channelsCreated'),posted=await js('JSON.stringify(window.got||[])');
 const got=JSON.parse(posted);
 assert.equal(channelsCreated,0,'the host constructed zero MessageChannels');
 const entry1=got.find(m=>m&&m.kind==='entry1-report');
 assert.ok(entry1&&entry1.channels===0&&entry1.ports===0,'the issued document received no channel or port: '+JSON.stringify(entry1));
 const report=got.find(m=>m&&m.kind==='fixture-report');
 assert.ok(report,'the replacement reported its own observation');
 assert.equal(report.received,0,'no channel or response reached the replacement: '+JSON.stringify(got));
 assert.equal(report.channels,0,'the replacement received no channel envelope');
 return window;}
run().then(async window=>{console.log(JSON.stringify({passed:true}));window.destroy();rmSync(temporary,{recursive:true,force:true});app.exit(0);}).catch(async error=>{console.error(error);rmSync(temporary,{recursive:true,force:true});app.exit(1);});
