import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {OwnerQuestions} from '../src/owner-questions.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {ownerQuestionsSchemaInstallation} from '../src/owner-questions-schema.js';
import type {OwnerQuestionCreate,OwnerQuestionProvider} from '../src/owner-question-contract.js';

test('a late owner-question schema failure rolls back inside the caller savepoint and retries on the same handle',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-owner-questions-install-')),store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{force:true,recursive:true});});
  const db=store.db,failure=new Error('Generated late owner-question installation failure');
  db.exec('BEGIN IMMEDIATE');
  assert.throws(()=>installSchemaPlan(db,[ownerQuestionsSchemaInstallation,{
    owner:'generated-late-failure',
    requires:[],
    install:()=>{throw failure;},
  }]),error=>error===failure);
  assert.equal(db.isTransaction,true,'the caller savepoint keeps the outer transaction open');
  assert.equal(Number(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'owner_question%'").get()!.n),0,'the late failure rolls back the earlier owner-question tables');
  db.exec('ROLLBACK');

  installSchemaPlan(db,[ownerQuestionsSchemaInstallation]);
  const questions=new OwnerQuestions(store);
  const provider:OwnerQuestionProvider={id:'fixture.schema-retry',version:'1',installationEpoch:'retry-install',validate:()=>true,answer:()=>({kind:'continued',continuationId:'retry:once'})};
  questions.register(provider);
  const input:OwnerQuestionCreate={key:'retry-current',operationId:'retry:work',workId:'retry-work',title:'Generated retry question',prompt:'Confirm the retried schema.',evidence:[],choices:[],dependencyIds:[]};
  const question=questions.create(provider,input);
  assert.equal(questions.get(question.id).prompt,input.prompt);
  assert.equal(Number(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='owner_questions'").get()!.n),1);
});
