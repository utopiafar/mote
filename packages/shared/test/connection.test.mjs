import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionInvitation, encodeConnectionInvitation, connectionUri, connectionServerUrl } from '../dist/connection.js';

const now = Date.parse('2026-09-14T01:00:00Z');
const invitation = {format:'mote.connection',version:1,serverUrl:'https://mote.example.com',code:'a'.repeat(43),expiresAt:'2026-09-14T01:10:00.000Z'};

test('portable connection JSON and QR URI round trip without an owner token', () => {
  const json = encodeConnectionInvitation(invitation, now);
  assert.deepEqual(parseConnectionInvitation(json, now), invitation);
  assert.deepEqual(parseConnectionInvitation(connectionUri(invitation, now), now), invitation);
  assert.equal(json.includes('token'), false);
  assert.equal(connectionServerUrl('https://mote.example.com:443/'), 'https://mote.example.com');
  for (const url of ['http://127.0.0.1:47832','http://localhost:47832','http://[::1]:47832']) assert.equal(connectionServerUrl(url),url);
});

test('untrusted invitations reject credentials, unsupported formats, stale codes and unsafe endpoints', () => {
  for (const patch of [{format:'mcpServers'},{version:2},{token:'do-not-share'},{code:'short'},{expiresAt:'yesterday'},{expiresAt:'2026-09-14T01:00:00Z'},{serverUrl:'http://192.168.1.20:47832'},{serverUrl:'https://user:password@example.com'},{serverUrl:'https://example.com/subpath'},{serverUrl:'https://example.com/?token=secret'},{serverUrl:'https://example.com/#token'}]) assert.throws(()=>parseConnectionInvitation(JSON.stringify({...invitation,...patch}),now));
  assert.throws(()=>parseConnectionInvitation('{bad json',now));
  assert.throws(()=>parseConnectionInvitation(' '.repeat(8193),now));
  assert.throws(()=>parseConnectionInvitation('心'.repeat(3000),now));
  assert.throws(()=>parseConnectionInvitation(JSON.stringify({mcpServers:{mote:{command:'arbitrary'}}}),now));
});

test('QR parser refuses ambiguous URI shapes and broken UTF8 without echoing the input', () => {
  const uri = connectionUri(invitation,now);
  for (const input of [uri+'&next=https://attacker.example',uri+'#fragment',uri.replace('connect?','connect/?'),uri+'=', 'mote://connect?data=_w']) assert.throws(()=>parseConnectionInvitation(input,now));
  const sentinel = 'secret-code-sentinel';
  try {parseConnectionInvitation(sentinel,now);assert.fail();} catch (error) {assert.equal(error.message.includes(sentinel),false);}
});
