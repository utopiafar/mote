import { readdir,readFile,stat,writeFile,mkdir,rename } from 'node:fs/promises';
import { resolve,join,extname,basename } from 'node:path';
import { createHash } from 'node:crypto';
import { apiClient } from './client.js';
const args=process.argv.slice(2);const get=(name:string)=>args[args.indexOf(name)+1];
if(args.includes('--help')){console.info('Usage: npm run import:files -- --root /explicit/folder [--extensions .md,.txt] [--dry-run] [--watch]\nOnly explicitly selected UTF-8 files, max 100 KB each. Hidden entries and symlinks are skipped. Set MOTE_URL and MOTE_TOKEN for remote nodes.');process.exit(0);}
if(!args.includes('--root'))throw new Error('Usage: npm run import:files -- --root /explicit/folder [--extensions .md,.txt] [--dry-run] [--watch]');
const root=resolve(get('--root'));
const extensions=new Set((args.includes('--extensions')?get('--extensions'):'.md,.txt').split(',').map(e=>e.toLowerCase()));
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const deviceId='files-'+hash(root).slice(0,24);const stateDir=resolve('.mote/file-sync');await mkdir(stateDir,{recursive:true,mode:0o700});
const destination=(process.env.MOTE_URL||'http://127.0.0.1:47832').replace(/\/$/,'');
const statePath=join(stateDir,deviceId+'-'+hash(destination).slice(0,16)+'.json');let state:Record<string,{hash:string;capturedAt:string;id:string}>={};
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const request=args.includes('--dry-run')?undefined:apiClient();
async function* walk(path:string):AsyncGenerator<string> {
  for(const entry of await readdir(path,{withFileTypes:true})) {
    if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
    const file=join(path,entry.name);if(entry.isDirectory())yield* walk(file);else if(entry.isFile()&&extensions.has(extname(entry.name).toLowerCase()))yield file;
  }
}
async function scan() {
  let count=0;
  for await(const file of walk(root)) {
    const metadata=await stat(file);if(metadata.size>100000){console.warn(`Skipped oversized text: ${basename(file)}`);continue;}
    const content=await readFile(file);const digest=hash(content);const key=hash(file);
    if(state[key]?.hash===digest)continue;
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{console.warn(`Skipped non-UTF8 text: ${basename(file)}`);continue;}
    if(!text.trim())continue;
    const h=hash(`${deviceId}:${key}:${digest}:${metadata.mtimeMs}`);const id=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
    const event={id,deviceId,deviceName:`文件夹 · ${basename(root)}`,platform:'import',capturedAt:metadata.mtime.toISOString(),durationMs:0,appId:'mote.file-import',appName:'文件资料',windowTitle:basename(file),ocrText:text,source:'file',privacy:{excluded:false,redacted:false,mode:'none',reason:'User selected explicit source directory'}};
    if(request) {
      await request('/api/captures',event);state[key]={hash:digest,capturedAt:event.capturedAt,id};
      await writeFile(statePath+'.tmp',JSON.stringify(state),{mode:0o600});await rename(statePath+'.tmp',statePath);
    }
    count++;
  }
  console.info(`${request?'Imported':'Would import'} ${count} changed UTF-8 text files from the explicitly selected folder.`);
}
await scan();
if(args.includes('--watch')) {
  console.info('Watching every 30 seconds; Ctrl+C stops. Deleting the original preserves the historical archive.');
  let busy=false;setInterval(async()=>{if(busy)return;busy=true;try{await scan();}catch(e){console.error(e instanceof Error?e.message:'Sync failed');}finally{busy=false;}},30000);
}
