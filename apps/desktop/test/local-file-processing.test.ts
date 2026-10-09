import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtemp,realpath,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanSourceFiles} from '../src/source-files';
import {SourceSync} from '../src/source-sync';
import {DEFAULT_SOURCE_OPTIONS,type SourceRequest} from '../src/source-types';
import {fileTransport} from './file-transport';
let root:string;
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'mote-central-file-transport-')));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const source={id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos' as const,retention:'snapshot' as const,enabled:true};
async function engine(){const sync=new SourceSync(join(root,'state.json'));await sync.initialize();await sync.ensurePolicy('fixture-policy');return sync;}
async function scan(){return scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,join(root,'.atime'));}
it('uploads snapshot bytes once per immutable revision with no local processing waits across lost ACK and restart',async()=>{
 await writeFile(join(root,'a.wav'),'Generated audio A');await writeFile(join(root,'b.wav'),'Generated audio B');let sync=await engine(),lost=true;const manifests:any[]=[];
 const transport=fileTransport(()=>source.id,item=>{manifests.push(item);if(lost){lost=false;throw Error('Generated lost ACK');}});
 const request:SourceRequest=async(path,body,method)=>{if(path==='/api/sources')return source;const response=await transport('https://fixture.example'+path,{method,body:body instanceof Uint8Array?body:JSON.stringify(body)});return response!.json();};
 const discovered=await scan();expect(discovered.items.every(item=>item.localOriginal&&!Object.hasOwn(item,'localProcessing'))).toBe(true);await sync.stage(discovered,false);
 await expect(sync.flush(source,request)).rejects.toThrow('lost ACK');expect(sync.status()).toMatchObject({pending:2});
 sync=await engine();await sync.flush(source,request);expect(sync.status()).toMatchObject({pending:0});expect(manifests.every(item=>item.text===''&&item.document.fileIndex.parser==='central-pending')).toBe(true);expect(manifests[0]).toEqual(manifests[1]);
 for(const item of discovered.items)await expect(access(item.localOriginal!.directory)).rejects.toThrow();
});
it('an adapter rescan retains unacknowledged originals and clears the checkpoint',async()=>{
 await writeFile(join(root,'generated.wav'),'Generated old input');const sync=await engine(),discovered=await scan(),item=discovered.items[0],spool=item.localOriginal!;
 await sync.stage(discovered,false);
 await sync.ensureAdapterVersion(2);expect(sync.checkpoint()).toBeUndefined();await expect(access(spool.directory)).resolves.toBeUndefined();expect(sync.status().pending).toBe(1);
});
