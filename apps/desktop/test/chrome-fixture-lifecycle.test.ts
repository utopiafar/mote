import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cleanupChromeFixture,createChromeFixtureRoot,observeFixtureBrowser} from '../scripts/chrome-extension-smoke';

const directories:string[]=[];
afterEach(async()=>{vi.useRealTimers();for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});});
async function root(){const path=await createChromeFixtureRoot();directories.push(path);return path;}
function browser(){
 const child=Object.assign(new EventEmitter(),{pid:123456,exitCode:null as number|null,signalCode:null as NodeJS.Signals|null,kill:vi.fn((_signal?:NodeJS.Signals)=>{child.exitCode=0;child.emit('exit',0,null);return true;})});
 const observed=observeFixtureBrowser(child as unknown as ChildProcess);
 return{child,observed,exit:()=>{child.exitCode=0;child.emit('exit',0,null);},close:()=>child.emit('close',child.exitCode,child.signalCode)};
}
function resources(path:string){return{root:path,sessions:[] as {close:()=>void|Promise<void>}[],closeServer:vi.fn(async()=>{}),bridge:{close:vi.fn(async()=>{})}};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

it('keeps the owned profile until close even when Chrome exit precedes a final profile write',async()=>{
 const path=await root(),profile=join(path,'chrome','Default');await mkdir(profile,{recursive:true});const owned=browser();owned.exit();let removed=false;
 const pending=cleanupChromeFixture({...resources(path),browser:owned.observed,removeRoot:async target=>{removed=true;await rm(target,{recursive:true,force:true});}});
 try{
  await turn();expect(removed,'exit alone does not finish the owned process or its stdio').toBe(false);expect(existsSync(profile)).toBe(true);
  await writeFile(join(profile,'late-write'),'Generated shutdown checkpoint');owned.close();await pending;expect(removed).toBe(true);expect(existsSync(path)).toBe(false);expect(owned.child.kill).not.toHaveBeenCalled();
 }finally{owned.close();await pending.catch(()=>{});}
});

it('waits for the CDP close handshake before removing the owned fixture directory',async()=>{
 const path=await root();let release!:()=>void,removed=false;const held=new Promise<void>(resolve=>release=resolve);
 const pending=cleanupChromeFixture({...resources(path),sessions:[{close:()=>held}],removeRoot:async target=>{removed=true;await rm(target,{recursive:true,force:true});}});
 try{await turn();expect(removed).toBe(false);expect(existsSync(path)).toBe(true);release();await pending;expect(existsSync(path)).toBe(false);}finally{release();await pending.catch(()=>{});}
});

it('requests Browser.close for its own live child and completes cleanup without sending a signal',async()=>{
 const path=await root(),owned=browser(),request=vi.fn(()=>{owned.exit();owned.close();});
 await cleanupChromeFixture({...resources(path),browser:owned.observed,requestBrowserClose:request});expect(request).toHaveBeenCalledOnce();expect(owned.child.kill).not.toHaveBeenCalled();expect(existsSync(path)).toBe(false);
});

it('observes an already closed child without signalling its potentially reused PID',async()=>{
 const path=await root(),owned=browser();owned.exit();owned.close();await cleanupChromeFixture({...resources(path),browser:owned.observed});expect(owned.child.kill).not.toHaveBeenCalled();expect(existsSync(path)).toBe(false);
});

it('preserves a failed child startup and reports its error after closing other owned resources',async()=>{
 const path=await root(),owned=browser(),failure=Error('Generated Chrome spawn failure'),state=resources(path);owned.child.emit('error',failure);owned.exit();owned.close();
 const error=await cleanupChromeFixture({...state,browser:owned.observed}).then(()=>undefined,error=>error);
 expect(error).toBeInstanceOf(AggregateError);expect((error as AggregateError).errors).toContain(failure);expect(error.message).toContain(path);expect(state.bridge.close).toHaveBeenCalledOnce();expect(state.closeServer).toHaveBeenCalledOnce();expect(existsSync(path)).toBe(true);
});

it('reports CDP close failure and retains the scene while still closing the bridge and HTTP fixture',async()=>{
 const path=await root(),state=resources(path),failure=Error('Generated CDP close failure');await writeFile(join(path,'diagnostic'),'Generated useful scene');
 const error=await cleanupChromeFixture({...state,sessions:[{close:()=>{throw failure;}}]}).then(()=>undefined,error=>error);
 expect(error).toBeInstanceOf(AggregateError);expect((error as AggregateError).errors).toContain(failure);expect(error.message).toContain(path);expect(state.bridge.close).toHaveBeenCalledOnce();expect(state.closeServer).toHaveBeenCalledOnce();expect(await readFile(join(path,'diagnostic'),'utf8')).toBe('Generated useful scene');
});

it('keeps ENOTEMPTY visible with the original error and retained directory, without a blind rm retry',async()=>{
 const path=await root(),failure=Object.assign(Error('Generated ENOTEMPTY'),{code:'ENOTEMPTY'}),removeRoot=vi.fn(async()=>{throw failure;});
 const error=await cleanupChromeFixture({...resources(path),removeRoot}).then(()=>undefined,error=>error);
 expect(error).toBeInstanceOf(AggregateError);expect((error as AggregateError).errors).toContain(failure);expect(error.message).toContain(path);expect(removeRoot).toHaveBeenCalledExactlyOnceWith(path);expect(existsSync(path)).toBe(true);
});

it('refuses to remove an unowned directory even if a caller supplies a remover',async()=>{
 const path=await mkdtemp(join(tmpdir(),'mote-mac07-unowned-'));directories.push(path);await writeFile(join(path,'keep'),'Generated unowned data');const removeRoot=vi.fn(async()=>{});
 await expect(cleanupChromeFixture({...resources(path),removeRoot})).rejects.toThrow(/unowned/);expect(removeRoot).not.toHaveBeenCalled();expect(await readFile(join(path,'keep'),'utf8')).toBe('Generated unowned data');
});

it('bounds graceful close then uses only SIGTERM on its own child and still waits for close',async()=>{
 const path=await root(),owned=browser(),request=vi.fn();vi.useFakeTimers();owned.child.kill.mockImplementation(signal=>{expect(signal).toBe('SIGTERM');owned.exit();owned.close();return true;});
 const pending=cleanupChromeFixture({...resources(path),browser:owned.observed,requestBrowserClose:request});
 try{await Promise.resolve();expect(owned.child.kill).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(2000);await pending;expect(request).toHaveBeenCalledOnce();expect(owned.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');expect(existsSync(path)).toBe(false);}finally{owned.close();vi.useRealTimers();await pending.catch(()=>{});}
});

it('reports an owned child that never closes and retains its profile instead of force-exiting or deleting it',async()=>{
 const path=await root(),owned=browser();vi.useFakeTimers();const pending=cleanupChromeFixture({...resources(path),browser:owned.observed,requestBrowserClose:()=>{}});
 const rejected=expect(pending).rejects.toThrow(/retained/);
 try{await vi.advanceTimersByTimeAsync(5000);await rejected;expect(owned.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');expect(existsSync(path)).toBe(true);}finally{owned.close();vi.useRealTimers();await pending.catch(()=>{});}
});
