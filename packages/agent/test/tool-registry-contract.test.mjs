import test from 'node:test';
import assert from 'node:assert/strict';
import {assertObjectJsonSchema, parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {
  HOST_READ_OPERATIONS,
  TOOL_DESCRIPTOR_API_VERSION,
  TOOL_SNAPSHOT_SCHEMA_VERSION,
  defineToolDescriptor,
  toolFingerprint,
} from '../dist/tools/descriptor.js';
import {ToolRegistry, diffToolSnapshots} from '../dist/tools/registry.js';
import {toCodexTools, toRuntimeToolDefinitions, toolInputSchema} from '../dist/tools/runtime-schema.js';
import {CONTEXT_TOOLS} from '../dist/context-tools.js';
import {codexContextTools} from '../dist/codex-agent.js';

const port = (calls = {asserts: 0}) => ({
  calls,
  tool: {name: 'fixture_pin', version: 'v1', fingerprint: 'f'.repeat(64)},
  scope: {},
  signal: new AbortController().signal,
  assertCurrent() {calls.asserts++;},
  async read() {throw new Error('fixture port never reads');},
  actionCatalog() {throw new Error('fixture port never compares calendars');},
  progress() {},
});

const descriptor = (name, overrides = {}) => ({
  apiVersion: '1',
  name,
  version: 'v1',
  description: 'Generated fixture capability metadata. It has no archive authority.',
  fields: {},
  kind: 'metadata',
  exposure: 'native',
  requires: [],
  parse: args => args,
  execute: () => ({ok: true}),
  ...overrides,
});

const selection = (...entries) => entries.map(([name, version]) => ({name, version}));
const pin = entry => ({name: entry.name, version: entry.version, fingerprint: entry.fingerprint});
const expectCode = code => error => error.code === code;

test('descriptor fixes apiVersion/kind/exposure/requires and rejects reserved, duplicate or malformed registrations', () => {
  assert.equal(TOOL_DESCRIPTOR_API_VERSION, '1');
  assert.equal(typeof TOOL_DESCRIPTOR_API_VERSION, 'string');
  assert.equal(TOOL_SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(typeof TOOL_SNAPSHOT_SCHEMA_VERSION, 'number');
  assert.ok(HOST_READ_OPERATIONS.includes('search') && HOST_READ_OPERATIONS.includes('readImage'));
  for (const kind of ['originals', 'derived', 'metadata', 'image']) assert.equal(defineToolDescriptor(descriptor('fixture_' + kind, {kind})).kind, kind);
  for (const exposure of ['native', 'catalog']) assert.equal(defineToolDescriptor(descriptor('fixture_' + exposure, {exposure})).exposure, exposure);
  const tool = defineToolDescriptor(descriptor('fixture_read', {requires: ['search', 'evidence', 'actionCatalog', 'progress']}));
  assert.equal(tool.apiVersion, '1');
  assert.deepEqual(tool.requires, ['search', 'evidence', 'actionCatalog', 'progress']);
  assert.ok(Object.isFrozen(tool) && Object.isFrozen(tool.fields) && Object.isFrozen(tool.requires));

  const fields = {alpha: {type: 'string'}, beta: {type: 'integer'}};
  const base = toolFingerprint('Generated fixture.', fields, 'metadata', 'native', ['search', 'evidence']);
  assert.equal(base, toolFingerprint('Generated fixture.', {beta: {type: 'integer'}, alpha: {type: 'string'}}, 'metadata', 'native', ['evidence', 'search']));
  assert.notEqual(base, toolFingerprint('Generated fixture.', fields, 'metadata', 'catalog', ['search', 'evidence']));
  assert.notEqual(base, toolFingerprint('Generated fixture.', fields, 'derived', 'native', ['search', 'evidence']));
  assert.notEqual(base, toolFingerprint('Generated fixture.', fields, 'metadata', 'native', ['search', 'evidence', 'progress']));

  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), apiVersion: '2'}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), apiVersion: 1}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), version: ''}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), kind: 'read'}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), exposure: 'hidden'}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), requires: ['shell']}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), requires: ['search', 'search']}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), fields: {value: {type: 'string', execute: () => {}}}}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), parse: undefined}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), execute: undefined}), expectCode('invalid_tool_descriptor'));
  for (const name of ['skill', '_ready', 'capability_discover', 'capability_execute', 'delegation_child', '_private']) {
    assert.throws(() => defineToolDescriptor(descriptor(name)), expectCode('reserved_tool_name'));
  }

  const registry = new ToolRegistry();
  const remove = registry.register(descriptor('fixture_read'));
  assert.equal(typeof remove, 'function');
  assert.throws(() => registry.register(descriptor('fixture_read', {version: 'v2'})), expectCode('duplicate_tool'));
});

test('snapshot serializes as a pure DTO in explicit selection order, not registration order', () => {
  const tools = [
    descriptor('fixture_alpha', {version: 'v1', requires: ['search'], fields: {count: {type: 'integer', required: true}}}),
    descriptor('fixture_beta', {version: 'v2', kind: 'derived', exposure: 'catalog', requires: ['evidence']}),
    descriptor('fixture_gamma', {version: 'v3', kind: 'image', requires: ['readImage']}),
  ];
  const forward = new ToolRegistry(), reverse = new ToolRegistry();
  for (const tool of tools) forward.register(tool);
  for (const tool of [...tools].reverse()) reverse.register(tool);
  const explicit = selection(['fixture_gamma', 'v3'], ['fixture_alpha', 'v1']);
  assert.deepEqual(forward.registered().map(({name}) => name), ['fixture_alpha', 'fixture_beta', 'fixture_gamma']);

  const snapshot = forward.snapshot(explicit), mirrored = reverse.snapshot(explicit);
  assert.deepEqual(snapshot, mirrored);
  assert.equal(snapshot.fingerprint, mirrored.fingerprint);
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.entries.map(entry => entry.name), ['fixture_gamma', 'fixture_alpha']);
  assert.deepEqual(Object.keys(snapshot), ['schemaVersion', 'entries', 'fingerprint']);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.entries) && Object.isFrozen(snapshot.entries[0]));
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(wire, {schemaVersion: 1, entries: snapshot.entries, fingerprint: snapshot.fingerprint});
  assert.ok(!JSON.stringify(snapshot).includes('execute'));
  assert.ok(!JSON.stringify(snapshot).includes('assertActive'));
  assert.ok(!('parse' in snapshot.entries[0]));

  assert.throws(() => forward.snapshot(selection(['fixture_alpha', 'v2'])), expectCode('tool_version_mismatch'));
  assert.throws(() => forward.snapshot(selection(['missing', 'v1'])), expectCode('unknown_tool'));
  assert.throws(() => forward.snapshot(selection(['fixture_alpha', 'v1'], ['fixture_alpha', 'v1'])), expectCode('invalid_tool_selection'));
});

test('local assertActive/resolve bind the original registration and never revive an old pin', async () => {
  const registry = new ToolRegistry();
  const remove = registry.register(descriptor('fixture_live'));
  const before = registry.snapshot(selection(['fixture_live', 'v1']));
  const beforePin = pin(before.entries[0]);
  before.assertActive(beforePin);
  assert.equal(before.resolve(beforePin).identity.fingerprint, beforePin.fingerprint);

  remove();
  assert.throws(() => before.assertActive(beforePin), expectCode('stale_tool_pin'));
  assert.throws(() => before.resolve(beforePin), expectCode('stale_tool_pin'));
  registry.register(descriptor('fixture_live'));
  // Same name/version produces the same wire identity, but the old snapshot
  // captured the old registration identity and stays stale.
  const after = registry.snapshot(selection(['fixture_live', 'v1']));
  assert.deepEqual(after.entries[0], before.entries[0]);
  assert.throws(() => before.assertActive(beforePin), expectCode('stale_tool_pin'));
  after.assertActive(pin(after.entries[0]));
  assert.deepEqual(await after.resolve(pin(after.entries[0])).execute({}, port()), {ok: true});

  const diff = diffToolSnapshots(before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test('resolution validates pinned arguments and discards a late result after unload', async () => {
  const registry = new ToolRegistry();
  let parsed = 0, executed = 0;
  registry.register(descriptor('strict_read', {
    requires: ['search'],
    fields: {count: {type: 'integer', required: true}},
    parse: args => {parsed++; return {...args, parsed: true};},
    execute: args => {executed++; return {count: args.count, parsed: args.parsed};},
  }));
  const snapshot = registry.snapshot(selection(['strict_read', 'v1']));
  const tool = snapshot.resolve(pin(snapshot.entries[0]));
  const successful = port();
  assert.deepEqual(await tool.execute({count: 2}, successful), {count: 2, parsed: true});
  assert.equal(successful.calls.asserts, 2);
  assert.equal(parsed, 1);
  assert.equal(executed, 1);
  for (const args of [{count: '2'}, {count: 2, undeclared: true}, {}]) {
    await assert.rejects(tool.execute(args, port()), expectCode('invalid_tool_arguments'));
  }
  assert.equal(parsed, 1);

  let release;
  const gate = new Promise(resolve => {release = resolve;});
  registry.register(descriptor('late_read', {execute: async () => {await gate; return {late: 'value'};}}));
  const late = registry.snapshot(selection(['late_read', 'v1']));
  const latePin = pin(late.entries[0]);
  const calls = {asserts: 0};
  const pending = late.resolve(latePin).execute({}, port(calls));
  registry.unregister('late_read');
  release();
  await assert.rejects(pending, expectCode('stale_tool_pin'));
  assert.equal(calls.asserts, 1);
});

test('registration lifecycle signal/callback are checked before and after execute', async () => {
  const registry = new ToolRegistry();
  const controller = new AbortController();
  let checks = 0;
  registry.register(descriptor('lifecycle_read', {execute: async () => ({ok: true})}), {signal: controller.signal, assertCurrent: () => {checks++;}});
  const snapshot = registry.snapshot(selection(['lifecycle_read', 'v1']));
  const tool = snapshot.resolve(pin(snapshot.entries[0]));
  assert.deepEqual(await tool.execute({}, port()), {ok: true});
  // resolve() validates the pin once; execute checks before I/O and after the await.
  assert.equal(checks, 3);
  controller.abort();
  await assert.rejects(tool.execute({}, port()), error => error.name === 'AbortError');
  assert.throws(() => snapshot.assertActive(pin(snapshot.entries[0])), error => error.name === 'AbortError');
  assert.equal(checks, 3);
});

test('a tool can reach only the Host operations it declared', async () => {
  const livePort = (reads = []) => ({
    ...port(),
    async read(operation, args) {reads.push([operation, args]); return {operation};},
    actionCatalog() {return {items: []};},
    progress() {},
  });
  const run = (registry, name) => {
    const snapshot = registry.snapshot(selection([name, 'v1']));
    return snapshot.resolve(pin(snapshot.entries[0])).execute({}, livePort());
  };

  const declared = new ToolRegistry();
  declared.register(descriptor('declared_read', {
    requires: ['evidence'],
    execute: async (_args, host) => {await host.read('evidence', {ids: ['generated']}); return {ok: true};},
  }));
  assert.deepEqual(await run(declared, 'declared_read'), {ok: true});

  for (const [name, operation] of [
    ['undeclared_search', host => host.read('search', {})],
    ['undeclared_calendar', host => host.actionCatalog({})],
    ['undeclared_progress', host => host.progress('status')],
  ]) {
    const registry = new ToolRegistry();
    registry.register(descriptor(name, {requires: ['evidence'], execute: async (_args, host) => {operation(host); return {ok: true};}}));
    await assert.rejects(run(registry, name), expectCode('tool_permission_denied'));
  }
});

test('the real registry snapshot drives both production schema consumers identically', () => {
  const entry = (name, overrides) => {
    const [, description, fields] = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
    return descriptor(name, {version: '1', description, fields, ...overrides});
  };
  const registry = new ToolRegistry();
  registry.register(entry('timeline', {kind: 'derived', exposure: 'native', requires: ['timeline']}));
  registry.register(entry('progress_update', {kind: 'metadata', exposure: 'native', requires: ['progress']}));
  registry.register(entry('media_activity', {kind: 'derived', exposure: 'catalog', requires: ['mediaActivity']}));
  const snapshot = registry.snapshot(registry.registered());
  const definitions = toRuntimeToolDefinitions(snapshot), codexTools = toCodexTools(snapshot);
  assert.equal(definitions.length, 3);
  assert.equal(codexTools.length, 3);
  for (const entry of snapshot.entries) {
    const definition = definitions.find(tool => tool.name === entry.name);
    const codex = codexTools.find(tool => tool.name === entry.name);
    assert.deepEqual(codex.inputSchema, definition.inputSchema);
    assert.deepEqual(definition.inputSchema, {...parameterSchemaSpecToJsonSchema(entry.fields), additionalProperties: false});
    assert.deepEqual(definition.inputSchema, toolInputSchema(entry.fields));
    assertObjectJsonSchema(definition.inputSchema);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.inputSchema.required?.length ?? 0, Object.values(entry.fields).filter(field => field.required === true).length);
    assert.equal(definition.version, entry.version);
    assert.equal(definition.fingerprint, toolFingerprint(entry.description, entry.fields, entry.kind, entry.exposure, entry.requires));
    assert.equal(entry.fingerprint, definition.fingerprint);
    assert.deepEqual(Object.keys(codex).sort(), ['description', 'inputSchema', 'name', 'type']);
    assert.ok(!('version' in codex) && !('fingerprint' in codex));
  }
  for (const name of ['timeline', 'progress_update']) {
    assert.deepEqual(codexTools.find(tool => tool.name === name), codexContextTools.find(tool => tool.name === name));
  }

  const changed = new ToolRegistry();
  changed.register(entry('timeline', {kind: 'derived', exposure: 'catalog', requires: ['timeline']}));
  changed.register(entry('progress_update', {kind: 'metadata', exposure: 'native', requires: ['progress']}));
  const diff = diffToolSnapshots(snapshot, changed.snapshot(changed.registered()));
  assert.deepEqual(diff.removed.map(item => item.name), ['media_activity']);
  assert.deepEqual(diff.changed.map(item => item.name), ['timeline']);
});
