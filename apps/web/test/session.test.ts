import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionForLifetime, restoreSession, sessionLifetime } from '../src/session.js';

const origin = 'https://mote.example';
test('restores current-service sessions and migrates old same-service credentials', () => {
  for (const value of [{token:'fixture'}, {url:'',token:'fixture'}, {url:origin,token:'fixture'}]) {
    assert.deepEqual(restoreSession(JSON.stringify(value), origin), {token:'fixture'});
  }
});
test('does not send a former remote-node credential to the current service', () => {
  for (const value of [{url:'https://other.example',token:'fixture'}, {url:42,token:'fixture'}, {token:''}, {token:42}, null]) {
    assert.equal(restoreSession(JSON.stringify(value), origin), null);
  }
  assert.equal(restoreSession('{', origin), null);
});
test('persistent sessions carry a browser expiry and expired credentials are rejected', () => {
  const now = Date.parse('2026-09-19T00:00:00.000Z');
  const connection = connectionForLifetime('fixture', '7d', now);
  assert.equal(connection.expiresAt, now + 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(restoreSession(JSON.stringify(connection), origin, now + 6 * 24 * 60 * 60 * 1000), connection);
  assert.equal(restoreSession(JSON.stringify(connection), origin, connection.expiresAt!), null);
  assert.equal(restoreSession(JSON.stringify(connection), origin, connection.expiresAt! + 1), null);
  assert.deepEqual(connectionForLifetime('fixture', 'session', now), {token:'fixture'});
});
test('unknown session lifetime values fall back to the safest tab-scoped mode', () => {
  assert.equal(sessionLifetime('30d'), '30d');
  assert.equal(sessionLifetime('forever'), 'session');
  assert.equal(sessionLifetime(undefined), 'session');
});
