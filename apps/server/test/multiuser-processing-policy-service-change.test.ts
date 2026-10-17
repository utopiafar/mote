import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {defaultModelSettings} from '../src/model-settings.js';
import {scopedFilesFixture} from './fixtures/scoped-files.js';
import {waitForScopedState} from './fixtures/scoped-process.js';

test('publishing the same referenced connection resumes unfinished named processing without changing its policy',async t=>{
 const calls:string[]=[],server=createServer(async(req,res)=>{for await(const _ of req){}calls.push(String(req.headers.authorization));res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:0,engine:'generated-republished-service',segments:[{startMs:0,endMs:0,text:'GENERATED_REPUBLISHED_SERVICE'}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert.ok(address&&typeof address!=='string');
 const f=await scopedFilesFixture(t),page=await f.checked(f.a.token,'/api/file-processing'),policy={version:1,services:[{id:'media',name:'Generated saved reference',kind:'image',reference:{kind:'personal',id:'same-media'}}],profiles:[{id:'image',name:'Generated named image',processorId:'image.http',serviceId:'media',parameters:{},summarize:false},{id:'archive',name:'Generated original only',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'image/*',profileId:'image'},{type:'*/*',profileId:'archive'}]};
 const saved=await f.checked(f.a.token,'/api/file-processing','PUT',{revision:page.revision,settings:{...page.settings,automatic:true,understandingEnabled:false},policy});
 const png=await sharp({create:{width:2,height:2,channels:3,background:'#327b45'}}).png().toBuffer(),file=await f.uploadBytes(f.a.token,'generated-connection-later',png,'image/png');let blocked:any;
 await waitForScopedState(async()=>{blocked=await f.checked(f.a.token,'/api/files/'+file.id);return ['blocked','failed'].includes(blocked.job?.state);},()=>JSON.stringify(blocked),8000);assert.equal(blocked.processing.indexed,false);assert.equal(calls.length,0);const bBefore=await f.checked(f.b.token,'/api/configuration');
 const configuration=await f.checked(f.a.token,'/api/configuration');await f.checked(f.a.token,'/api/configuration/models','PUT',{revision:configuration.revision,value:{profiles:[{id:'same-media',name:'Generated complete reference',settings:{...defaultModelSettings(),provider:'custom',protocol:'mote-media',baseUrl:'http://127.0.0.1:'+address.port,apiKey:'GENERATED_PUBLISHED_KEY',model:''}}],selections:{}}});
 let after:any;await waitForScopedState(async()=>{after=await f.checked(f.a.token,'/api/files/'+file.id);return after.processing.indexed;},()=>JSON.stringify(after),6000);
 assert.notEqual(after.processing.appliedPolicy.id,blocked.processing.appliedPolicy.id);assert.deepEqual(calls,['Bearer GENERATED_PUBLISHED_KEY']);assert.equal((await f.checked(f.a.token,'/api/files/'+file.id+'/chunks')).items[0].ocrText,'GENERATED_REPUBLISHED_SERVICE');
 assert.deepEqual((await f.checked(f.a.token,'/api/file-processing')).policy,saved.policy);assert.deepEqual(await f.checked(f.b.token,'/api/configuration'),bBefore);
});
