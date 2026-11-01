import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {act} from 'react';
import {JSDOM} from 'jsdom';

async function fixture(){
 const dom=new JSDOM(readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'http://localhost/#/library?view=records',pretendToBeVisual:true}),d=dom.window.document;
 for(const key of ['window','document','navigator','location','history','localStorage','sessionStorage','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Element','Node'] as const)Object.defineProperty(globalThis,key,{value:key==='window'?dom.window:(dom.window as any)[key],configurable:true});
 Object.assign(globalThis,{__MOTE_WEB_VERSION__:'generated-timeline-clock',IS_REACT_ACT_ENVIRONMENT:true});
 dom.window.localStorage.setItem('mote.language','zh-CN');
 dom.window.sessionStorage.setItem('mote.connection',JSON.stringify({token:'generated-clock-session',viewScope:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));
 let visible=true,phase=0;const paths:string[]=[];
 Object.defineProperties(d,{visibilityState:{get:()=>visible?'visible':'hidden'},hidden:{get:()=>!visible}});
 const firstAt=new Date().toISOString(),day=firstAt.slice(0,10),ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
 const group=()=>({type:'group',id:'generated-sealed-'+phase,kind:'source',source:'activity',deviceId:'generated-clock',deviceName:'Generated clock device',day,firstAt,lastAt:firstAt,recordCount:phase+1,imageCount:0,sampleCount:null});
 const capabilities=['/api/capture-browser/timeline','/api/capture-browser/timeline/members','/api/library/browse'].map(path=>({id:'http:GET:'+path,version:'1',state:'active',surface:'data',featureId:'mote.capture'}));
 const priorFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const path=String(input);paths.push(path);let value:unknown={items:[],nextCursor:null};
  if(path==='/api/configuration')value={};
  else if(path==='/api/status')value={agent:{configured:false},storage:{captures:1}};
  else if(path==='/api/features')value={schemaVersion:1,revision:1,features:[],capabilities};
  else if(path.startsWith('/api/operations/changes?'))value={cursor:1,ids:[],reset:false,hasMore:false};
  else if(path.startsWith('/api/capture-browser/timeline/members?')){
   if(new URL('http://localhost'+path).searchParams.get('group')!==group().id)return new Response(JSON.stringify({error:'Generated expired group'}),{status:409,headers:{'content-type':'application/json'}});
   value={revision:'generated-revision-'+phase,group:group(),items:[{record:{id:ids[phase],deviceId:'generated-clock',deviceName:'Generated clock device',platform:'macos',capturedAt:firstAt,source:'activity',appName:'Generated app',windowTitle:'Generated clock member '+phase,durationMs:1000,hasImage:false,ocr:{status:'not_applicable'},textPreview:''},firstAt,lastAt:firstAt,sampleCount:null}],nextCursor:null};
  }else if(path.startsWith('/api/capture-browser/timeline?'))value={revision:'generated-revision-'+phase,items:[group()],nextCursor:null};
  else if(path.startsWith('/api/library/browse'))value={schemaVersion:1,types:[],sources:[],items:[],nextCursor:null};
  assert.ok(!init?.method||init.method==='GET'||!/^\/api\/(query|captures|memory-integrations)(\?|$)/.test(path),'clock fixture cannot admit model or capture work');
  return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 };
 const hook=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:next(url,context);}});
 const realTimeout=globalThis.setTimeout;
 const until=async(ready:()=>boolean)=>{const deadline=Date.now()+15_000;while(!ready()){assert.ok(Date.now()<deadline,'real boot/main did not reach records: '+paths.join(', '));await act(async()=>new Promise(resolve=>realTimeout(resolve,10)));}};
 const timelineReads=()=>paths.filter(path=>path.startsWith('/api/capture-browser/timeline?')).length;
 const memberReads=()=>paths.filter(path=>path.includes('/timeline/members?')).length;
 const tick=(ms:number)=>act(async()=>mock.timers.tick(ms));
 mock.timers.enable({apis:['setTimeout','setInterval']});
 try{
  await act(async()=>{await import('../src/boot');});await until(()=>!!d.querySelector('.library-time-group'));
  await act(async()=>{const detail=d.querySelector<HTMLDetailsElement>('.library-time-group')!;detail.querySelector<HTMLElement>(':scope > summary')!.click();detail.dispatchEvent(new dom.window.Event('toggle'));});
  await until(()=>!!d.querySelector('.library-time-observation'));const expanded=d.querySelector<HTMLDetailsElement>('.library-time-group')!,baseline=timelineReads(),initialMembers=memberReads();
  phase=1;await tick(1500);assert.equal(timelineReads(),baseline);assert.equal(memberReads(),initialMembers);
  await tick(28_499);assert.equal(timelineReads(),baseline,'no full read before the actual main tick');
  await tick(1);assert.equal(timelineReads(),baseline+1,'the real main 30-second revision reaches Archive and timeline exactly once');
  assert.ok(d.querySelector('.library-time-group')===expanded);assert.equal(expanded.open,true);assert.equal(expanded.getAttribute('data-group-id'),'generated-sealed-1');assert.match(d.querySelector('.library-time-observation')!.textContent!,/Generated clock member 1/);assert.ok(memberReads()>initialMembers);
  visible=false;d.dispatchEvent(new dom.window.Event('visibilitychange'));phase=2;const hiddenMembers=memberReads();await tick(30_000);assert.equal(timelineReads(),baseline+1);assert.equal(memberReads(),hiddenMembers,'the existing background-page semantics remain intact');
  visible=true;d.dispatchEvent(new dom.window.Event('visibilitychange'));assert.equal(timelineReads(),baseline+1);await tick(30_000);assert.equal(timelineReads(),baseline+2);assert.match(d.querySelector('.library-time-observation')!.textContent!,/Generated clock member 2/);
  await act(async()=>{dom.window.location.hash='#/library?view=materials';dom.window.dispatchEvent(new dom.window.Event('hashchange'));});await until(()=>paths.some(path=>path.startsWith('/api/library/browse')));
  const materialReads=()=>paths.filter(path=>path.startsWith('/api/library/browse')).length,beforeMaterials=materialReads();await tick(30_000);assert.equal(materialReads(),beforeMaterials,'other collections keep their prior revision cadence');
 }finally{hook.deregister();mock.timers.reset();globalThis.fetch=priorFetch;dom.window.close();}
}

if(process.env.MOTE_TIMELINE_CLOCK_FIXTURE){await fixture();process.exit(0);}
else test('real boot and main tick refresh the open timeline with existing visibility and other page cadence',{timeout:30_000},()=>{
 const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url)],{env:{...process.env,MOTE_TIMELINE_CLOCK_FIXTURE:'1'},encoding:'utf8',timeout:25_000});
 assert.equal(child.status,0,child.stdout+child.stderr+(child.error?.message??''));
});
