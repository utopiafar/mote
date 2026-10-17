import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedFilesFixture} from './fixtures/scoped-files.js';

test('a fresh login can save processing configuration after the cached owner logs out',async t=>{
 const f=await scopedFilesFixture(t),before=await f.checked(f.a.token,'/api/configuration'),bBefore=await f.checked(f.b.token,'/api/configuration');
 const processing=before.domains.find((domain:any)=>domain.id==='processing').effective;
 await f.checked(f.a.token,'/api/auth/logout','POST',{});
 const fresh=await f.checked(undefined,'/api/auth/login','POST',{username:'generated-a',password:'Generated-joint-files-password',mode:'client'});
 assert.equal((await f.request(f.a.token,'/api/configuration')).statusCode,401);
 const current=await f.checked(fresh.token,'/api/configuration');assert.equal(current.revision,before.revision);
 const saved=await f.request(fresh.token,'/api/configuration/processing','PUT',{revision:current.revision,value:{...processing,automatic:!processing.automatic}});
 assert.equal(saved.statusCode,200,saved.body);
 assert.equal(saved.json().domains.find((domain:any)=>domain.id==='processing').effective.automatic,!processing.automatic);
 assert.deepEqual(await f.checked(f.b.token,'/api/configuration'),bBefore);
 assert.equal((await f.request(f.a.token,'/api/configuration/processing','PUT',{revision:saved.json().revision,value:processing})).statusCode,401);
});
