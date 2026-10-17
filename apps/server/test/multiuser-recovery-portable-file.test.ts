import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {scopedFilesFixture} from './fixtures/scoped-files.js';

test('same-account portable merge and restart retain the current file incarnation and never renew old tickets or delete intent',async t=>{
 const f=await scopedFilesFixture(t),text='Generated portable incarnation seam',a=await f.upload(f.a.token,'generated-portable-file',text),b=await f.upload(f.b.token,'generated-portable-file',text),path='/api/files/'+a.id;
 const initial=await f.checked(f.a.token,path),body={operationId:randomUUID(),originalGeneration:initial.originalGeneration};
 const ticket=await f.checked(f.a.token,'/api/ingress/originals/'+a.original.ref.slice(9)+'/tickets','POST',{mode:'download'});
 const exportId=randomUUID();await f.checked(f.a.token,'/api/portable/exports','POST',{operationId:exportId});
 for(let attempt=0;;attempt++){
  const receipt=await f.checked(f.a.token,'/api/portable/exports/'+exportId);
  if(receipt.state==='completed')break;
  assert.equal(receipt.state,'working',JSON.stringify(receipt));assert.ok(attempt<300);await delay(10);
 }
 const archive=await f.checked(f.a.token,'/api/portable/exports/'+exportId+'/content');
 const forgotten=await f.checked(f.a.token,path,'DELETE',body);await f.checked(f.a.token,path+'/allow-again','POST',forgotten.decision);
 assert.equal((await f.upload(f.a.token,'generated-portable-file',text)).id,a.id);
 const current=await f.checked(f.a.token,path);assert.ok(current.originalGeneration>initial.originalGeneration);
 const importId=randomUUID();let receipt=await f.checked(f.a.token,'/api/portable/imports','POST',{operationId:importId,archive});
 for(let attempt=0;receipt.state==='working';attempt++){assert.ok(attempt<300);await delay(10);receipt=await f.checked(f.a.token,'/api/portable/imports/'+importId);}
 assert.equal(receipt.state,'completed',JSON.stringify(receipt));
 await f.restart();
 assert.equal((await f.checked(f.a.token,path)).originalGeneration,current.originalGeneration);
 assert.equal((await f.request(f.a.token,'/api/ingress/originals/'+a.original.ref.slice(9)+'/content?ticket='+encodeURIComponent(ticket.ticket))).statusCode,404);
 assert.equal((await f.request(f.a.token,path,'DELETE',{...body,operationId:randomUUID()})).statusCode,409);
 assert.deepEqual(await f.checked(f.a.token,path,'DELETE',body),forgotten);
 assert.equal((await f.request(f.a.token,path)).statusCode,200);assert.equal((await f.request(f.b.token,'/api/files/'+b.id)).statusCode,200);
 assert.deepEqual(await f.checked(f.a.token,'/api/portable/imports','POST',{operationId:importId,archive}),receipt);
});
