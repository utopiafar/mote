import {afterEach,expect,it,vi} from 'vitest';
import {constants} from 'node:fs';
import {mkdtemp,open,readdir,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spoolOriginal} from '../src/original-spool';

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:vi.fn(actual.open)};
});

let root:string|undefined;
afterEach(async()=>{vi.restoreAllMocks();if(root)await rm(root,{recursive:true,force:true});root=undefined;});

it('rejects a path replacement while reading the original and cleans the incomplete spool',async()=>{
  root=await realpath(await mkdtemp(join(tmpdir(),'mote-spool-race-')));
  const path=join(root,'generated.txt'),spools=join(root,'spools');await writeFile(path,'Generated original bytes');
  const expected=await stat(path),actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let replaced=false;
  vi.mocked(open).mockImplementation((async (target:any,flags:any,...rest:any[])=>{
    const handle=await (actual.open as any)(target,flags,...rest);
    if(target===path && typeof flags==='number' && (flags & constants.O_NOFOLLOW)){
      const read=handle.read.bind(handle);
      vi.spyOn(handle,'read').mockImplementation(async (...args:any[])=>{
        const result=await read(...args);
        if(!replaced){replaced=true;await rename(path,join(root!,'.old'));await writeFile(path,'Generated replacement');}
        return result;
      });
    }
    return handle;
  }) as typeof open);
  await expect(spoolOriginal(path,spools,{dev:expected.dev,ino:expected.ino,size:expected.size,mtimeMs:expected.mtimeMs,ctimeMs:expected.ctimeMs})).rejects.toThrow('changed');
  expect(replaced).toBe(true);expect(await readdir(spools)).toEqual([]);
});
