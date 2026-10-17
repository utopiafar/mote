import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedFilesFixture} from './fixtures/scoped-files.js';
import {defaultModelSettings} from '../src/model-settings.js';

test('the processing page saves its personal connection and policy in one CAS transaction',async t=>{
 const f=await scopedFilesFixture(t),before=await f.checked(f.a.token,'/api/file-processing'),bBefore=await f.checked(f.b.token,'/api/configuration');
 const policy={version:1,services:[{id:'media',name:'Generated local OCR',kind:'image',reference:{kind:'personal',id:'same-media'}}],profiles:[{id:'image',name:'Generated image',processorId:'image.http',serviceId:'media',parameters:{},summarize:false},{id:'archive',name:'Generated archive',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'image/*',profileId:'image'},{type:'*/*',profileId:'archive'}]},models={profiles:[{id:'same-media',name:'Generated complete connection',settings:{...defaultModelSettings(),provider:'custom',protocol:'mote-media',baseUrl:'http://127.0.0.1:17777',apiKey:'GENERATED_ATOMIC_KEY',model:''}}],selections:{}};
 const response=await f.request(f.a.token,'/api/file-processing','PUT',{revision:before.revision,settings:{...before.settings,automatic:true},policy,models});assert.equal(response.statusCode,200,response.body);const saved=response.json();
 assert.equal(Number(saved.revision),Number(before.revision)+1);assert.equal(saved.policyConfigured,true);assert.equal(saved.models.personal[0].settings.apiKey,true);assert.doesNotMatch(response.body,/GENERATED_ATOMIC_KEY/);assert.equal(saved.models.personal[0].id,'same-media');
 const configuration=await f.checked(f.a.token,'/api/configuration'),modelView=configuration.domains.find((domain:any)=>domain.id==='models').effective;
 const again=await f.checked(f.a.token,'/api/file-processing','PUT',{revision:saved.revision,settings:{...saved.settings,automatic:false},policy:saved.policy,models:modelView});assert.equal(Number(again.revision),Number(saved.revision)+1);assert.equal(again.models.personal[0].settings.apiKey,true,'the existing M04 masked secret is retained by stable profile ID');
 const stable=await f.checked(f.a.token,'/api/configuration'),invalid=await f.request(f.a.token,'/api/file-processing','PUT',{revision:again.revision,settings:{...again.settings,automatic:true},policy:{...saved.policy,profiles:saved.policy.profiles.map((profile:any)=>profile.id==='image'?{...profile,parameters:{unsupported:true}}:profile)},models:{...models,profiles:[{...models.profiles[0],settings:{...models.profiles[0].settings,apiKey:'GENERATED_MUST_NOT_PUBLISH'}}]}});
 assert.equal(invalid.statusCode,400,invalid.body);assert.deepEqual(await f.checked(f.a.token,'/api/configuration'),stable);assert.deepEqual(await f.checked(f.b.token,'/api/configuration'),bBefore);
 assert.equal((await f.request(f.a.token,'/api/file-processing','PUT',{revision:before.revision,settings:before.settings,policy,models})).statusCode,409);
});
