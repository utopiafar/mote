import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PluginContractError, PLUGIN_CONTRACT_VERSION, MAX_SNAPSHOT_CONTRIBUTIONS,
  hostKinds, hostIdentitySchema,
  instanceIdentitySchema, scopeIdentitySchema, serviceBindingSchema, serviceContract,
  pluginSnapshotSchema, availabilitySchema, pluginFailureSchema, cancellationSchema,
} from '@mote/plugin-api';

const host = {kind: 'central', id: 'fixture-central-1'};
const instance = {packageId: '@fixture/source', installationId: 'installation-1', instanceId: 'source-a'};
const scope = {...instance, host, activationId: 'activation-1'};
const contribution = {
  identity: {scope, contributionId: 'fixture.original-reader'}, apiVersion: '1.0',
  availability: {state: 'active'}, restartRequired: false,
};
const snapshot = (contributions = [contribution]) => ({schemaVersion: PLUGIN_CONTRACT_VERSION, host, revision: 7, contributions});
const invalid = input => assert.throws(input, error => error instanceof PluginContractError && error.code === 'invalid_contract');

test('runtime DTO roundtrip preserves pinned identities and separate restart/build/revocation states', () => {
  const wire = structuredClone(snapshot([
    {...contribution, restartRequired: true}, // An old accepted generation may remain active until restart.
    {...contribution, identity: {scope: {...scope, instanceId: 'source-b'}, contributionId: 'fixture.original-reader'}, availability: {state: 'requires-build', reason: 'requires_build'}},
    {...contribution, identity: {scope, contributionId: 'fixture.poller'}, availability: {state: 'revoked', reason: 'revoked'}},
  ]));
  const parsed = pluginSnapshotSchema.parse(JSON.parse(JSON.stringify(wire)));
  assert.deepEqual(parsed, wire);
  wire.contributions[0].identity.scope.activationId = 'mutated-after-send';
  assert.equal(parsed.contributions[0].identity.scope.activationId, 'activation-1');
  assert.equal(parsed.contributions[1].identity.scope.instanceId, 'source-b');
  assert.equal(parsed.contributions[2].availability.state, 'revoked');
});

test('iOS is a first-class plugin host kind', () => {
  assert.ok(hostKinds.includes('ios'));
  assert.deepEqual(hostIdentitySchema.parse({kind: 'ios', id: 'generated-ios-host'}), {kind: 'ios', id: 'generated-ios-host'});
});

test('missing required identity or a future wire version cannot silently use current defaults', () => {
  const noInstallation = {...instance}; delete noInstallation.installationId;
  invalid(() => instanceIdentitySchema.parse(noInstallation));
  invalid(() => scopeIdentitySchema.parse({...scope, activationId: ''}));
  invalid(() => pluginSnapshotSchema.parse({...snapshot(), schemaVersion: '1'}));
  assert.throws(() => pluginSnapshotSchema.parse({...snapshot(), schemaVersion: 2}), error => error.code === 'unsupported_contract_version');
  invalid(() => pluginSnapshotSchema.parse({...snapshot(), revision: Number.MAX_SAFE_INTEGER + 1}));
});

test('same package and key stay distinct across instances, reinstalls and activations', () => {
  const binding = {service: {id: 'fixture.original-reader', apiVersion: '1'}, provider: contribution.identity, revision: 3};
  const a = serviceBindingSchema.parse(binding);
  const b = serviceBindingSchema.parse({...binding, provider: {scope: {...scope, instanceId: 'source-b'}, contributionId: 'fixture.original-reader'}});
  const reinstalled = serviceBindingSchema.parse({...binding, provider: {scope: {...scope, installationId: 'installation-2'}, contributionId: 'fixture.original-reader'}});
  const restarted = serviceBindingSchema.parse({...binding, provider: {scope: {...scope, activationId: 'activation-2'}, contributionId: 'fixture.original-reader'}});
  assert.notDeepEqual(a.provider, b.provider);
  assert.notDeepEqual(a.provider, reinstalled.provider);
  assert.notDeepEqual(a.provider, restarted.provider);
  invalid(() => serviceBindingSchema.parse({...binding, value: {db: 'must-stay-local'}}));
  invalid(() => serviceBindingSchema.parse({...binding, service: {id: 'reader', apiVersion: '^1'}}));
});

test('host snapshot refuses mixed host ownership and duplicate contribution identities', () => {
  invalid(() => pluginSnapshotSchema.parse(snapshot([contribution, contribution])));
  invalid(() => pluginSnapshotSchema.parse({...snapshot(), host: {...host, id: 'different-host'}}));
  invalid(() => pluginSnapshotSchema.parse(snapshot(Array.from({length: MAX_SNAPSHOT_CONTRIBUTIONS + 1}, () => contribution))));
  invalid(() => pluginSnapshotSchema.parse({...snapshot(), contributions: new Array(1)}));
});

test('public failure/cancellation data never automatically carries raw exceptions or active signals', () => {
  assert.deepEqual(pluginFailureSchema.parse({code: 'result_unknown', operationId: 'operation-1'}), {code: 'result_unknown', operationId: 'operation-1'});
  assert.deepEqual(cancellationSchema.parse({kind: 'revoked', operationId: 'operation-1'}), {kind: 'revoked', operationId: 'operation-1'});
  invalid(() => cancellationSchema.parse({kind: 'revoked', signal: new AbortController().signal}));
  invalid(() => pluginFailureSchema.parse(new Error('private fixture path')));
  const secret = 'generated-secret-that-must-not-be-echoed';
  assert.throws(() => pluginFailureSchema.parse({code: secret}), error => !String(error).includes(secret) && error.code === 'invalid_contract');
  invalid(() => pluginFailureSchema.parse({code: 'internal', message: secret}));
  invalid(() => availabilitySchema.parse({state: 'active', reason: 'revoked'}));
  invalid(() => availabilitySchema.parse({state: 'unavailable'}));
  invalid(() => availabilitySchema.parse({state: 'verified'}));
  assert.deepEqual(availabilitySchema.parse({state: 'unavailable', reason: 'not_verified'}), {state: 'unavailable', reason: 'not_verified'});
});

test('DTO accessors and executable fields are rejected without evaluating them', () => {
  let evaluated = false;
  const input = {code: 'internal', get operationId() { evaluated = true; throw Error('must not execute'); }};
  invalid(() => pluginFailureSchema.parse(input));
  assert.equal(evaluated, false);
  invalid(() => pluginFailureSchema.parse({code: 'internal', [Symbol('hidden')]: 'secret'}));
  invalid(() => pluginSnapshotSchema.parse({...snapshot(), callback() {}}));
});

test('snapshot arrays cannot execute custom iterators or index accessors during validation', () => {
  let evaluated = false;
  const iterable = [contribution];
  iterable[Symbol.iterator] = function* () { evaluated = true; yield contribution; };
  invalid(() => pluginSnapshotSchema.parse(snapshot(iterable)));
  const accessor = [contribution];
  Object.defineProperty(accessor, '0', {get() { evaluated = true; return contribution; }});
  invalid(() => pluginSnapshotSchema.parse(snapshot(accessor)));
  assert.equal(evaluated, false);
});

test('local typed service token is an immutable exact API reference, not a wire implementation', () => {
  const token = serviceContract('fixture.original-reader', '1');
  assert.deepEqual(token, {id: 'fixture.original-reader', apiVersion: '1'});
  assert.equal(Object.isFrozen(token), true);
  invalid(() => serviceContract('reader', '>=1'));
});
