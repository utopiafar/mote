/** Run after build:libs and @mote/web build. ELECTRON_PATH optionally selects an installed binary. */
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'mote-j5-run-'));
const env={...process.env,MOTE_J5_CONNECTION:join(dir,'connection.json'),MOTE_J5_OUTPUT:resolve('.mote/j5-ui')};
mkdirSync(env.MOTE_J5_OUTPUT,{recursive:true});
const service=spawn(process.execPath,['--import','tsx','scripts/fixtures/conversation-origin-server.ts'],{env,stdio:'inherit'});
const ended=new Promise(resolve=>service.once('exit',resolve));
try{
 const deadline=Date.now()+30000;
 while(!existsSync(env.MOTE_J5_CONNECTION)){
  if(service.exitCode!==null||Date.now()>deadline)throw Error('Generated Central failed to become ready');
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 const binary=process.env.ELECTRON_PATH||require('electron');
 const ui=spawn(binary,['scripts/test-conversation-origin-ui.cjs'],{env,stdio:'inherit'});
 process.exitCode=await new Promise((resolve,reject)=>{ui.once('error',reject);ui.once('exit',code=>resolve(code??1));});
}finally{
 service.kill('SIGTERM');await ended;rmSync(dir,{recursive:true,force:true});
}
