import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureMediaRuntime, startMediaWorkers} from './media-workers.mjs';

const fixture = async t => {
  const root=await mkdtemp(join(tmpdir(),'mote-workers-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'scripts'));
  for(const name of ['audio','ocr'])await writeFile(join(root,'scripts',`requirements-${name}.txt`),'generated fixture');
  return root;
};
test('runtime installs once, checks imports, repairs missing dependencies and never passes secrets',async t=>{
  const root=await fixture(t),python=join(root,'media-venv/bin/python'),calls=[];
  let broken=false;
  const run=async(cmd,args,env)=>{
    assert.equal(env.MOTE_TOKEN,undefined);assert.equal(env.MOTE_MEDIA_WORKER_TOKEN,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
    calls.push(args);
    if(args[1]==='venv')await mkdir(join(root,'media-venv'),{recursive:true});
    if(args[0]==='-c'&&broken){broken=false;throw Error('fixture missing dependency');}
  };
  const options={root,python,env:{PATH:process.env.PATH,MOTE_TOKEN:'private',MOTE_MEDIA_WORKER_TOKEN:'private',OPENAI_API_KEY:'private'},run};
  await ensureMediaRuntime(options);assert.equal(calls.length,3);
  await ensureMediaRuntime(options);assert.equal(calls.length,4);assert.equal(calls.at(-1)[0],'-c');
  broken=true;await ensureMediaRuntime(options);assert.equal(calls.length,8);
  await writeFile(join(root,'scripts/requirements-ocr.txt'),'changed dependency');
  await ensureMediaRuntime(options);assert.equal(calls.length,11);
});
test('failed installation is not marked ready',async t=>{
  const root=await fixture(t),python=join(root,'media-venv/bin/python');
  await assert.rejects(ensureMediaRuntime({root,python,env:{},run:async()=>{throw Error('generated install failure');}}));
  await assert.rejects(readFile(join(root,'media-venv/mote-requirements.sha256')));
});
test('workers start before model files, restart after exit, and stop with the parent',async t=>{
  const root=await fixture(t),controller=new AbortController();
  const code=`const fs=require('node:fs');const path=require('node:path');const name=path.basename(__filename);fs.appendFileSync(name+'.started',process.pid+'\\n');setInterval(()=>{if(fs.existsSync('models-ready'))fs.writeFileSync(name+'.ready','yes')},20);`;
  for(const name of ['ocr-server.py','transcription-server.py'])await writeFile(join(root,'scripts',name),code);
  const workers=startMediaWorkers({root,signal:controller.signal,env:{MOTE_RUNTIME:'docker',MOTE_MEDIA_MODEL_DIR:join(root,'models'),MOTE_MEDIA_PYTHON:process.execPath,MOTE_MEDIA_WORKER_TOKEN:'fixture'},report:()=>{}});
  t.after(()=>workers.close());
  const wait=async predicate=>{const until=Date.now()+10000;while(!await predicate()){assert.ok(Date.now()<until,'worker fixture timed out');await new Promise(r=>setTimeout(r,25));}};
  const pids=async name=>(await readFile(join(root,name+'.started'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(Number);
  await wait(async()=> (await pids('ocr-server.py')).length===1&&(await pids('transcription-server.py')).length===1);
  await writeFile(join(root,'models-ready'),'generated model installed');
  await wait(async()=>await readFile(join(root,'ocr-server.py.ready'),'utf8').catch(()=>false));
  process.kill((await pids('ocr-server.py'))[0],'SIGTERM');
  await wait(async()=> (await pids('ocr-server.py')).length===2);
  controller.abort();await workers.close();
  for(const name of ['ocr-server.py','transcription-server.py'])for(const pid of await pids(name))assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
