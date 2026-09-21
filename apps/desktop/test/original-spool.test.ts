import {afterEach,it,expect} from 'vitest';
import {mkdtemp,realpath,writeFile,readFile,rm,stat,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spoolOriginal,originalPart} from '../src/original-spool';
import {scanSourceFiles} from '../src/source-files';
import {SourceSync} from '../src/source-sync';
import {DEFAULT_SOURCE_OPTIONS,type SourceDefinition,type SourceRequest,type LocalFileCheckpoint} from '../src/source-types';
import {configureLocalContent} from '../src/local-content';
const dirs:string[]=[];
afterEach(async()=>{configureLocalContent({enabled:false});for(const dir of dirs.splice(0))await rm(dir,{force:true,recursive:true});});
async function fixture(){const dir=await realpath(await mkdtemp(join(tmpdir(),'mote-spool-')));dirs.push(dir);return dir;}
it('streams an encrypted 20 MiB immutable original across restart, resumes missing parts, validates ACK and cleans only after commit',async()=>{
 const dir=await fixture(),path=join(dir,'large.txt');const bytes=Buffer.alloc(20*1024*1024+13,67);await writeFile(path,bytes);
 configureLocalContent({enabled:true,key:Buffer.alloc(32,11)});
 const scan=await scanSourceFiles(path,{...DEFAULT_SOURCE_OPTIONS,retention:'archive'},undefined,join(dir,'markers.json'));
 expect(scan.items).toHaveLength(1);const spool=scan.items[0].localOriginal!;expect(spool).toBeDefined();expect(scan.items[0].localOriginalBase64).toBeUndefined();
 expect((await readFile(join(spool.directory,'0'))).equals(bytes.subarray(0,spool.partBytes))).toBe(false);
 const state=join(dir,'queue.json');let sync=new SourceSync(state);await sync.initialize();await sync.stage(scan,false);
 // A queued version remains valid after its source is changed and removed.
 await writeFile(path,'new version');await rm(path);
 const source:SourceDefinition={id:'spool-fixture',name:'Synthetic copy',kind:'local-files',deviceId:'synthetic',platform:'macos',retention:'archive',enabled:true};
 const parts=new Map<number,Buffer>();let revision='',lose=true;const sent:number[]=[];
 const request:SourceRequest=async(url,body,method)=>{
  if(url==='/api/sources')return source;
  if(url.startsWith('/api/file-sync/v1/head?'))return {revision:null};
  if(url==='/api/file-sync/v1/capabilities')return {version:1,partBytes:4194304};
  if(url==='/api/file-sync/v1/uploads'){
   expect(JSON.stringify(body)).not.toContain(spool.directory);expect(JSON.stringify(body)).not.toContain('localOriginal');revision=(body as any).item.revision;
   return {uploadId:'fixture',partBytes:4194304,parts:[...parts.keys()].map(part=>({part}))};
  }
  if(method==='PUT'){const part=Number(url.split('/').at(-1));sent.push(part);parts.set(part,Buffer.from(body as Uint8Array));if(part===1&&lose){lose=false;throw Error('ACK lost');}return {};}
  if(url.endsWith('/commit'))return {id:'b67c1b84-f2cd-4e59-bf67-215545a882dc',sourceId:source.id,externalId:scan.items[0].externalId,revision,duplicate:false};
  throw Error(url);
 };
 await expect(sync.flush(source,request)).rejects.toThrow('ACK lost');await access(spool.directory);
 sync=new SourceSync(state);await sync.initialize();await sync.flush(source,request);
 expect(sent).toEqual([0,1,2,3,4,5]);expect(Buffer.concat([...parts.values()]).equals(bytes)).toBe(true);
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(spool.sha256);expect(sync.status().pending).toBe(0);await expect(access(spool.directory)).rejects.toThrow();
});
it('rejects a stale file identity and removes rejected queue snapshots',async()=>{
 const dir=await fixture(),path=join(dir,'fixture.txt');await writeFile(path,'before');const previous=await stat(path);await writeFile(path,'after changed');
 await expect(spoolOriginal(path,join(dir,'spools'),{dev:previous.dev,ino:previous.ino,size:previous.size,mtimeMs:previous.mtimeMs,ctimeMs:previous.ctimeMs})).rejects.toThrow('changed');
 const scan=await scanSourceFiles(path,{...DEFAULT_SOURCE_OPTIONS,retention:'archive'},undefined,join(dir,'markers.json'));const location=scan.items[0].localOriginal!.directory;
 const sync=new SourceSync(join(dir,'queue.json'),{maxEvents:0});await sync.initialize();await expect(sync.stage(scan,false)).rejects.toThrow();await expect(access(location)).rejects.toThrow();
});
it('commits large directory files individually without rolling back a completed snapshot when the next file exceeds the scan budget',async()=>{
 const dir=await fixture(),root=join(dir,'input');await mkdir(root);await writeFile(join(root,'a.txt'),Buffer.alloc(17*1024*1024,65));await writeFile(join(root,'b.txt'),'second');
 const opts={...DEFAULT_SOURCE_OPTIONS,retention:'archive' as const},markers=join(dir,'markers.json');let checkpoint:LocalFileCheckpoint|undefined;const names:string[]=[];
 for(let n=0;n<4;n++){const scan=await scanSourceFiles(root,opts,undefined,markers,undefined,checkpoint);names.push(...scan.items.map(item=>item.title));checkpoint=scan.checkpoint as LocalFileCheckpoint;for(const item of scan.items)if(item.localOriginal)await rm(item.localOriginal.directory,{force:true,recursive:true});if(scan.complete)break;}
 expect(names.sort()).toEqual(['a.txt','b.txt']);
});
