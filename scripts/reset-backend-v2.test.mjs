import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {resetBackendV2} from './reset-backend-v2.mjs';

test('MVP vault reset removes evidence storage only with an explicit flag',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-vault-reset-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'mote.sqlite'),'generated old data');
  writeFileSync(join(directory,'access-token'),'generated token');
  mkdirSync(join(directory,'source-archive'));
  writeFileSync(join(directory,'source-archive','original'),'generated original');
  mkdirSync(join(directory,'connectors'));
  writeFileSync(join(directory,'connectors','client-connections.json'),'generated old client');
  writeFileSync(join(directory,'connectors','remote-account.json'),'generated remote account');
  assert.throws(()=>resetBackendV2(directory),/confirm-clear/);
  const result=resetBackendV2(directory,{confirm:true});
  assert.ok(result.removed.includes('mote.sqlite'));
  assert.ok(result.removed.includes('source-archive'));
  assert.ok(result.removed.includes('connectors/client-connections.json'));
  assert.equal(readFileSync(join(directory,'access-token'),'utf8'),'generated token');
  assert.equal(readFileSync(join(directory,'connectors','remote-account.json'),'utf8'),'generated remote account');
});
