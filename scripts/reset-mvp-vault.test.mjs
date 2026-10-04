import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {resetMvpVault} from './reset-mvp-vault.mjs';

test('MVP vault reset removes evidence storage only with an explicit flag',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-reset-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'mote.sqlite'),'generated old data');
  writeFileSync(join(directory,'access-token'),'generated token');
  writeFileSync(join(directory,'content-key'),'generated encryption key');
  for(const name of ['model-settings.json','file-processing.json'])writeFileSync(join(directory,name),'generated incompatible settings');
  mkdirSync(join(directory,'source-archive'));
  writeFileSync(join(directory,'source-archive','original'),'generated original');
  mkdirSync(join(directory,'connectors'));
  writeFileSync(join(directory,'connectors','client-connections.json'),'generated old client');
  writeFileSync(join(directory,'connectors','remote-account.json'),'generated remote account');
  assert.throws(()=>resetMvpVault(directory),/confirm-clear/);
  const result=resetMvpVault(directory,{confirm:true});
  assert.ok(result.removed.includes('mote.sqlite'));
  assert.ok(result.removed.includes('source-archive'));
  assert.equal(result.storageEpoch,3);
  for(const name of ['model-settings.json','file-processing.json']){assert.ok(result.removed.includes(name));assert.equal(existsSync(join(directory,name)),false);}
  assert.equal(readFileSync(join(directory,'connectors','client-connections.json'),'utf8'),'generated old client');
  assert.equal(readFileSync(join(directory,'content-key'),'utf8'),'generated encryption key');
  assert.equal(readFileSync(join(directory,'access-token'),'utf8'),'generated token');
  assert.equal(readFileSync(join(directory,'connectors','remote-account.json'),'utf8'),'generated remote account');
});

test('reset refuses an active server or invalid PID marker and leaves every generated input intact',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-reset-stopped-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 writeFileSync(join(directory,'mote.sqlite'),'generated evidence');
 for(const value of [String(process.pid),'invalid']){
  writeFileSync(join(directory,'server.pid'),value);assert.throws(()=>resetMvpVault(directory,{confirm:true}),/Stop|invalid/);
  assert.equal(readFileSync(join(directory,'mote.sqlite'),'utf8'),'generated evidence');
 }
});
test('reset rejects a linked data directory and preserves model caches and connector credentials',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-reset-paths-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const actual=join(directory,'actual'),link=join(directory,'linked');mkdirSync(actual);symlinkSync(actual,link,'dir');
 writeFileSync(join(actual,'mote.sqlite'),'generated evidence');assert.throws(()=>resetMvpVault(link,{confirm:true}),/non-symlink/);
 assert.equal(readFileSync(join(actual,'mote.sqlite'),'utf8'),'generated evidence');
 for(const folder of ['media-models','logs','connectors']){mkdirSync(join(actual,folder));writeFileSync(join(actual,folder,'generated'),'generated private/cache content');}
 resetMvpVault(actual,{confirm:true});
 for(const folder of ['media-models','logs','connectors'])assert.equal(readFileSync(join(actual,folder,'generated'),'utf8'),'generated private/cache content');
});
