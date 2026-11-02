require('../../../scripts/fixture-background.cjs');
const {app,BrowserWindow}=require('electron');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');const {tmpdir}=require('node:os');const {join,resolve}=require('node:path');
const {execFileSync}=require('node:child_process');const {createServer}=require('node:http');
const assert=require('node:assert/strict');
const repo=resolve(__dirname,'../../..'),temporary=mkdtempSync(join(tmpdir(),'mote-u08-page-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const nonce='nonce-'+Math.random().toString(36).slice(2),documentKey='key-'+Math.random().toString(36).slice(2);
const requestEnvelope=(key,id='r-preload',mark)=>JSON.stringify({contractVersion:'1',nonce,documentKey:key,instanceId:'inst:one',generation:1,requestId:id,kind:'request',method:'read',...(mark?{payload:{mark}}:{})});
execFileSync(join(repo,'node_modules/.bin/esbuild'),['apps/web/test/custom-page-harness.tsx','--bundle','--format=iife','--outfile='+join(temporary,'bundle.js'),'--jsx=automatic'],{cwd:repo});
const hits={};const files={
 '/harness.html':{type:'text/html'},
 '/entry1.html':{type:'text/html',body:`<script>new Image().src='/ran1';addEventListener('message',e=>{if(e.data&&e.data.kind==='channel'){const port=e.ports[0];setTimeout(()=>{window.location.href='/entry2.html';},120);port.postMessage(${requestEnvelope(documentKey)});}});</script>`},
 // The replacement reuses the leaked nonce but never learns the rotated
 // document key — it posts BEFORE its own load event.
 // The replacement holds the leaked nonce+documentKey but never received a
// port — its window.postMessage requests have no carrier. It also listens
// for stray response messages and reports its own reception to the host.
'/entry2.html':{type:'text/html',body:`<script>new Image().src='/ran2';
window.received=[];
addEventListener('message',e=>window.received.push(e.data));
setTimeout(()=>{parent.postMessage({kind:'fixture-report',received:window.received.length},'*');},900);
parent.postMessage(${requestEnvelope(documentKey,'r-replacement','e2')},'*');
</script>`},
};
async function run(){
 const server=createServer((req,res)=>{hits[req.url]=(hits[req.url]||0)+1;
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
 await pause(1200);console.log('PROBE',await js('JSON.stringify({html:document.body.innerHTML.slice(0,160),calls:JSON.stringify(window.calls),got:JSON.stringify(window.got),srcMatch:window.srcMatch,rejected:window.rejected})'),'HITS',JSON.stringify(hits));
await until(()=>js(`!!document.querySelector('iframe.plugin-custom-page')`),'component mounted');
 await until(()=>js(`window.calls&&window.calls.length>=1`),'first document invocation');
 await pause(800); // entry1 navigates at 120 ms; the invoke resolves at ~400 ms
 const calls=await js('window.calls'),posted=await js('JSON.stringify(window.got||[])');
 assert.equal(calls.length,1,'only the issued document invoked — the pre-load replacement request never reached the invoker: '+JSON.stringify(calls));
 const got=JSON.parse(posted),responses=got.filter(m=>m&&m.kind==='response');
 assert.equal(responses.length,0,'the in-flight response was fenced by revocation — nothing leaked to the replacement');
 return window;}
run().then(async window=>{console.log(JSON.stringify({passed:true}));window.destroy();rmSync(temporary,{recursive:true,force:true});app.exit(0);}).catch(async error=>{console.error(error);rmSync(temporary,{recursive:true,force:true});app.exit(1);});
