import {expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectionToken,loginRequest,loginVerifier,sourceConnectionBinding} from '../src/login-session';
import {ConfigStore,defaultConfig,publicConfig,updateConfig} from '../src/config';
import {decideSync} from '../src/sync-policy';
import {uploadCapture} from '../src/transport';
it('logout and expiry stop foreground and background use without changing queue ownership',async()=>{
 const c={...defaultConfig(),token:'generated'.repeat(8)};
 for(const stopped of [{...c,authSignedOut:true},{...c,authExpiresAt:1}]){
  expect(connectionToken(stopped)).toBeUndefined();expect(publicConfig(stopped).tokenConfigured).toBe(false);
  expect(decideSync(stopped,{pendingRecords:100},Date.now(),true).ready).toBe(false);
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(uploadCapture(stopped,{} as never)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();vi.unstubAllGlobals();
 }
});
it('remembers encrypted login deadlines and explicit logout, but never persists an app-only token',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mote-login-test-'));
 const secrets={available:()=>true,encrypt:(v:string)=>Buffer.from(v).map(b=>b^0x5a),decrypt:(v:Buffer)=>Buffer.from(v.map(b=>b^0x5a)).toString()};
 try{
  const store=new ConfigStore(root,secrets),config={...defaultConfig(),token:'generated-login-token'.repeat(3),authExpiresAt:Date.now()+86400000};
  await store.save(config);expect((await store.load()).token).toBe(config.token);expect((await store.load()).authExpiresAt).toBe(config.authExpiresAt);expect(await readFile(join(root,'config.json'),'utf8')).not.toContain(config.token);
  await store.save({...config,authSignedOut:true});expect(connectionToken(await store.load())).toBeUndefined();
  await store.save({...config,authSessionOnly:true});const restarted=await store.load();expect(restarted.token).toBeUndefined();expect(sourceConnectionBinding(restarted)).toBe(sourceConnectionBinding(config));
 }finally{await rm(root,{recursive:true,force:true});}
});
it('uses generated verifier challenges and refuses redirect responses or oversized exchanges',async()=>{
 const a=loginVerifier(),b=loginVerifier();expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(a.challenge).toMatch(/^[a-f0-9]{64}$/);expect(a.verifier).not.toBe(b.verifier);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:302,headers:{Location:'https://elsewhere.invalid'}})));
 await expect(loginRequest({serverUrl:'https://fixture.invalid'},'/api/login/poll',{})).rejects.toThrow('302');vi.unstubAllGlobals();
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(16385))));
 await expect(loginRequest({serverUrl:'https://fixture.invalid'},'/api/login/poll',{})).rejects.toThrow();vi.unstubAllGlobals();
});
it('preserves app-only checkpoint binding when editing the same normalized endpoint',()=>{
 const config={...defaultConfig(),serverUrl:'https://fixture.invalid',authSourceBinding:'a'.repeat(64),authSessionOnly:true};
 expect(updateConfig(config,{...config,serverUrl:config.serverUrl+'/'}).authSourceBinding).toBe(config.authSourceBinding);
 expect(updateConfig(config,{...config,serverUrl:'https://elsewhere.invalid',token:''}).authSourceBinding).toBeUndefined();
});
it('keeps exact pending source revisions after an app-only login restart and same-node reauthorization',async()=>{
 const {writeFile}=await import('node:fs/promises'),{LocalSourceManager}=await import('../src/source-manager'),{DEFAULT_SOURCE_OPTIONS}=await import('../src/source-types');
 const root=await mkdtemp(join(tmpdir(),'mote-login-source-')),config={...defaultConfig(),token:'generated-session-token'.repeat(3),authSessionOnly:true,syncMode:'manual' as const};
 const store=new ConfigStore(root,{available:()=>true,encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()});
 let first:InstanceType<typeof LocalSourceManager>|undefined,second:InstanceType<typeof LocalSourceManager>|undefined;
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Generated offline node');}));
 try{
  const path=join(root,'generated.md');await writeFile(path,'Generated pending evidence; no personal data.');
  first=new LocalSourceManager(join(root,'sources'),config,'/unused');await first.initialize();await first.addFiles(path,DEFAULT_SOURCE_OPTIONS);await first.sync();
  expect(first.connectionActivity().pending).toBe(1);const revision=first.status()[0].source.id;await first.close();first=undefined;
  await store.save(config);const restarted=await store.load();expect(connectionToken(restarted)).toBeUndefined();
  second=new LocalSourceManager(join(root,'sources'),restarted,'/unused');await second.initialize();expect(second.connectionActivity().pending).toBe(1);expect(second.status()[0].source.id).toBe(revision);
  const next={...restarted,token:'generated-replacement'.repeat(3),authSignedOut:false};const release=await second.holdConnection();await second.prepareReauthorization(next);await second.changeConnection(next);release();expect(second.connectionActivity().pending).toBe(1);
 }finally{await first?.close();await second?.close();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});}
},30000);
