import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp,registerUserRoute} from '../src/app.js';
import {SESSION_COOKIE} from '../src/scope/http.js';
import {Accounts} from '../src/scope/accounts.js';

const password='Synthetic-account-password-01';
const replacement='Synthetic-replacement-password-02';
const protocol={'x-mote-protocol-version':'2'};
const headers=(token:string)=>({...protocol,authorization:'Bearer '+token});
async function fixture(t:TestContext,setup?:(node:Awaited<ReturnType<typeof buildApp>>)=>void){
 const root=mkdtempSync(join(tmpdir(),'mote-m01-auth-')),node=await buildApp({dataDir:root});
 t.after(async()=>{await node.app.close();rmSync(root,{recursive:true,force:true});});setup?.(node);
 const admin=await node.accounts.initialize('fixture-admin',password);
 const request=(method:any,url:string,payload?:any,extra:any={})=>node.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{...protocol,...extra}});
 const login=async(username:string,mode:'client'|'web'='client',pwd=password)=>{const r=await request('POST','/api/auth/login',{username,password:pwd,mode,durationMs:86400000});assert.equal(r.statusCode,200,r.body);return {r,...r.json()};};
 const owner=await login('fixture-admin');
 const create=async(username:string,administrator=false)=>{const r=await request('POST','/api/admin/accounts',{username,password,administrator},headers(owner.token));assert.equal(r.statusCode,200,r.body);return r.json();};
 const a=await create('fixture-a'),b=await create('fixture-b');
 const alice=await login(a.username),bob=await login(b.username);
 const cookieHeaders=(web:any)=>({...protocol,cookie:String(web.r.headers['set-cookie']).split(';')[0],'x-mote-session-id':web.credentialId,'x-mote-csrf':web.csrfToken});
 return {root,node,request,login,owner,admin,a,b,alice,bob,cookieHeaders};
}

test('production authentication creates stable IDs, hashes secrets, separates administration and refuses legacy/spoofed identities',async t=>{
 const f=await fixture(t);
 assert.notEqual(f.a.userId,f.b.userId);assert.equal((await f.login('FIXTURE-A')).userId,f.a.userId);
 assert.equal((await f.request('GET','/api/admin/accounts',undefined,headers(f.alice.token))).statusCode,403);
 const listed=await f.request('GET','/api/admin/accounts',undefined,headers(f.owner.token));assert.equal(listed.json().items.length,3);assert.doesNotMatch(listed.body,/password|hash|salt|token/);
 assert.equal((await f.request('POST','/api/admin/accounts',{username:'fixture-a',password},headers(f.owner.token))).statusCode,409);
 for(const extra of [{},{authorization:'Bearer old-owner-token'},{...headers(f.alice.token),'x-user-id':f.b.userId},{...headers(f.alice.token),'x-owner-id':f.b.userId}])assert.equal((await f.request('GET','/api/auth/self',undefined,extra)).statusCode,401);
 assert.equal((await f.request('GET','/api/auth/self?userId='+f.b.userId,undefined,headers(f.alice.token))).statusCode,401);
 assert.equal((await f.request('POST','/api/login/session',{userId:f.b.userId},headers(f.alice.token))).statusCode,401);
 assert.equal((await f.node.app.inject({url:'/api/auth/self',headers:{authorization:'Bearer '+f.alice.token}})).statusCode,426);
 assert.equal((await f.request('GET','/api/materials',undefined,headers(f.owner.token))).statusCode,200);
 assert.equal(readdirSync(f.root).includes('access-token'),false);
 const db=new DatabaseSync(join(f.root,'mote.sqlite'),{readOnly:true});try{for(const table of ['auth_accounts','auth_credentials']){const saved=JSON.stringify(db.prepare('SELECT * FROM '+table).all());assert.ok(!saved.includes(password));for(const token of [f.owner.token,f.alice.token,f.bob.token])assert.ok(!saved.includes(token));}}finally{db.close();}
 await assert.rejects(f.node.accounts.initialize('second-admin',password),{code:'already_initialized'});
});

test('Web sessions use protected cookies, recover CSRF on reload, and reject cross-site, ambiguous and stale-tab requests',async t=>{
 const f=await fixture(t),web=await f.login('fixture-a','web'),cookie=f.cookieHeaders(web);
 assert.match(String(web.r.headers['set-cookie']),/Secure; HttpOnly; SameSite=Strict; Max-Age=86400/);assert.equal(web.token,undefined);assert.equal(web.r.json().token,undefined);
 const self=await f.request('GET','/api/auth/self',undefined,{cookie:cookie.cookie});assert.equal(self.statusCode,200);assert.equal(self.json().csrfToken,web.csrfToken);
 for(const extra of [{...cookie,'x-mote-csrf':''},{...cookie,'x-mote-session-id':''},{...cookie,origin:'https://attacker.invalid'},{...cookie,'sec-fetch-site':'cross-site'}])assert.notEqual((await f.request('POST','/api/login/ticket',{},extra)).statusCode,200);
 assert.equal((await f.request('GET','/api/auth/self',undefined,{...cookie,authorization:'Bearer '+f.alice.token})).statusCode,401);
 const cookieToken=cookie.cookie.slice(SESSION_COOKIE.length+1);assert.equal((await f.request('GET','/api/auth/self',undefined,headers(cookieToken))).statusCode,401);
 const b=await f.login('fixture-b','web');assert.equal((await f.request('POST','/api/login/ticket',{}, {...f.cookieHeaders(b),'x-mote-session-id':web.credentialId,'x-mote-csrf':web.csrfToken})).statusCode,409);
 assert.equal((await f.request('POST','/api/auth/login',{username:'fixture-a',password,mode:'web'},{origin:'https://attacker.invalid'})).statusCode,403);
 assert.equal((await f.request('POST','/api/auth/login','username=x',{'content-type':'text/plain'})).statusCode,415);
 const logout=await f.request('POST','/api/auth/logout',{},cookie);assert.equal(logout.statusCode,200);assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
 assert.equal((await f.request('GET','/api/auth/self',undefined,cookie)).statusCode,401);assert.equal((await f.request('GET','/api/auth/self',undefined,headers(f.alice.token))).statusCode,200);
});

test('password change, administrator reset and disable revoke all account credentials, preserve identity and do not affect B',async t=>{
 const f=await fixture(t);
 let r=await f.request('POST','/api/auth/password',{currentPassword:password,password:replacement},headers(f.alice.token));assert.equal(r.statusCode,200);
 assert.equal((await f.request('GET','/api/auth/self',undefined,headers(f.alice.token))).statusCode,401);
 assert.equal((await f.request('POST','/api/auth/login',{username:'fixture-a',password,mode:'client'})).statusCode,401);
 const next=await f.login('fixture-a','client',replacement);assert.equal(next.userId,f.a.userId);
 r=await f.request('POST',`/api/admin/accounts/${f.a.userId}/password`,{password},headers(f.owner.token));assert.equal(r.statusCode,200);
 assert.equal((await f.request('GET','/api/auth/self',undefined,headers(next.token))).statusCode,401);
 const restored=await f.login('fixture-a');assert.equal(restored.userId,f.a.userId);
 assert.equal((await f.request('PATCH',`/api/admin/accounts/${f.a.userId}`,{disabled:true},headers(f.owner.token))).statusCode,200);
 assert.equal((await f.request('GET','/api/auth/self',undefined,headers(restored.token))).statusCode,401);
 assert.equal((await f.request('POST','/api/auth/login',{username:'fixture-a',password,mode:'client'})).statusCode,401);
 assert.equal((await f.request('PATCH',`/api/admin/accounts/${f.a.userId}`,{disabled:false},headers(f.owner.token))).statusCode,200);
 assert.equal((await f.login('fixture-a')).userId,f.a.userId);
 assert.equal((await f.request('GET','/api/auth/self',undefined,headers(f.bob.token))).statusCode,200);
 assert.equal((await f.request('PATCH',`/api/admin/accounts/${f.admin.userId}`,{disabled:true},headers(f.owner.token))).statusCode,409);
});

test('device and MCP credentials belong to the authenticated account even for identical device/source IDs; MCP cannot become a client',async t=>{
 const f=await fixture(t),input={serverUrl:'https://fixture.invalid',deviceId:'same-device',deviceName:'Synthetic device',platform:'other'};
 const a=(await f.request('POST','/api/login/session',input,headers(f.alice.token))).json(),b=(await f.request('POST','/api/login/session',input,headers(f.bob.token))).json();
 assert.equal(a.userId,f.a.userId);assert.equal(b.userId,f.b.userId);assert.notEqual(a.token,b.token);
 const inventory=await f.request('GET','/api/connections',undefined,headers(f.alice.token));assert.ok(inventory.json().items.some((c:any)=>c.id===a.credentialId));assert.ok(!inventory.body.includes(b.credentialId));
 assert.equal((await f.request('DELETE','/api/connections/'+b.credentialId,{},headers(f.alice.token))).statusCode,404);
 assert.equal((await f.request('DELETE','/api/connections/'+b.credentialId,{},headers(f.owner.token))).statusCode,404);
 const mcp=(await f.request('POST','/api/connections/mcp',{access:'write',sourceIds:['same-source'],label:'Synthetic MCP'},headers(f.alice.token))).json();
 const authorization=f.node.accounts.mcpAuthorization(mcp.token)!;assert.equal(authorization.identity.userId,f.a.userId);assert.deepEqual(authorization.sourceIds,['same-source']);assert.equal(authorization.write,true);
 for(const url of ['/api/auth/self','/api/admin/accounts'])assert.equal((await f.request('GET',url,undefined,headers(mcp.token))).statusCode,401);
 assert.equal((await f.request('POST','/api/login/session',input,headers(mcp.token))).statusCode,401);
 await f.request('DELETE','/api/connections/'+mcp.credentialId,{},headers(f.alice.token));assert.throws(()=>authorization.assertCurrent(),{code:'invalid_identity'});
});

test('the existing one-use ticket and PKCE handoffs remain bound to their account through reversed approvals and parent revocation',async t=>{
 const f=await fixture(t),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('hex');
 const input={serverUrl:'https://fixture.invalid',deviceId:'same-device',deviceName:'Synthetic native',platform:'other',challenge};
 const first=(await f.request('POST','/api/login/requests',input)).json(),second=(await f.request('POST','/api/login/requests',input)).json();
 assert.equal((await f.request('POST',`/api/login/requests/${second.id}/approve`,{},headers(f.bob.token))).statusCode,200);
 assert.equal((await f.request('POST',`/api/login/requests/${first.id}/approve`,{},headers(f.alice.token))).statusCode,200);
 assert.equal((await f.request('POST',`/api/login/requests/${first.id}/approve`,{},headers(f.bob.token))).statusCode,403);
 const a=(await f.request('POST','/api/login/poll',{id:first.id,verifier})).json(),b=(await f.request('POST','/api/login/poll',{id:second.id,verifier})).json();assert.equal(a.userId,f.a.userId);assert.equal(b.userId,f.b.userId);
 assert.notEqual((await f.request('POST','/api/login/poll',{id:first.id,verifier:'x'.repeat(43)})).statusCode,200);
 await f.request('POST','/api/login/ack',{id:first.id,verifier});assert.equal((await f.request('POST','/api/login/poll',{id:first.id,verifier})).statusCode,410);
 assert.equal((await f.request('POST','/api/login/ticket',{},headers(a.token))).statusCode,403);
 const ticket=(await f.request('POST','/api/login/ticket',{},headers(f.alice.token))).json();
 const webResponse=await f.request('POST','/api/login/exchange',ticket);assert.equal(webResponse.statusCode,200);assert.equal(webResponse.json().userId,f.a.userId);assert.equal(webResponse.json().token,undefined);
 assert.equal((await f.request('POST','/api/login/exchange',ticket)).statusCode,410);
 const web={r:webResponse,...webResponse.json()};assert.equal((await f.request('GET','/api/auth/self',undefined,f.cookieHeaders(web))).statusCode,200);
 await f.request('POST','/api/auth/logout',{},headers(f.alice.token));assert.equal((await f.request('GET','/api/auth/self',undefined,f.cookieHeaders(web))).statusCode,401);
 assert.equal((await f.request('GET','/api/connections/self',undefined,headers(a.token))).statusCode,200);
 await f.request('POST','/api/auth/logout',{},headers(a.token));assert.equal((await f.request('GET','/api/connections/self',undefined,headers(a.token))).statusCode,401);
 const revoked=(await f.request('POST','/api/login/ticket',{},headers(f.bob.token))).json();await f.request('POST','/api/auth/logout',{},headers(f.bob.token));assert.equal((await f.request('POST','/api/login/exchange',revoked)).statusCode,401);
});

test('production route contexts keep simultaneous sessions separate, reject admin identity selectors, and fence disabled late commits/responses',async t=>{
 const rows=new Map<string,string>();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);let committed=false;
 const f=await fixture(t,node=>{
 node.services.registerUser('auth-test',{scope:'user',create:()=>({}),lifecycle:{exportUser:async c=>({domain:'auth-test',version:1,deploymentId:c.deploymentId,userId:c.userId,payload:rows.get(c.userId)}),deleteUser:async(_c,operationId)=>({status:'complete',operationId}),restoreUser:async()=>{}}});
 registerUserRoute(node,{scope:'user',method:'POST',url:'/api/auth-test',service:'auth-test',handle:async({context,request})=>{if((request.body as any).wait){entered();await wait;if((request.body as any).commit){node.authority.assert(context);committed=true;}}return {value:rows.get(context.userId)};}});
 });rows.set(f.a.userId,'Synthetic A');rows.set(f.b.userId,'Synthetic B');rows.set(f.admin.userId,'Synthetic admin');
 for(const [token,value] of [[f.alice.token,'Synthetic A'],[f.bob.token,'Synthetic B'],[f.owner.token,'Synthetic admin']])assert.equal((await f.request('POST','/api/auth-test',{},headers(token))).json().value,value);
 assert.equal((await f.request('POST','/api/auth-test',{userId:f.b.userId},headers(f.owner.token))).statusCode,401);
 const late=f.request('POST','/api/auth-test',{wait:true,commit:true},headers(f.alice.token));await started;
 await f.request('PATCH',`/api/admin/accounts/${f.a.userId}`,{disabled:true},headers(f.owner.token));release();assert.equal((await late).statusCode,401);assert.equal(committed,false);
 assert.equal((await f.request('POST','/api/auth-test',{},headers(f.bob.token))).json().value,'Synthetic B');
});

test('expiry and a second SQLite connection invalidate already issued contexts; logout does not revoke durable account authorization',async t=>{
 const f=await fixture(t),context=await f.node.authority.authenticate(f.alice.token),db=new DatabaseSync(join(f.root,'mote.sqlite'));
 try{await f.request('POST','/api/auth/logout',{},headers(f.alice.token));assert.throws(()=>f.node.authority.assert(context));f.node.accounts.assertAccountEnabled(f.a.userId,context.authorizationEpoch);
 const next=await f.login('fixture-a');const current=await f.node.authority.authenticate(next.token);db.prepare('UPDATE auth_credentials SET expires_at=0 WHERE id=?').run(next.credentialId);assert.throws(()=>f.node.authority.assert(current));
 const third=await f.login('fixture-a');const current3=await f.node.authority.authenticate(third.token);db.prepare('UPDATE auth_accounts SET disabled=1,authorization_epoch=authorization_epoch+1 WHERE user_id=?').run(f.a.userId);assert.throws(()=>f.node.authority.assert(current3));assert.throws(()=>f.node.accounts.assertAccountEnabled(f.a.userId,current3.authorizationEpoch));
 }finally{db.close();}
});

test('password-attempt protection persists and limits authentication without applying business API quotas',async t=>{
 const f=await fixture(t);
 for(let i=0;i<5;i++)assert.equal((await f.request('POST','/api/auth/login',{username:'unknown-fixture',password:'wrong-password',mode:'client'})).statusCode,401);
 assert.equal((await f.request('POST','/api/auth/login',{username:'unknown-fixture',password:'wrong-password',mode:'client'})).statusCode,429);
 for(let i=0;i<30;i++)assert.equal((await f.request('GET','/api/auth/self',undefined,headers(f.bob.token))).statusCode,200);
 const db=new DatabaseSync(join(f.root,'mote.sqlite'));try{assert.ok(Number(db.prepare('SELECT count(*) n FROM auth_attempts').get()!.n)>0);const restarted=new Accounts(db,f.node.deploymentId);await assert.rejects(restarted.login('unknown-fixture','wrong-password','127.0.0.1','client',0),{code:'login_throttled'});restarted.close();db.exec('UPDATE auth_attempts SET started_at=0');}finally{db.close();}
 assert.equal((await f.request('POST','/api/auth/login',{username:'unknown-fixture',password:'wrong-password',mode:'client'})).statusCode,401);
});

test('actual stdin initialization entry creates only a synthetic admin and never prints passwords or issues a reusable credential',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-m01-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config=join(root,'config.yaml'),directory=join(root,'vault');writeFileSync(config,serializeConfigDocument({version:1,revision:0,storage:{dataDir:directory},server:{host:'127.0.0.1',port:0}}));
 const entry=fileURLToPath(new URL('../src/scope/initialize-admin.ts',import.meta.url));
 const options={env:{...process.env,MOTE_CONFIG_FILE:config},input:JSON.stringify({username:'synthetic-admin',password}),encoding:'utf8' as const,timeout:15000};
 const output=execFileSync(process.execPath,['--import','tsx',entry],options);assert.match(output,/account.initialized/);assert.ok(!output.includes(password));assert.ok(!output.includes('token'));
 const saved=()=>{const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});try{return {accounts:db.prepare('SELECT * FROM auth_accounts').all(),credentials:db.prepare('SELECT * FROM auth_credentials').all()};}finally{db.close();}};
 const before=saved();assert.throws(()=>execFileSync(process.execPath,['--import','tsx',entry],{...options,stdio:['pipe','pipe','pipe']}));assert.deepEqual(saved(),before);assert.equal(before.credentials.length,0);
});


test('authentication composes with a binary private route while Cookie mutations still require CSRF',async t=>{
 const f=await fixture(t,node=>{
  node.app.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  node.services.registerUser('binary-test',{scope:'user',create:()=>({}),lifecycle:{exportUser:async c=>({domain:'binary-test',version:1,deploymentId:c.deploymentId,userId:c.userId,payload:null}),deleteUser:async(_c,operationId)=>({status:'complete',operationId}),restoreUser:async()=>{}}});
  registerUserRoute(node,{scope:'user',method:'POST',url:'/api/binary-test',service:'binary-test',handle:({context,request})=>({userId:context.userId,bytes:Buffer.isBuffer(request.body)?request.body.length:0})});
 });
 const binary=(extra:any)=>f.node.app.inject({method:'POST',url:'/api/binary-test',headers:{...protocol,...extra,'content-type':'application/octet-stream'},payload:Buffer.from('generated-binary')});
 const native=await binary(headers(f.alice.token));assert.equal(native.statusCode,200);assert.equal(native.json().bytes,16);assert.equal(native.json().userId,f.a.userId);
 const web=await f.login('fixture-b','web'),cookie=f.cookieHeaders(web);assert.equal((await binary({...cookie,'x-mote-csrf':''})).statusCode,403);const current=await binary(cookie);assert.equal(current.statusCode,200);assert.equal(current.json().userId,f.b.userId);
});


test('disable during password hashing prevents credential issuance and disable during current-password verification prevents late password change',async t=>{
 const f=await fixture(t),admin=await f.node.authority.authenticate(f.owner.token),alice=await f.node.authority.authenticate(f.alice.token);
 const pendingLogin=f.node.accounts!.login('fixture-a',password,'generated-race-address','client',86400000);
 f.node.accounts!.disable(admin,f.node.authority,f.a.userId,true);
 await assert.rejects(pendingLogin,{code:'invalid_login'});
 f.node.accounts!.disable(admin,f.node.authority,f.a.userId,false);
 const current=await f.login('fixture-a'),context=await f.node.authority.authenticate(current.token);
 const pendingChange=f.node.accounts!.changePassword(context,f.node.authority,password,replacement,'generated-race-address');
 f.node.accounts!.disable(admin,f.node.authority,f.a.userId,true);
 await assert.rejects(pendingChange,{code:'invalid_identity'});
 assert.throws(()=>f.node.authority.assert(alice));
 assert.equal((await f.request('GET','/api/auth/self',undefined,headers(f.bob.token))).statusCode,200);
});

test('revoking another credential still fences the response if the caller is disabled before publication',async t=>{
 const f=await fixture(t),other=await f.login('fixture-a');
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const original=f.node.accounts!.revoke.bind(f.node.accounts);
 t.mock.method(f.node.accounts!,'revoke',(...args:Parameters<Accounts['revoke']>)=>{const result=original(...args);if(args[2]===other.credentialId){entered();return wait.then(()=>result);}return result;});
 const pending=f.request('DELETE','/api/connections/'+other.credentialId,{},headers(f.alice.token));await started;
 assert.equal((await f.request('PATCH',`/api/admin/accounts/${f.a.userId}`,{disabled:true},headers(f.owner.token))).statusCode,200);
 release();assert.equal((await pending).statusCode,401);
 assert.equal((await f.request('GET','/api/auth/self',undefined,headers(f.bob.token))).statusCode,200);
});
