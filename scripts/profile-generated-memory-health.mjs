import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const directory=await mkdtemp(join(tmpdir(),'generated-central-health-profile-'));
const markers=[];
const child=spawn(process.execPath,['--cpu-prof','--cpu-prof-interval=3000',`--cpu-prof-dir=${directory}`,'--import','tsx','apps/server/test/fixtures/memory-processing-health.ts',join(directory,'data')],{stdio:['ignore','ignore','inherit','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir()}});
const closed=once(child,'close');
child.on('message',message=>markers.push({...message,wall:Date.now()}));
const limit=setTimeout(()=>child.kill('SIGKILL'),120_000);
const next=async type=>{while(!markers.some(event=>event.type===type))await Promise.race([once(child,'message'),closed.then(()=>assert.fail('Generated health process closed before '+type))]);return markers.find(event=>event.type===type);};
const rows=[];
try{
  const ready=await next('ready'),url=`http://127.0.0.1:${ready.port}/api/health`;
  const probe=async()=>{
    const began=Date.now();let status;
    try{const response=await fetch(url,{signal:AbortSignal.timeout(1500)});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);status='ok';}
    catch(error){status=error.name;}
    rows.push({began,ended:Date.now(),status,target:markers.at(-1)?.type,dispatches:markers.at(-1)?.dispatches});
  };
  await probe();assert.equal(rows[0].status,'ok');child.send('process');await next('processing');
  do{await probe();await delay(25);assert.ok(child.exitCode===null&&child.signalCode===null,'Generated profile ended early');}while(!markers.some(event=>event.type==='done'));
  const expected=await next('done');assert.equal(expected.jobs,51);assert.equal(expected.originals,2712);assert.deepEqual(expected.dispatches,{extract:67,review:67});
  child.send('finish');const [code]=await closed,now=Date.now();assert.equal(code,0);
  const profileFile=(await readdir(directory)).find(name=>name.endsWith('.cpuprofile'));assert.ok(profileFile);
  const profile=JSON.parse(await readFile(join(directory,profileFile),'utf8'));
  const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
  const parents=new Map(profile.nodes.flatMap(node=>node.children?.map(child=>[child,node.id])??[]));
  const intervals=[];let elapsed=0;
  const start=now-(profile.endTime-profile.startTime)/1000;
  for(const [index,id] of profile.samples.entries()){
    const duration=profile.timeDeltas[index]/1000;
    intervals.push({start:start+elapsed,duration,id});elapsed+=duration;
  }
  rows.sort((left,right)=>(right.status!=='ok')-(left.status!=='ok')||(right.ended-right.began)-(left.ended-left.began));
  console.log(JSON.stringify({expected,probeCount:rows.length,misses:rows.filter(row=>row.status!=='ok').length}));
  for(const row of rows.slice(0,7)){
    const hot=new Map();
    for(const {start,duration,id} of intervals){
      if(start<row.began||start>row.ended)continue;
      const stack=[];
      for(let current=id;current&&stack.length<7;current=parents.get(current)){
        const {functionName,url}=nodes.get(current).callFrame;
        if(url.includes('sqlite-database.ts')||url.includes('processTicksAndRejections'))continue;
        stack.push(`${functionName||'<anonymous>'} (${url.split('?')[0].split('/').at(-1)})`);
      }
      const key=stack.join(' ← ');hot.set(key,(hot.get(key)??0)+duration);
    }
    console.log(JSON.stringify({...row,duration:row.ended-row.began,hot:[...hot].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([stack,ms])=>[stack,Math.round(ms)])}));
  }
}finally{
  clearTimeout(limit);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;
  await rm(directory,{recursive:true,force:true});
}
