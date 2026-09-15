import { expect, it } from 'vitest';
import { ConnectionOnboarding, testConnection, assertConnectionChangeSafe } from '../src/connection';
import { connectionUri } from '@mote/shared/connection';
import { defaultConfig, updateConfig } from '../src/config';
const now = 1789350000000, token = 'synthetic-collector-token-' + 'a'.repeat(32);
const invitation = { format: 'mote.connection' as const, version: 1 as const, code: 'a'.repeat(43), serverUrl: 'https://central.example', expiresAt: new Date(now + 60000).toISOString() };
const identity = { credential: { id: 'fixture-credential', scope: 'collector', label: 'Synthetic Mac', deviceId: 'fixture-device' }, node: { version: '0.6.0', profile: 'test' }, capabilities: { ingest: true, ownSources: true, archiveRead: false } };
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
it('previews JSON and URI without network or disclosing the invitation code, then requires the exact reviewed origin', async () => {
  let calls = 0; const value = new ConnectionOnboarding(async () => { calls++; return response({ serverUrl: invitation.serverUrl, token, credentialId: 'fixture-credential', scope: 'collector' }); }, () => now);
  const preview = value.preview(connectionUri(invitation, now)); expect(preview.serverUrl).toBe(invitation.serverUrl); expect(JSON.stringify(preview)).not.toContain(invitation.code); expect(calls).toBe(0);
  await expect(value.redeem(preview.id, 'https://other.example', { deviceId: 'fixture-device', deviceName: 'Synthetic' }, 'macos')).rejects.toThrow('确认'); expect(calls).toBe(0);
  expect(await value.redeem(preview.id, preview.serverUrl, { deviceId: 'fixture-device', deviceName: 'Synthetic' }, 'macos')).toMatchObject({ token, scope: 'collector' }); expect(calls).toBe(1);
  await expect(value.redeem(preview.id, preview.serverUrl, { deviceId: 'fixture-device', deviceName: 'Synthetic' }, 'macos')).rejects.toThrow('确认');
});
it('rejects expired confirmation, oversized input and unsafe invitations before any request', async () => {
  let time = now, calls = 0; const value = new ConnectionOnboarding(async () => { calls++; return response({}); }, () => time);
  const preview = value.preview(JSON.stringify(invitation)); time += 60001;
  await expect(value.redeem(preview.id, preview.serverUrl, { deviceId: 'fixture-device', deviceName: 'Synthetic' }, 'macos')).rejects.toThrow('过期');
  for (const input of ['x'.repeat(8193), JSON.stringify({ ...invitation, serverUrl: 'http://remote.example' }), JSON.stringify({ ...invitation, ownerToken: token })]) expect(() => value.preview(input)).toThrow(); expect(calls).toBe(0);
});
it('uses the latest invitation for repeated pairing and rejects a replaced preview without exchanging it', async () => {
  const requests: Array<{ url: string; code: string }> = [];
  const value = new ConnectionOnboarding(async (url, init) => {
    requests.push({ url: String(url), code: JSON.parse(String(init?.body)).code });
    return response({ serverUrl: new URL(String(url)).origin, token: token + requests.length, credentialId: 'fixture-' + requests.length, scope: 'collector' });
  }, () => now);
  const device = { deviceId: 'fixture-device', deviceName: 'Synthetic' };
  const first = value.preview(connectionUri(invitation, now));
  expect((await value.redeem(first.id, first.serverUrl, device, 'macos')).token).toBe(token + '1');
  const stale = value.preview(JSON.stringify({ ...invitation, code: 'b'.repeat(43) }));
  const second = value.preview(JSON.stringify({ ...invitation, code: 'c'.repeat(43) }));
  await expect(value.redeem(stale.id, stale.serverUrl, device, 'macos')).rejects.toThrow('确认');
  expect((await value.redeem(second.id, second.serverUrl, device, 'macos')).token).toBe(token + '2');
  const third = value.preview(JSON.stringify({ ...invitation, code: 'd'.repeat(43), serverUrl: 'https://second.example' }));
  expect((await value.redeem(third.id, third.serverUrl, device, 'macos')).serverUrl).toBe('https://second.example');
  expect(requests).toEqual([
    { url: invitation.serverUrl + '/api/connections/redeem', code: invitation.code },
    { url: invitation.serverUrl + '/api/connections/redeem', code: 'c'.repeat(43) },
    { url: 'https://second.example/api/connections/redeem', code: 'd'.repeat(43) },
  ]);
});
it('never sends saved credentials during redemption and rejects response origin/scope/token mismatches', async () => {
  for (const bad of [{ serverUrl: 'https://other.example' }, { scope: 'owner' }, { token: 'short' }, { token: 'a'.repeat(32) + '\n' }, { ownerToken: token }]) {
    const value = new ConnectionOnboarding(async (url, init) => { expect(url).toBe(invitation.serverUrl + '/api/connections/redeem'); expect(init?.redirect).toBe('error'); expect(init?.headers).not.toHaveProperty('Authorization'); expect(JSON.parse(String(init?.body))).toEqual({ code: invitation.code, deviceId: 'fixture-device', deviceName: 'Synthetic', platform: 'macos' }); return response({ serverUrl: invitation.serverUrl, token, credentialId: 'fixture-credential', scope: 'collector', ...bad }); }, () => now);
    const preview = value.preview(JSON.stringify(invitation)); await expect(value.redeem(preview.id, preview.serverUrl, { deviceId: 'fixture-device', deviceName: 'Synthetic' }, 'macos')).rejects.toThrow();
  }
});
it('returns fixed network/409 errors without provider body or token leakage and never follows redirects', async () => {
  for (const code of [302, 409, 500]) {
    let calls = 0; const value = new ConnectionOnboarding(async (_url, init) => { calls++; expect(init?.redirect).toBe('error'); return response({ secret: token }, code); }, () => now);
    const preview = value.preview(JSON.stringify(invitation)); const failure = value.redeem(preview.id, preview.serverUrl, { deviceId: 'fixture-device', deviceName: 'Synthetic' }, 'macos');
    await expect(failure).rejects.not.toThrow(token); if (code === 409) await expect(failure).rejects.toThrow('选择此设备'); expect(calls).toBe(1);
  }
});
it('validates connection scope, device binding and bounded responses', async () => {
  const config = { serverUrl: invitation.serverUrl, token, deviceId: 'fixture-device' };
  const result = await testConnection(config, async (_url, init) => { expect(init?.headers).toEqual({ Authorization: 'Bearer ' + token }); expect(init?.redirect).toBe('error'); return response(identity); });
  expect(result.credential.scope).toBe('collector'); expect(JSON.stringify(result)).not.toContain(token);
  for (const bad of [{ ...identity, credential: { ...identity.credential, deviceId: 'other' } }, { ...identity, capabilities: { ...identity.capabilities, archiveRead: true } }, { ...identity, credential: { ...identity.credential, token } }]) await expect(testConnection(config, async () => response(bad))).rejects.toThrow();
  await expect(testConnection(config, async () => new Response('x'.repeat(16385)))).rejects.toThrow();
});
it('blocks changing node or credential for pending screenshots, prepared notes, paused source bodies or in-flight work', () => {
  const empty = { running: false, inFlight: false, queued: 0, preparedNote: false, sourcePending: 0, sourceInFlight: false };
  expect(() => assertConnectionChangeSafe(empty)).not.toThrow();
  for (const state of [{ running: true }, { inFlight: true }, { queued: 1 }, { preparedNote: true }, { sourcePending: 1 }, { sourceInFlight: true }]) expect(() => assertConnectionChangeSafe({ ...empty, ...state })).toThrow();
  const config = { ...defaultConfig(), token, credentialScope: 'collector' as const };
  expect(() => updateConfig(config, { ...config, token: 'new-token' }, 1)).toThrow('待上传');
  expect(updateConfig(config, { ...config, token: undefined }).credentialScope).toBe('collector');
  expect(updateConfig(config, { ...config, token: 'new-token' }).credentialScope).toBeUndefined();
});

it('allows explicitly confirmed same-node invitations to resume pending data only after all work has drained', () => {
  const pending = { running: false, inFlight: false, queued: 5, preparedNote: true, sourcePending: 2, sourceInFlight: false };
  expect(() => assertConnectionChangeSafe(pending, true)).not.toThrow();
  expect(() => assertConnectionChangeSafe(pending, false)).toThrow('待上传');
  for (const state of [{ running: true }, { inFlight: true }, { sourceInFlight: true }]) expect(() => assertConnectionChangeSafe({ ...pending, ...state }, true)).toThrow();
});
