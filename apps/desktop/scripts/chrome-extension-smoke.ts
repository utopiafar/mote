/** Hidden real-Chrome + shipped MV3 worker + native host + collector-provider journey.
 * Only the unavailable macOS foreground/AX boundary is a generated helper fixture.
 * Run from repository root: node --import tsx apps/desktop/scripts/chrome-extension-smoke.ts
 */
import {mkdtemp,mkdir,cp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {ChromeCaptureBridge} from '../src/chrome-bridge';
import type {BrowserCaptureProvider,BrowserCaptureRequest} from '../src/browser-capture';
import type {BrowserNativeContext} from '../src/chrome-protocol';
import {CHROME_EXTENSION_ID,CHROME_NATIVE_HOST} from '../src/chrome-constants';
const repository=resolve(__dirname,'../../..');
const chrome=process.env.MOTE_FIXTURE_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ownedRoots=new Set<string>();
export async function createChromeFixtureRoot(){const root=await mkdtemp(join(tmpdir(),'mote-chrome-journey-'));ownedRoots.add(root);return root;}
export function observeFixtureBrowser(child:ChildProcess){
 let ended=false,error:unknown;
 const closed=new Promise<void>(resolve=>child.once('close',()=>{ended=true;resolve();}));
 child.on('error',cause=>{error=cause;});
 return{child,closed,isClosed:()=>ended,error:()=>error};
}
type FixtureCleanup={root:string;browser?:ReturnType<typeof observeFixtureBrowser>;requestBrowserClose?:()=>void;sessions:readonly {close:()=>void|Promise<void>}[];bridge?:{close:()=>Promise<void>};closeServer:()=>Promise<void>;preserveRoot?:boolean;removeRoot?:(root:string)=>Promise<void>};
async function within<T>(work:Promise<T>,label:string,ms:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}
}
export async function cleanupChromeFixture({root,browser,requestBrowserClose,sessions,bridge,closeServer,preserveRoot=false,removeRoot=(path:string)=>rm(path,{recursive:true,force:true})}:FixtureCleanup){
 if(!ownedRoots.has(root))throw Error('Refusing cleanup of unowned fixture directory: '+root);
 const failures:unknown[]=[];
 const attempt=async(label:string,work:()=>void|Promise<void>)=>{try{await within(Promise.resolve().then(work),label,2000);}catch(error){failures.push(error);}};
 if(browser){
  const child=browser.child,running=()=>child.pid!==undefined&&child.exitCode===null&&child.signalCode===null;
  const terminate=()=>{if(running()&&!child.kill('SIGTERM')&&running())throw Error('Cannot signal owned Chrome PID '+child.pid);};
  try{
   if(!browser.isClosed()){
    if(requestBrowserClose&&running()){
     try{requestBrowserClose();}catch(error){failures.push(error);}
     try{await within(browser.closed,'Owned Chrome graceful close did not finish',2000);}catch{terminate();}
     await within(browser.closed,'Owned Chrome PID '+child.pid+' did not close after SIGTERM',3000);
    }else{terminate();await within(browser.closed,'Owned Chrome PID '+child.pid+' did not close',5000);}
   }
  }catch(error){failures.push(error);}
  if(browser.error())failures.push(browser.error());
 }
 // Keep releasing the other owned resources after a failure, but never erase
 // the profile/diagnostics unless every shutdown boundary completed.
 await Promise.all(sessions.map(session=>attempt('CDP close did not finish',()=>session.close())));
 if(bridge)await attempt('Bridge close did not finish',()=>bridge.close());
 await attempt('Fixture HTTP close did not finish',closeServer);
 if(failures.length)throw new AggregateError(failures,'Chrome fixture cleanup failed; retained '+root+'; owned PID '+(browser?.child.pid??'none'));
 if(!preserveRoot){try{await removeRoot(root);ownedRoots.delete(root);}catch(error){throw new AggregateError([error],'Chrome fixture removal failed; retained '+root);}}
}
class Cdp {
 private id=0;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();private closed:Promise<void>;
 private constructor(private socket:WebSocket){
  this.closed=socket.readyState===WebSocket.CLOSED?Promise.resolve():new Promise(resolve=>socket.addEventListener('close',()=>resolve(),{once:true}));
  socket.addEventListener('close',()=>{for(const request of this.pending.values())request.reject(Error('CDP closed'));this.pending.clear();},{once:true});
  socket.onmessage=e=>{const m=JSON.parse(String(e.data));if(!m.id)return;const p=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)p?.reject(Error(m.error.message));else p?.resolve(m.result);};
 }
 static async connect(url:string){const s=new WebSocket(url);await new Promise<void>((r,j)=>{s.onopen=()=>r();s.onerror=()=>j(Error('CDP connection failed'));});return new Cdp(s);}
 call(method:string,params:any={}):Promise<any>{const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
 // Browser.close may disconnect CDP before its response. The owned process's
 // close event is the authoritative completion, rather than a lost reply.
 requestBrowserClose(){this.socket.send(JSON.stringify({id:++this.id,method:'Browser.close'}));}
 close(){if(this.socket.readyState!==WebSocket.CLOSED)this.socket.close();return this.closed;}
}
export async function runChromeExtensionFixture(consume?:(provider:BrowserCaptureProvider,request:BrowserCaptureRequest,context:BrowserNativeContext)=>Promise<void>){await access(chrome);const root=await createChromeFixtureRoot();let browser:ChildProcess|undefined,observedBrowser:ReturnType<typeof observeFixtureBrowser>|undefined,requestBrowserClose:(()=>void)|undefined,bridge:ChromeCaptureBridge|undefined,failure:unknown,failed=false;const sessions:Cdp[]=[];const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Generated fixture</title><main><h1>Generated article</h1><p>Visible generated article body</p><input value="never captured"><p style="display:none">Hidden fixture secret</p></main>');});
 try{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number},origin=`http://127.0.0.1:${address.port}`,url=origin+'/article';
 const extension=join(root,'extension');await cp(resolve(repository,'apps/desktop/chrome-extension'),extension,{recursive:true});const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=[origin+'/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
 const profile=join(root,'collector'),data=join(root,'chrome'),contextPath=join(root,'context.json'),helper=join(root,'helper');await writeFile(helper,`#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(contextPath)},'utf8'));\n`,{mode:0o700});bridge=new ChromeCaptureBridge({profileDirectory:profile,helperPath:helper});await bridge.start();
 const host=join(root,'host.cjs');await build({entryPoints:[resolve(repository,'apps/desktop/src/chrome-native-host.ts')],outfile:host,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});const launcher=join(root,'host.sh'),q=(v:string)=>"'"+v.replace(/'/g,"'\\''")+"'";await writeFile(launcher,`#!/bin/sh\nexport MOTE_CHROME_BRIDGE_DESCRIPTOR=${q(join(profile,'chrome-bridge.json'))}\nexec ${q(process.execPath)} ${q(host)} "$@"\n`,{mode:0o700});await mkdir(join(data,'NativeMessagingHosts'),{recursive:true});await writeFile(join(data,'NativeMessagingHosts',CHROME_NATIVE_HOST+'.json'),JSON.stringify({name:CHROME_NATIVE_HOST,description:'Generated fixture',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${CHROME_EXTENSION_ID}/`]}));
 browser=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--enable-unsafe-extension-debugging',`--user-data-dir=${data}`,'--remote-debugging-port=0',url],{stdio:['ignore','ignore','pipe']});observedBrowser=observeFixtureBrowser(browser);let stderr='';browser.stderr!.on('data',c=>stderr+=c);let endpoint='';for(let n=0;n<100;n++){endpoint=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]??'';if(endpoint)break;if(browser.exitCode!==null)throw Error('Chrome exited');await sleep(50);}assert(endpoint,'Chrome debugging endpoint');const control=await Cdp.connect(endpoint);sessions.push(control);requestBrowserClose=()=>control.requestBrowserClose();const loaded=await control.call('Extensions.loadUnpacked',{path:extension});assert.equal(loaded.id,CHROME_EXTENSION_ID);
 const list=()=>fetch(endpoint.replace('ws:','http:').replace(/\/devtools.+/,'/json/list')).then(r=>r.json()) as Promise<any[]>;let targets:any[]=[];for(let n=0;n<100;n++){targets=await list();if(targets.some(t=>t.url===`chrome-extension://${CHROME_EXTENSION_ID}/background.js`)&&[...(bridge as any).peers].some((p:any)=>p.ready))break;await sleep(50);}assert([...(bridge as any).peers].some((p:any)=>p.ready),'Chrome launched the actual native host and authenticated');
 const page=await Cdp.connect(targets.find(t=>t.url===url).webSocketDebuggerUrl);sessions.push(page);const worker=await Cdp.connect(targets.find(t=>t.url===`chrome-extension://${CHROME_EXTENSION_ID}/background.js`).webSocketDebuggerUrl);sessions.push(worker);await page.call('Page.bringToFront');
 const geometry=(await page.call('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,viewport:{x:screenX+(outerWidth-innerWidth)/2,y:screenY+outerHeight-innerHeight-(outerWidth-innerWidth)/2,width:innerWidth,height:innerHeight}})',returnByValue:true})).result.value;
 const state=(await worker.call('Runtime.evaluate',{expression:'chrome.windows.getLastFocused({populate:true}).then(w=>JSON.stringify({focused:w.focused,window:{x:w.left,y:w.top,width:w.width,height:w.height}}))',awaitPromise:true,returnByValue:true})).result.value;const g=JSON.parse(geometry),w=JSON.parse(state);assert(w.focused,'headless Chrome reports its active window');
 await writeFile(contextPath,JSON.stringify({status:'ok',appId:'com.google.Chrome',pid:browser.pid,visibleBrowserWindows:1,url,window:w.window,viewport:g.viewport,screen:{x:0,y:0,width:1600,height:1200}}));
 const request={observationId:'6b79d144-1644-426c-927d-49f2478c62cc',appId:'com.google.Chrome',pid:browser.pid!,origins:[origin],observedAt:new Date().toISOString(),masks:[],structured:true};const result=await bridge.sample(request,new AbortController().signal);assert.equal(result.status,'ok',JSON.stringify(result));assert.equal(result.pages.length,1);const text=JSON.stringify(result.pages);assert(text.includes('Visible generated article body'));assert(!text.includes('Hidden fixture secret'));assert(!text.includes('never captured'));assert(await bridge.validate(result.identity!,new AbortController().signal));
 if(consume)await consume(bridge,request,JSON.parse(await readFile(contextPath,'utf8')));
 const paragraph=JSON.parse((await page.call('Runtime.evaluate',{expression:'JSON.stringify((()=>{const r=document.querySelector("p").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})())',returnByValue:true})).result.value);
 const normalizedMask={x:(paragraph.x+g.viewport.x)/1600,y:(paragraph.y+g.viewport.y)/1200,width:paragraph.width/1600,height:paragraph.height/1200};
 const masked=await bridge.sample({...request,masks:[normalizedMask]},new AbortController().signal);assert.equal(masked.status,'ok');assert(!JSON.stringify(masked.pages).includes('Visible generated article body'),'normalized privacy mask suppresses DOM evidence');assert(JSON.stringify(masked.pages).includes('Generated article'),'unmasked visible heading remains');
 for(const pseudo of ['before','after']){
  const overlayProof=JSON.parse((await page.call('Runtime.evaluate',{expression:`JSON.stringify((()=>{const owner=document.createElement('aside');owner.id='mote-fixture-pseudo-owner';owner.style.cssText='width:0;height:0;pointer-events:none';const style=document.createElement('style');style.id='mote-fixture-pseudo-style';style.textContent='#mote-fixture-pseudo-owner::${pseudo}{content:"";position:fixed;inset:0;background:rgb(0,0,0);pointer-events:none;z-index:2147483647}';document.body.append(owner,style);const bounds=owner.getBoundingClientRect(),paint=getComputedStyle(owner,'::${pseudo}'),text=document.querySelector('p').getBoundingClientRect();return {ownerWidth:bounds.width,ownerHeight:bounds.height,content:paint.content,position:paint.position,pointerEvents:paint.pointerEvents,hitPassesThrough:document.elementFromPoint(text.x+5,text.y+5)===document.querySelector('p')};})())`,returnByValue:true})).result.value);
  assert.equal(overlayProof.ownerWidth,0);assert.equal(overlayProof.ownerHeight,0);assert.equal(overlayProof.content,'""');assert.equal(overlayProof.position,'fixed');assert.equal(overlayProof.pointerEvents,'none');assert(overlayProof.hitPassesThrough,'opaque generated overlay is absent from pointer hit testing');
  const covered=await bridge.sample(request,new AbortController().signal);assert.equal(covered.status,'blocked',`zero-size sibling ::${pseudo} refuses covered page content`);assert.deepEqual(covered.pages,[]);assert.equal(covered.media,undefined);
  await page.call('Runtime.evaluate',{expression:'document.querySelector("#mote-fixture-pseudo-owner").remove();document.querySelector("#mote-fixture-pseudo-style").remove();'});
  const restored=await bridge.sample(request,new AbortController().signal);assert.equal(restored.status,'ok');assert(JSON.stringify(restored.pages).includes('Visible generated article body'),'page evidence resumes after generated overlay removal');
 }
 const identityOnly=await bridge.sample({...request,structured:false},new AbortController().signal);assert.equal(identityOnly.status,'ok');assert.deepEqual(identityOnly.pages,[]);await page.call('Page.navigate',{url:origin+'/different'});await sleep(100);assert.equal(await bridge.validate(identityOnly.identity!,new AbortController().signal),false);
 }catch(error){failure=error;failed=true;}
 try{await cleanupChromeFixture({root,browser:observedBrowser,requestBrowserClose,sessions,bridge,preserveRoot:failed,closeServer:()=>new Promise<void>((resolve,reject)=>{if(!server.listening){resolve();return;}server.close(error=>error?reject(error):resolve());server.closeAllConnections();})});}
 catch(error){throw new AggregateError(failed?[failure,error]:[error],'Chrome fixture failed; retained '+root);}
 if(failed)throw new AggregateError([failure],'Chrome journey failed; retained '+root);
 console.log('PASS: hidden Chrome -> shipped MV3 worker -> actual native messaging host -> private bridge -> validated visible page; normalized masks, zero-size pointerless pseudo overlay refusal/restoration, identity-only capture and navigation invalidation. Generated native AX/foreground boundary; no physical-device or live-model claims.');
}
if(require.main===module)runChromeExtensionFixture().catch(e=>{console.error(e);process.exitCode=1;});
