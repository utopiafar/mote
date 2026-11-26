import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'mote-generated-task-profile-'));
try {
  const result=spawnSync(process.execPath,['--cpu-prof',`--cpu-prof-dir=${dir}`,'--cpu-prof-interval=2000','--import','tsx','--test','--test-isolation=none','--test-timeout=120000','--test-name-pattern','^an explicit conversation selection','apps/server/test/assistant-task-journey.test.ts'],{stdio:'inherit',timeout:120_000});
  const profileName=(await readdir(dir)).find(name=>name.endsWith('.cpuprofile'));
  if(profileName){
    const p=JSON.parse(await readFile(join(dir,profileName),'utf8')),n=new Map(p.nodes.map(x=>[x.id,x.callFrame])),parents=new Map(p.nodes.flatMap(x=>x.children?.map(c=>[c,x.id])??[])),total=new Map();
    let elapsed=0;
    for(const [i,id] of p.samples.entries()){
      const dt=p.timeDeltas[i]??0;elapsed+=dt;if(elapsed<(p.endTime-p.startTime)-11_000_000)continue;
      const stack=[];for(let current=id;current&&stack.length<11;current=parents.get(current)){
        const frame=n.get(current),name=frame.url.split('?')[0].split('/').at(-1);if(!['host.js','sqlite-database.ts','async_context_frame'].includes(name))stack.push(`${frame.functionName||'<anonymous>'}(${name})`);
      }
      const key=stack.join(' ← ');total.set(key,(total.get(key)??0)+dt);
    }
    console.log('Generated last eleven seconds of task profile');
    for(const [key,time] of [...total].sort((a,b)=>b[1]-a[1]).slice(0,34))console.log(`${Math.round(time/1000)} ms ${key}`);
  }
  process.exitCode=result.status??1;
} finally { await rm(dir,{recursive:true,force:true}); }
