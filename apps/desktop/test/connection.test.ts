import { expect, it } from 'vitest';
import { ConnectionOnboarding, testConnection, assertConnectionChangeSafe, connectionRequest } from '../src/connection';
import { defaultConfig, updateConfig } from '../src/config';
import { readFileSync } from 'node:fs';
const now = 1789350000000, token = 'synthetic-collector-token-' + 'a'.repeat(32);
const invitation = { format: 'mote.connection' as const, version: 2 as const, deploymentId:'generated-deployment',userId:'generated-user',purpose:'device' as const,code: 'a'.repeat(43), serverUrl: 'https://central.example', expiresAt: new Date(now + 60000).toISOString() };
const identity={account:{deploymentId:'generated-deployment',userId:'generated-user',username:'generated-account',administrator:false,disabled:false,authorizationEpoch:0,createdAt:0,credentialId:'fixture-credential'},credential:{kind:'client',expiresAt:Date.now()+86400000,deviceId:'fixture-device'},protocol:{min:2,max:2},capabilities:{authentication:true,ingest:true,ingressVersion:3,archiveRead:false}};
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
it('previews fixed v2 subject without a request or code and confirms only the exact reviewed origin',()=>{
 const onboarding=new ConnectionOnboarding(undefined,()=>now),preview=onboarding.preview(JSON.stringify(invitation));
 expect(preview).toMatchObject({serverUrl:invitation.serverUrl,deploymentId:invitation.deploymentId,userId:invitation.userId});
 expect(JSON.stringify(preview)).not.toContain(invitation.code);
 expect(()=>onboarding.confirm(preview.id,'https://other.example')).toThrow('确认');
 expect(onboarding.confirm(preview.id,preview.serverUrl)).toEqual(invitation);
 onboarding.clear();expect(()=>onboarding.confirm(preview.id,preview.serverUrl)).toThrow('确认');
});
it('retires replaced previews and checks expiry again at confirmation',()=>{
 let clock=now;const onboarding=new ConnectionOnboarding(undefined,()=>clock),old=onboarding.preview(JSON.stringify(invitation));
 const latest=onboarding.preview(JSON.stringify({...invitation,code:'b'.repeat(43)}));
 expect(()=>onboarding.confirm(old.id,old.serverUrl)).toThrow('确认');
 clock+=60001;expect(()=>onboarding.confirm(latest.id,latest.serverUrl)).toThrow('过期');
});
it.each([302,409,500])('uses fixed errors without leaking a provider body or following redirects: %s',async status=>{
 await expect(connectionRequest(invitation.serverUrl,'/api/connections/redeem',{method:'POST'},async(_url,init)=>{expect(init?.redirect).toBe('error');return response({secret:token},status);})).rejects.not.toThrow(token);
});
it.each([[403,'origin_denied','公开地址'],[404,'not_found','资源不存在'],[426,'incompatible_protocol','协议版本'],[410,'login_expired','登录请求']])('does not infer an upgrade or device conflict from HTTP alone: %s',async(status,code,expected)=>{
 await expect(connectionRequest(invitation.serverUrl,'/api/login/poll',{method:'POST'},async()=>response({error:code,message:'PRIVATE_DETAIL'},Number(status)))).rejects.toThrow(String(expected));
});
it('keeps explicit expired-invitation guidance without treating any bad request as expiry',async()=>{
 await expect(connectionRequest(invitation.serverUrl,'/api/connections/redeem',{method:'POST'},async()=>response({error:'invitation_invalid_or_expired'},410))).rejects.toThrow('邀请无效');
 await expect(connectionRequest(invitation.serverUrl,'/api/connections/redeem',{method:'POST'},async()=>response({error:'invalid_request'},400))).rejects.toThrow('输入格式');
});
it('validates connection scope, device binding and bounded responses', async () => {
  const config = { serverUrl: invitation.serverUrl, token, deviceId: 'fixture-device' };
  const result = await testConnection(config, async (_url, init) => { expect(init?.headers).toEqual({ Authorization: 'Bearer ' + token, 'Accept-Language': 'zh-CN', 'X-Mote-Protocol-Version': '2' }); expect(init?.redirect).toBe('error'); return response(identity); });
  expect(result.credential.scope).toBe('client'); expect(result.capabilities.ingressVersion).toBe(3); expect(JSON.stringify(result)).not.toContain(token);
  for (const bad of [{ ...identity, credential: { ...identity.credential, scope: 'collector' } }, { ...identity, credential: { ...identity.credential, scope: 'mcp' } }, { ...identity, credential: { ...identity.credential, deviceId: 'other' } }, { ...identity, capabilities: { ...identity.capabilities, ingressVersion: '2' } }, { ...identity, credential: { ...identity.credential, token } }]) await expect(testConnection(config, async () => response(bad))).rejects.toThrow();
  await expect(testConnection(config, async () => new Response('x'.repeat(16385)))).rejects.toThrow();
});
const protocolFixtures = JSON.parse(readFileSync(new URL('../../../protocol/fixtures/compatibility.json', import.meta.url), 'utf8')) as Array<{name:string;protocol?:unknown;expected?:{min:number;max:number};error?:string}>;
it.each(protocolFixtures)('enforces generated compatibility for independent product versions: $name', async fixture => {
  const protocol=fixture.protocol;
  const checked = testConnection({ serverUrl: invitation.serverUrl, token, deviceId: 'fixture-device' }, async () => response({ ...identity,protocol }));
  if (fixture.error) await expect(checked).rejects.toMatchObject({ code: fixture.error === 'incompatible_protocol' ? 'PROTOCOL_INCOMPATIBLE' : 'INVALID_RESPONSE' });
  else expect((await checked).protocol).toEqual(fixture.expected);
});
it('blocks changing node or credential for pending screenshots, prepared notes, paused source bodies or in-flight work', () => {
  const empty = { running: false, inFlight: false, queued: 0, preparedNote: false, sourcePending: 0, sourceInFlight: false };
  expect(() => assertConnectionChangeSafe(empty)).not.toThrow();
  for (const state of [{ running: true }, { inFlight: true }, { queued: 1 }, { preparedNote: true }, { sourcePending: 1 }, { sourceInFlight: true }]) expect(() => assertConnectionChangeSafe({ ...empty, ...state })).toThrow();
  const config = { ...defaultConfig(), token, credentialScope: 'owner' as const };
  expect(() => updateConfig(config, { ...config, token: 'new-token' }, 1)).toThrow('待上传');
  expect(updateConfig(config, { ...config, token: undefined }).credentialScope).toBe('owner');
  expect(updateConfig(config, { ...config, token: 'new-token' }).credentialScope).toBeUndefined();
});

it('allows explicitly confirmed same-node invitations to resume pending data only after all work has drained', () => {
  const pending = { running: false, inFlight: false, queued: 5, preparedNote: true, sourcePending: 2, sourceInFlight: false };
  expect(() => assertConnectionChangeSafe(pending, true)).not.toThrow();
  expect(() => assertConnectionChangeSafe(pending, false)).toThrow('待上传');
  for (const state of [{ running: true }, { inFlight: true }, { sourceInFlight: true }]) expect(() => assertConnectionChangeSafe({ ...pending, ...state }, true)).toThrow();
});

it('accepts a registered personal client identity and rejects owner or MCP response shapes',async()=>{
 const config={serverUrl:invitation.serverUrl,token,deviceId:'fixture-device'};
 expect((await testConnection(config,async()=>response(identity))).capabilities.ingressVersion).toBe(3);
 for(const scope of ['collector','mcp'])await expect(testConnection(config,async()=>response({...identity,credential:{...identity.credential,scope},capabilities:{...identity.capabilities,archiveRead:true}}))).rejects.toMatchObject({code:'INVALID_RESPONSE'});
});
