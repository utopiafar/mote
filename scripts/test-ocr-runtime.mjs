// Opt-in real-model validation. Only generated pixels leave this process, over loopback.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, cp, rm, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
const {values}=parseArgs({options:{python:{type:'string'},'model-root':{type:'string'}}});
if(!values.python||!values['model-root'])throw Error('Usage: node scripts/test-ocr-runtime.mjs --python VENV_PYTHON --model-root INSTALLED_OCR_DIRECTORY');
const root=await mkdtemp(join(tmpdir(),'mote-live-ocr-')),models=join(root,'ocr'),secret=randomUUID();
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const child=spawn(values.python,[resolve('scripts/ocr-server.py'),'--model-root',models,'--port',String(port)],{env:{PATH:process.env.PATH,HOME:root,MOTE_MEDIA_WORKER_TOKEN:secret},stdio:'ignore'});
const closed=new Promise(r=>child.once('close',r));child.on('error',()=>{});
const headers={Authorization:'Bearer '+secret};
const url=`http://127.0.0.1:${port}`;
const health=async()=>{const r=await fetch(url+'/health',{headers,signal:AbortSignal.timeout(60000)});assert.equal(r.status,200);return r.json();};
try{
 const until=Date.now()+10000;
 for(;;){try{assert.equal((await health()).ocr,false);break;}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,100));}}
 assert.equal((await fetch(url+'/health')).status,401);
 await cp(resolve(values['model-root']),join(root,'staging'),{recursive:true});await rename(join(root,'staging'),models);
 assert.equal((await health()).ocr,true,'Installed model must load without restarting the worker');
 const image=await sharp(Buffer.from('<svg width="1000" height="200"><rect width="100%" height="100%" fill="white"/><text x="40" y="120" font-family="Arial" font-size="60" fill="black">MOTE OCR TEST 123</text></svg>')).png().toBuffer();
 const response=await fetch(url+'/ocr',{method:'POST',headers:{...headers,'Content-Type':'image/png'},body:image,signal:AbortSignal.timeout(60000)});
 assert.equal(response.status,200);const result=await response.json(),text=result.segments.map(x=>x.text).join(' ');
 assert.match(text,/MOTE OCR TEST 123/i);
 console.log(JSON.stringify({passed:true,workerStartedWithoutModel:true,installedWithoutRestart:true,recognized:text,fixture:'generated image',personalScreenshotsUsed:false}));
}finally{child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),5000);await closed;clearTimeout(force);await rm(root,{recursive:true,force:true});}
