import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOTE_PROTOCOL_RANGE, MOTE_PROTOCOL_HEADER, MOTE_PROTOCOL_HEADERS, ProtocolCompatibilityError, requireCompatibleProtocol } from '../dist/protocol.js';

const contract = JSON.parse(readFileSync(new URL('../../../protocol/contract.json', import.meta.url), 'utf8'));
const fixtures = JSON.parse(readFileSync(new URL('../../../protocol/fixtures/compatibility.json', import.meta.url), 'utf8'));
test('runtime wire metadata matches the independently versioned contract', () => {
  assert.deepEqual(MOTE_PROTOCOL_RANGE, contract.range);
  assert.equal(MOTE_PROTOCOL_HEADER, contract.metadataRequestHeader);
  assert.deepEqual(MOTE_PROTOCOL_HEADERS, { [contract.metadataRequestHeader]: String(contract.range.max) });
  assert.throws(()=>requireCompatibleProtocol(undefined),error=>error.code==='invalid_protocol_range');
});
for (const fixture of fixtures) test(`generated wire compatibility: ${fixture.name}`, () => {
  if (fixture.error) assert.throws(() => requireCompatibleProtocol(fixture.protocol), error => error instanceof ProtocolCompatibilityError && error.code === fixture.error);
  else assert.deepEqual(requireCompatibleProtocol(fixture.protocol), fixture.expected);
});
test('compatibility requires overlap for each supported range', () => {
  assert.deepEqual(requireCompatibleProtocol({ min: 1, max: 3 }, { min: 2, max: 2 }), { min: 1, max: 3 });
  assert.throws(() => requireCompatibleProtocol(undefined, { min: 2, max: 2 }), error => error.code === 'invalid_protocol_range');
});
