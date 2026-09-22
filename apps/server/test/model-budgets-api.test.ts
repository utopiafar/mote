import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {buildApp} from '../src/app.js';import type {Config} from '../src/config.js';
test('owner budget controls block real Harness before HTTP and cannot be set by a collector',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-budget-api-')),headers={authorization:'Bearer generated-owner'};
 const config={dataDir:dir,token:'generated-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false} as Config;
 const {app}=await buildApp(config);t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal((await app.inject({url:'/api/model-budgets'})).statusCode,401);
 const invite=(await app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://fixture.invalid',label:'Fixture'}})).json();
 const paired=(await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.invitation.code,deviceId:'fixture',deviceName:'Fixture',platform:'android'}})).json();
 assert.equal((await app.inject({method:'PUT',url:'/api/model-budgets',headers:{authorization:'Bearer '+paired.token},payload:{revision:0,limits:{dailyTokens:1}}})).statusCode,403);
 assert.equal((await app.inject({method:'PUT',url:'/api/model-budgets',headers,payload:{revision:0,limits:{dailyTokens:1}}})).statusCode,200);
 const denied=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated budget denial'}});assert.equal(denied.json().reason,'model_token_budget',denied.body);assert.equal(denied.json().recovery,'needs_action');
 assert.deepEqual((await app.inject({url:'/api/model-budgets',headers})).json().usage,[],'a denied request reserves no balance');
 assert.equal((await app.inject({method:'PUT',url:'/api/model-budgets',headers,payload:{revision:0,limits:{}}})).statusCode,409);
});
