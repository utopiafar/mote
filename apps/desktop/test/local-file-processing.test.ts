import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanSourceFiles} from '../src/source-files';
import {SourceSync} from '../src/source-sync';
import {DEFAULT_SOURCE_OPTIONS,type SourceItem,type SourceRequest} from '../src/source-types';
import {LocalFileProcessors,processLocalFile,type LocalFileResult} from '../src/local-file-processing';
import {sourceAck} from './fixtures';
let root:string;
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'mote-independent-processing-')));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const source={id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos' as const,retention:'snapshot' as const,enabled:true};
const result:LocalFileResult={text:'Generated transcript',parser:'fixture@1',status:'ready',contentVersion:'a'.repeat(64)};
function transport(sent:any[],loseAck=false):SourceRequest{return async(path,body)=>{
 if(path==='/api/sources')return source;
 if(path.endsWith('/capabilities'))return {manifestBatch:0};
 if(path.startsWith('/api/file-sync/v1/head'))return {revision:null};
 expect(path).toBe('/api/file-sync/v1/revisions');
 const manifest=structuredClone(body) as {item:SourceItem};sent.push(manifest);
 expect(manifest).not.toHaveProperty('sha256');expect(manifest.item).not.toHaveProperty('localProcessing');expect(manifest.item).not.toHaveProperty('localOriginal');
 if(loseAck)throw Error('Generated lost ACK');
 return sourceAck(source.id,manifest.item,'file-revision');
};}
async function engine(){const sync=new SourceSync(join(root,'state.json'));await sync.initialize();await sync.ensurePolicy('fixture-policy');return sync;}
async function scan(){return scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,join(root,'.atime'));}
it('durably receives every metadata version while ASR is missing and resumes derived content without raw upload',async()=>{
 await writeFile(join(root,'a.wav'),'Generated audio A');await writeFile(join(root,'b.wav'),'Generated audio B');
 let sync=await engine();const discovered=await scan();expect(discovered.items.map(item=>item.text)).toEqual(['','']);
 await sync.stage(discovered,false);const sent:any[]=[];await sync.flush(source,transport(sent));
 expect(sync.status()).toMatchObject({pending:0,processingPending:2});
 await sync.processPending(DEFAULT_SOURCE_OPTIONS,undefined,()=>true,async()=>({...result,text:'',status:'pending'}),1000);
 sync=await engine();expect(sync.status()).toMatchObject({pending:0,processingPending:2});
 let runs=0;await sync.processPending(DEFAULT_SOURCE_OPTIONS,undefined,()=>true,async()=>{runs++;return result;},302000);
 expect(runs).toBe(2);expect(sync.status()).toMatchObject({pending:2,processingPending:0});
 const lost:any[]=[];await expect(sync.flush(source,transport(lost,true))).rejects.toThrow('lost ACK');
 sync=await engine();const retried:any[]=[];await sync.flush(source,transport(retried));expect(retried[0]).toEqual(lost[0]);
 expect(retried.every(item=>item.item.text===result.text)).toBe(true);expect(sync.status()).toMatchObject({pending:0,processingPending:0});
 await sync.processPending(DEFAULT_SOURCE_OPTIONS,undefined,()=>true,async()=>{throw Error('ACK retry must not rerun ASR');});
});
it('reads an immutable private input after the source changes and applies literal masks before publishing',async()=>{
 const file=join(root,'generated.txt');await writeFile(file,'Generated secret first');const sync=await engine(),discovered=await scan();
 const input=discovered.items[0].localProcessing!;expect(input.spool).toBeDefined();await sync.stage(discovered,false);const sent:any[]=[];await sync.flush(source,transport(sent));
 await writeFile(file,'Changed original');
 const modules=new LocalFileProcessors().register({id:'local-file',version:1,read:async bytes=>({text:bytes.toString(),parser:'fixture@1',status:'ready'})});
 await sync.processPending({...DEFAULT_SOURCE_OPTIONS,redactLiterals:['secret']},undefined,()=>true,(input,mime)=>processLocalFile(input,mime,undefined,modules));
 await sync.flush(source,transport(sent));expect(sent.at(-1).item.text).toBe('Generated [已遮盖] first');expect(sent[0].item.revision).not.toBe(sent.at(-1).item.revision);
 await expect(import('node:fs/promises').then(fs=>fs.stat(input.spool!.directory))).rejects.toMatchObject({code:'ENOENT'});
});
it('a held processor does not block another upload and loses publication rights after policy changes',async()=>{
 await writeFile(join(root,'a.wav'),'Generated A');const sync=await engine();await sync.stage(await scan(),false);const sent:any[]=[];await sync.flush(source,transport(sent));
 let release!:(result:LocalFileResult)=>void;const held=new Promise<LocalFileResult>(resolve=>release=resolve);
 const processing=sync.processPending(DEFAULT_SOURCE_OPTIONS,undefined,()=>true,()=>held);
 await sync.stage({items:[{externalId:'another',title:'Generated',text:'',kind:'file',layer:'reference'}],seen:['another'],complete:false,skipped:0},false);
 const other:any[]=[]; // Ordinary reference sources use their own ingress route.
 const request:SourceRequest=async(path,body)=>path==='/api/sources'?source:(other.push(body),sourceAck(source.id,body as SourceItem));
 await sync.flush(source,request);expect(other).toHaveLength(1);
 await sync.ensurePolicy('changed-policy');release(result);await processing;
 expect(sync.status()).toMatchObject({pending:0,processingPending:0});
});
it('a rescan cancels stale processing without reviving the old file revision',async()=>{
 const file=join(root,'a.wav');await writeFile(file,'Generated A');const sync=await engine();await sync.stage(await scan(),false);await sync.flush(source,transport([]));
 let release!:(result:LocalFileResult)=>void;const held=new Promise<LocalFileResult>(resolve=>release=resolve),processing=sync.processPending(DEFAULT_SOURCE_OPTIONS,undefined,()=>true,()=>held);
 await writeFile(file,'Generated B different');await sync.stage(await scan(),false);release(result);await processing;
 expect(sync.status()).toMatchObject({pending:1,processingPending:1});
 const sent:any[]=[];await sync.flush(source,transport(sent));expect(sent[0].item.text).toBe('');
});
it('missing processor versions and malformed module results retain their job instead of publishing invalid revisions',async()=>{
 await writeFile(join(root,'a.wav'),'Generated input');const sync=await engine();await sync.stage(await scan(),false);await sync.flush(source,transport([]));
 await sync.processPending(DEFAULT_SOURCE_OPTIONS,undefined,()=>true,(input,mime)=>processLocalFile({...input,processor:{id:'missing',version:2}},mime),1000);
 expect(sync.status()).toMatchObject({pending:0,processingPending:1});
 await sync.processPending(DEFAULT_SOURCE_OPTIONS,undefined,()=>true,async()=>({...result,parser:'invalid'.repeat(100)}),302000);
 expect(sync.status()).toMatchObject({pending:0,processingPending:1});
});
