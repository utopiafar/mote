import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {decodeLocalContent,encodeLocalContent,readLocalContent} from '../src/local-content';
import {DurableQueue,imageHash} from '../src/queue';import {defaultConfig} from '../src/config';
import {NoteDraftStore} from '../src/note-draft';import {SourceSync} from '../src/source-sync';import {event,image} from './fixtures';
let directory:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'mote-content-format3-'));});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
it('writes directly readable current records, originals and drafts and survives restart and portable export',async()=>{
 const config=defaultConfig(),queue=new DurableQueue(join(directory,'queue'),config);await queue.initialize();await queue.enqueue(event(),image);
 expect(JSON.parse(await readFile(join(queue.directory,'events',event().id+'.json'),'utf8')).event).toEqual(event());
 expect(await readFile(join(queue.directory,'blobs',imageHash(image)+'.jpg'))).toEqual(image);
 const draft=new NoteDraftStore(join(directory,'notes'));await draft.initialize();await draft.update({...draft.get(),text:'Generated draft',revision:1});
 const sources=new SourceSync(join(directory,'sources','state.json'));await sources.initialize();await sources.stage({items:[{externalId:'generated',title:'Generated',text:'Generated body',kind:'message',layer:'snapshot',deleted:false}],seen:['generated'],complete:true,skipped:0},false);
 const reopened=new DurableQueue(queue.directory,config);await reopened.initialize();expect(reopened.stats().depth).toBe(1);
 const restartedDraft=new NoteDraftStore(join(directory,'notes'));await restartedDraft.initialize();expect(restartedDraft.get().text).toBe('Generated draft');
 const archive=join(directory,'archive.json');await reopened.exportArchiveFile(archive);expect(JSON.parse(await readFile(archive,'utf8')).version).toBe(3);
 const target=new DurableQueue(join(directory,'target'),config);await target.initialize();await target.importArchiveFile(archive);expect(await target.imageForBrowser(event().id)).toEqual(image);
});
it('preserves arbitrary format3 bytes and authored text resembling retired envelope prefixes',async()=>{
 for(const prefix of ['MOTE-CONTENT-AES256GCM-V1\0','MOTE-CONTENT-PLAIN-V1\0']){
  const bytes=Buffer.concat([Buffer.from(prefix),Buffer.alloc(40,73)]),path=join(directory,'old-content');await writeFile(path,bytes);
  expect(decodeLocalContent(encodeLocalContent(bytes))).toEqual(bytes);
  expect(await readLocalContent(path)).toEqual(bytes);expect(await readFile(path)).toEqual(bytes);
  const drafts=join(directory,prefix.startsWith('MOTE-CONTENT-AES')?'notes-aes-prefix':'notes-plain-prefix'),draft=new NoteDraftStore(drafts);await draft.initialize();
  const text=prefix+'Generated literal authored text';await draft.update({...draft.get(),text,revision:1});
  const reopened=new NoteDraftStore(drafts);await reopened.initialize();expect(reopened.get().text).toBe(text);
 }
 expect(decodeLocalContent(encodeLocalContent(image))).toEqual(image);
});
