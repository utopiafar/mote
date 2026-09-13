import { DatabaseSync,backup } from 'node:sqlite';
import { mkdir,readFile,writeFile,copyFile,access,rm } from 'node:fs/promises';
import { resolve,join,relative } from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({path:resolve('.env'),quiet:true});
const args=process.argv.slice(2);
if(args.includes('--help')){console.info('Stop the central node first. Usage: npm run backup -- --data ./data --out /absolute/new-backup-directory\nBacks up SQLite, referenced image blobs and checksums. Tokens/keys are excluded; preserve your data key separately.');process.exit(0);}
if(!args.includes('--out'))throw new Error('Stop the central node first. Usage: npm run backup -- --data ./data --out /backup/mote-YYYY-MM-DD');
const source=resolve(args.includes('--data')?args[args.indexOf('--data')+1]:'data');const out=resolve(args[args.indexOf('--out')+1]);
if(out===source||!relative(source,out).startsWith('..'))throw new Error('Backup destination must be outside the active vault');
try {const pid=Number((await readFile(join(source,'server.pid'),'utf8')).trim());try{process.kill(pid,0);throw new Error('The central node is still running. Stop it before copying a consistent database + blob backup.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
try{await access(out);throw new Error('Backup destination already exists; choose a new directory');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
await mkdir(join(out,'blobs'),{recursive:true,mode:0o700});
const checksums:Record<string,string>={};const sum=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
try {
  const db=new DatabaseSync(join(source,'mote.sqlite'),{readOnly:true});
  try{await backup(db,join(out,'mote.sqlite'));const rows=db.prepare('SELECT hash FROM blobs').all() as {hash:string}[];
    for(const {hash} of rows){await copyFile(join(source,'blobs',hash),join(out,'blobs',hash));checksums['blobs/'+hash]=await sum(join(out,'blobs',hash));}
  }finally{db.close();}
  checksums['mote.sqlite']=await sum(join(out,'mote.sqlite'));
  await writeFile(join(out,'backup-manifest.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),checksums,note:'Tokens and data encryption keys are intentionally excluded. Preserve MOTE_DATA_KEY separately if enabled.'},null,2),{mode:0o600});
  console.info(`Consistent vault backup written to ${out}. Restore into an empty data directory; keep the same data encryption key.`);
}catch(e){await rm(out,{recursive:true,force:true});throw e;}
