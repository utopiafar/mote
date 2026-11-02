import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertObjectJsonSchema, parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {
  TOOL_DESCRIPTOR_API_VERSION,
  TOOL_SNAPSHOT_SCHEMA_VERSION,
  defineToolDescriptor,
  toolKindRequirements,
} from '../dist/tools/descriptor.js';
import {ToolRegistry} from '../dist/tools/registry.js';
import {runtimeToolFrames, toCodexTool, toDshTool, toRuntimeToolDefinition} from '../dist/tools/runtime-schema.js';
import {CONTEXT_TOOLS} from '../dist/context-tools.js';
import {codexContextTools} from '../dist/codex-agent.js';

const host = (calls = {asserts: 0}) => ({
  calls,
  tool: {name: 'fixture_pin', version: 'v1', fingerprint: 'f'.repeat(64)},
  signal: new AbortController().signal,
  assertCurrent() {calls.asserts++;},
  async read() {throw new Error('fixture host never reads');},
  actionCatalog() {throw new Error('fixture host never compares calendar');},
  progress() {},
});

const descriptor = (name, overrides = {}) => {
  const kind = overrides.kind ?? 'read';
  return {
    apiVersion: '1',
    name,
    version: 'v1',
    description: 'Generated fixture capability metadata. It has no archive authority.',
    kind,
    requires: toolKindRequirements(kind),
    fields: {},
    execute: () => ({ok: true}),
    ...overrides,
  };
};

const expectCode = code => error => error.code === code;

test('descriptor fixes the exact apiVersion/kind requirement and rejects reserved, duplicate or malformed registrations', () => {
  assert.equal(TOOL_DESCRIPTOR_API_VERSION, '1');
  assert.equal(typeof TOOL_DESCRIPTOR_API_VERSION, 'string');
  assert.equal(TOOL_SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(typeof TOOL_SNAPSHOT_SCHEMA_VERSION, 'number');
  assert.deepEqual(toolKindRequirements('read'), ['read']);
  assert.deepEqual(toolKindRequirements('action_compare'), ['actionCatalog']);
  assert.deepEqual(toolKindRequirements('progress'), ['progress']);
  const tool = defineToolDescriptor(descriptor('fixture_read'));
  assert.equal(tool.apiVersion, '1');
  assert.ok(Object.isFrozen(tool));
  assert.ok(Object.isFrozen(tool.fields));

  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), apiVersion: '2'}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), apiVersion: 1}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), version: ''}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), kind: 'write'}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), requires: ['progress']}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), fields: {value: {type: 'string', execute: () => {}}}}), expectCode('invalid_tool_descriptor'));
  assert.throws(() => defineToolDescriptor({...descriptor('fixture_read'), execute: undefined}), expectCode('invalid_tool_descriptor'));
  for (const name of ['skill', '_ready', 'capability_discover', 'capability_execute', 'delegation_child', '_private']) {
    assert.throws(() => defineToolDescriptor(descriptor(name)), expectCode('reserved_tool_name'));
  }

  const registry = new ToolRegistry();
  const remove = registry.register(descriptor('fixture_read'));
  assert.equal(typeof remove, 'function');
  assert.throws(() => registry.register(descriptor('fixture_read', {version: 'v2'})), expectCode('duplicate_tool'));
  assert.throws(() => registry.register({...descriptor('fixture_read'), kind: 'read', requires: ['progress']}), expectCode('invalid_tool_descriptor'));
});

test('snapshot is a pure frozen DTO whose explicit selection and fingerprint ignore registration order', () => {
  const order = [
    descriptor('fixture_alpha', {version: 'v1', fields: {count: {type: 'integer', required: true}}}),
    descriptor('fixture_beta', {version: 'v2', kind: 'action_compare'}),
    descriptor('fixture_gamma', {version: 'v3', kind: 'progress'}),
  ];
  const forward = new ToolRegistry(), reverse = new ToolRegistry();
  for (const tool of order) forward.register(tool);
  for (const tool of [...order].reverse()) reverse.register(tool);
  const first = forward.snapshot(), second = reverse.snapshot();
  assert.deepEqual(first, second);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.schemaVersion, 1);
  assert.deepEqual(first.tools.map(tool => tool.name), ['fixture_alpha', 'fixture_beta', 'fixture_gamma']);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.tools) && Object.isFrozen(first.tools[0]));
  assert.ok(Object.isFrozen(first.tools[0].fields));
  assert.ok(!JSON.stringify(first).includes('execute'));
  assert.ok(!('token' in first.tools[0]));
  for (const tool of first.tools) assert.deepEqual(tool.requires, toolKindRequirements(tool.kind));

  assert.deepEqual(forward.snapshot(['fixture_gamma', 'fixture_alpha']).tools.map(tool => tool.name), ['fixture_alpha', 'fixture_gamma']);
  assert.throws(() => forward.snapshot(['fixture_alpha', 'missing']), expectCode('unknown_tool'));
  assert.throws(() => forward.snapshot(['fixture_alpha', 'fixture_alpha']), expectCode('invalid_tool_selection'));
});

test('exact name/version selection and discovery never depend on installation order', () => {
  const order = [descriptor('fixture_two', {version: 'v2'}), descriptor('fixture_one', {version: 'v1'})];
  const forward = new ToolRegistry(), reverse = new ToolRegistry();
  for (const tool of order) forward.register(tool);
  for (const tool of [...order].reverse()) reverse.register(tool);
  const selected = forward.select(forward.pins(), 'fixture_two', 'v2');
  const mirrored = reverse.select(reverse.pins(), 'fixture_two', 'v2');
  assert.equal(selected.version, 'v2');
  assert.equal(selected.fingerprint, mirrored.fingerprint);
  assert.throws(() => forward.select(forward.pins(), 'fixture_two', 'v1'), expectCode('tool_version_mismatch'));
  assert.throws(() => forward.select(forward.pins(), 'never_registered', 'v1'), expectCode('unknown_tool'));

  const brief = forward.discover();
  assert.deepEqual(brief.capabilities.map(item => item.name), ['fixture_one', 'fixture_two']);
  assert.ok(!('fields' in brief.capabilities[0]));
  const exact = forward.discover('fixture_two');
  assert.equal(exact.version, 'v2');
  assert.equal(exact.schemaVersion, 1);
  assert.deepEqual(exact.fields, {});
  assert.throws(() => forward.discover('never_registered'), expectCode('unknown_tool'));
});

test('execution validates the pinned schema and re-checks the original entry before and after the await', async () => {
  const registry = new ToolRegistry();
  let executed = 0;
  registry.register(descriptor('strict_read', {
    fields: {count: {type: 'integer', required: true}},
    execute: args => {executed++; return {count: args.count};},
  }));
  const pin = registry.pins()[0];
  const successful = host();
  assert.deepEqual(await registry.execute(pin, {count: 2}, successful), {count: 2});
  assert.equal(successful.calls.asserts, 2);
  assert.equal(executed, 1);
  assert.deepEqual(await registry.executeCapability(pin, JSON.stringify({count: 3}), host()), {count: 3});

  for (const args of [{count: '2'}, {count: 2, undeclared: true}, {}]) {
    await assert.rejects(registry.execute(pin, args, host()), expectCode('invalid_tool_arguments'));
  }
  for (const json of ['[]', 'not-json', JSON.stringify({count: '2'})]) {
    await assert.rejects(registry.executeCapability(pin, json, host()), expectCode('invalid_tool_arguments'));
  }
  assert.equal(executed, 2);
});

test('a late result cannot escape after unload and a same-version re-registration does not revive the old pin', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const registry = new ToolRegistry();
  registry.register(descriptor('late_read', {execute: async () => {await gate; return {late: 'value'};}}));
  const stale = registry.pins()[0];
  const calls = {asserts: 0};
  const pending = registry.execute(stale, {}, host(calls));
  assert.equal(registry.unregister('late_read'), true);
  release();
  await assert.rejects(pending, expectCode('stale_tool_pin'));
  assert.equal(calls.asserts, 1);

  const replaceable = new ToolRegistry();
  const remove = replaceable.register(descriptor('replaceable', {version: 'v1'}));
  const before = replaceable.pins()[0], beforeSnapshot = replaceable.snapshot();
  assert.equal(replaceable.isCurrent(before), true);
  remove();
  assert.equal(replaceable.isCurrent(before), false);
  replaceable.register(descriptor('replaceable', {version: 'v1'}));
  const after = replaceable.pins()[0];
  assert.notEqual(after.token, before.token);
  assert.equal(replaceable.isCurrent(before), false);
  assert.equal(replaceable.isCurrent(after), true);
  // The wire snapshot carries no liveness token, so identical content serializes
  // identically; only the local pin proves the old registration is gone.
  assert.deepEqual(replaceable.snapshot(), beforeSnapshot);
  await assert.rejects(replaceable.execute(before, {}, host()), expectCode('stale_tool_pin'));
  assert.deepEqual(await replaceable.execute(after, {}, host()), {ok: true});
});

test('the real registry snapshot feeds both production runtime schema consumers identically', () => {
  const entryFor = (name, kind = 'read') => {
    const [, description, fields] = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
    const registry = new ToolRegistry();
    registry.register(descriptor(name, {version: '1', kind, description, fields}));
    return registry.snapshot().tools[0];
  };
  const entries = [entryFor('timeline'), entryFor('progress_update', 'progress'), entryFor('media_activity')];
  const frames = runtimeToolFrames(entries);
  assert.equal(frames.dsh.length, entries.length);
  assert.equal(frames.codex.length, entries.length);
  for (const entry of entries) {
    const dsh = toDshTool(entry), codex = toCodexTool(entry);
    assert.deepEqual(dsh.parameters, codex.inputSchema);
    assert.deepEqual(dsh.parameters, toolInputSchemaMatching(entry.fields));
    assertObjectJsonSchema(dsh.parameters);
    assert.deepEqual(Object.keys(dsh).sort(), ['description', 'name', 'parameters']);
    assert.deepEqual(Object.keys(codex).sort(), ['description', 'inputSchema', 'name', 'type']);
    assert.equal(dsh.parameters.required?.length ?? 0, Object.values(entry.fields).filter(field => field.required === true).length);
    assert.equal(dsh.parameters.additionalProperties, false);
    const definition = toRuntimeToolDefinition(entry);
    assert.deepEqual(definition, {
      name: entry.name,
      version: entry.version,
      fingerprint: createHash('sha256').update(JSON.stringify([entry.description, entry.fields])).digest('hex'),
      description: entry.description,
      inputSchema: dsh.parameters,
    });
  }
  // The production Codex tool list must accept exactly the adapter's frame.
  for (const name of ['timeline', 'progress_update']) {
    const entry = entries.find(candidate => candidate.name === name);
    assert.deepEqual(toCodexTool(entry), codexContextTools.find(tool => tool.name === name));
  }
});

function toolInputSchemaMatching(fields) {
  return {...parameterSchemaSpecToJsonSchema(fields), additionalProperties: false};
}
