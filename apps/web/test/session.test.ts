import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSession } from '../src/session.js';

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
