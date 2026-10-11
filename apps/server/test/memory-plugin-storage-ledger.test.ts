import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryPublication} from '../src/memory-publication.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';

test('private plugin operation payloads and identity routing count against the vault quota, including transactional retirement and restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-plugin-ledger-')),options={maxStorageBytes:0},store=new Store(directory,options),memories=new MemoryStore(store),executor=new ExecutionEngine(store),plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(directory,'packages'))),bindings=new MemoryBindings(store,memories,new MemoryAutomation(store),plugins,executor),publication=new MemoryPublication(store,memories,bindings);
 t.after(async()=>{await publication.close();await bindings.close();await plugins.close();await executor.close();store.close();await rm(directory,{recursive:true,force:true});});
 store.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify({planId:'instance:generated',generation:2,namespace:{ownerId:'generated-owner',instanceId:'generated',bindingRevision:2}}));
 const baseline=store.logicalBytes(),prose='Generated private quota fixture '.repeat(200),operationId='generated-private-output',evidenceId='generated-evidence';publication.retainOutput(operationId,{privateDraft:prose},{evidenceIds:[evidenceId]});
 const output=String(store.db.prepare('SELECT json FROM memory_publication_outputs WHERE id=?').get(operationId)!.json),expected=Buffer.byteLength(output)+Buffer.byteLength(operationId)+128+Buffer.byteLength(operationId)+Buffer.byteLength('evidence')+Buffer.byteLength(evidenceId)+64;
 assert.equal(store.logicalBytes()-baseline,expected,'new JSON journal and its explicit dependency each enter the transactional ledger');
 const bytes=store.logicalBytes();options.maxStorageBytes=bytes+512;assert.throws(()=>publication.retainOutput('generated-over-quota',{privateDraft:prose}),{statusCode:507});assert.equal(store.db.prepare('SELECT 1 FROM memory_publication_outputs WHERE id=?').get('generated-over-quota'),undefined);options.maxStorageBytes=0;
 // A failed source mutation cannot commit either payload retirement or its
 // ledger delta, even when the retirement trigger has already executed.
 store.db.exec('BEGIN IMMEDIATE');store.db.prepare("INSERT INTO memory_provider_evidence_revocations VALUES(?,1,?,'submitted')").run(evidenceId,JSON.stringify({evidenceId,deleted:true,memoryIds:[]}));assert.ok(store.logicalBytes()<bytes);store.db.exec('ROLLBACK');assert.equal(store.logicalBytes(),bytes);assert.ok(String(store.db.prepare('SELECT json FROM memory_publication_outputs WHERE id=?').get(operationId)!.json).includes(prose));
 store.db.prepare("INSERT INTO memory_provider_evidence_revocations VALUES(?,1,?,'submitted')").run(evidenceId,JSON.stringify({evidenceId,deleted:true,memoryIds:[]}));assert.ok(store.logicalBytes()<bytes);assert.equal(JSON.parse(String(store.db.prepare('SELECT json FROM memory_publication_outputs WHERE id=?').get(operationId)!.json)).privateRetired,true);
 // SQLite can inherit an outer UPSERT conflict policy inside a trigger. A
 // repeated revocation must avoid inserting a duplicate retirement identity.
 store.invalidateSemanticEvidence(evidenceId);assert.equal(store.db.prepare('SELECT generation FROM memory_provider_evidence_revocations WHERE id=?').get(evidenceId)!.generation,2);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_publication_retirements').get()!.n,1);
 const rows=store.db.prepare("SELECT name,bytes FROM storage_ledger WHERE name IN ('plugin_center','memory_publication_outputs','memory_publication_dependencies','memory_publication_retirements','memory_provider_evidence_revocations') ORDER BY name").all();assert.equal(rows.length,5);assert.ok(rows.every(row=>Number(row.bytes)>0));
 const next=new Store(directory,options);try{assert.equal(next.logicalBytes(),store.logicalBytes(),'maintenance reopen preserves exact retired accounting');}finally{next.close();}
});
