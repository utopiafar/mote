import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_TASK_PROFILE,
  createMemoryTaskPack,
  installMemoryTaskPack,
  memoryConsolidationSkillDescriptor,
  memoryExtractionSkillDescriptor,
  memoryIntegrationSkillDescriptor,
  memorySkillDescriptors,
  memoryStrategySkillDescriptor,
  memoryTaskDescriptor,
} from '../dist/tasks/memory.js';
import {CODING_MEMORY_SKILL_VERSION,codingMemorySkillDescriptor,installCodingMemoryTaskPack} from '../dist/tasks/coding-memory.js';
import {TaskRegistry,prepareTaskContext} from '../dist/index.js';
import {buildContextEnvelope,taskTools} from '../dist/task-context.js';
import {compactMemoryReadCatalog,compactMemoryTaskContext,restoreMemoryCoverageKeys} from '../dist/tasks/memory-context.js';

const key = (value) => value.repeat(64).slice(0, 64);
const target = (index, overrides = {}) => ({
  key: key(String(index + 1)),
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  offset: index * 100,
  length: 100,
  fingerprint: 'f'.repeat(64),
  contextTime: '2026-10-01T00:00:00Z',
  state: 'pending',
  memoryIds: [],
  ...overrides,
});
const records = [0, 1].map(index => ({
  id: target(index).id,
  capturedAt: '2026-10-01T00:00:00Z',
  appName: 'Generated',
  ocrText: 'Generated original '.repeat(10),
}));
const members = [target(0), target(1, {attributionContext: {version: 1, ownerRelation: 'owner', basis: 'owner_source'}})];
const work = (values = members) => ({
  package: {goal: 'Assess the generated originals', instruction: 'Preserve attribution and exact ranges'},
  members: values,
  contextMembers: [],
  authorizedMembers: values.map(member => ({...member, scope: 'generated'})),
  history: [],
  workContract: 'range-evaluation@1',
  instruction: 'Generated complete work contract',
});
const input = (skill, overrides = {}) => ({
  question: 'Assess the same generated grant',
  responseMode: 'memory-extraction',
  skill,
  evidenceIds: records.map(record => record.id),
  evidenceRanges: members.map(({id, offset, length}) => ({id, offset, length})),
  evidenceReadRanges: [{id: records[0].id, offset: 0, length: 100}],
  taskContext: {turns: [], memoryWork: work()},
  ...overrides,
});

test('the Memory pack registers the extraction profile and all four Memory procedures with exact versions', async () => {
  const registry = new TaskRegistry(), dispose = installMemoryTaskPack(registry);
  try {
    assert.equal(memoryTaskDescriptor.id, 'extraction');
    assert.equal(memoryTaskDescriptor.version, '1');
    assert.deepEqual(memoryTaskDescriptor.profile, MEMORY_TASK_PROFILE);
    assert.deepEqual(memoryTaskDescriptor, createMemoryTaskPack().tasks[0]);
    assert.deepEqual(memorySkillDescriptors.map(skill => skill.id), ['memory-strategy', 'memory-integration', 'memory-extraction', 'memory-consolidation']);
    assert.deepEqual(memorySkillDescriptors.map(skill => skill.version), ['1.0.0', '1.0.0', '3.4.0', '3.4.0']);
    assert.equal(memoryExtractionSkillDescriptor.responseMode, 'memory-extraction');
    assert.equal(memoryStrategySkillDescriptor.responseMode, 'memory-extraction');
    assert.equal(memoryIntegrationSkillDescriptor.responseMode, 'memory-extraction');
    assert.equal(memoryConsolidationSkillDescriptor.responseMode, undefined);
    for (const descriptor of memorySkillDescriptors) {
      assert.equal(registry.skill(descriptor.id).content, descriptor.content);
      assert.match(descriptor.content, new RegExp(`^---\\nname: ${descriptor.id}\\n`));
    }
    assert.equal(registry.skill('memory-extraction').content, memoryExtractionSkillDescriptor.content);
  } finally {
    await dispose();
  }
  assert.throws(() => registry.skill('memory-extraction'), error => error?.code === 'unknown_skill');
});

test('every Memory phase keeps its complete procedure under the same host grant without enlarging targets', () => {
  const cases = [
    ['memory-extraction', memoryExtractionSkillDescriptor, '3.4.0'],
    ['memory-consolidation', memoryConsolidationSkillDescriptor, '3.4.0'],
    ['memory-strategy', memoryStrategySkillDescriptor, '1.0.0'],
    ['memory-integration', memoryIntegrationSkillDescriptor, '1.0.0'],
    ['coding-memory', codingMemorySkillDescriptor, CODING_MEMORY_SKILL_VERSION],
  ];
  for (const [skillId, descriptor, version] of cases) {
    const query = input(skillId), before = structuredClone(query);
    const prepared = prepareTaskContext(query), envelope = buildContextEnvelope(query, records);
    assert.equal(prepared.id, 'extraction');
    assert.equal(prepared.version, '1');
    assert.deepEqual(prepared.profile, {output: 'memory-extraction', retrieval: 'evidence'});
    assert.equal(prepared.responseMode, 'memory-extraction');
    assert.equal(prepared.skill?.id, skillId);
    assert.equal(prepared.skill?.version, version);
    assert.equal(prepared.skill?.content, descriptor.content);
    assert.equal(envelope.taskId, 'extraction');
    assert.deepEqual(envelope.taskProfile, {output: 'memory-extraction', retrieval: 'evidence'});
    assert.equal(envelope.requiredSkill, skillId);
    assert.equal(envelope.procedure, descriptor.content);
    assert.equal(envelope.untrustedEvidence.length, records.length, 'assembly cannot add evidence targets');
    assert.equal(envelope.untrustedTaskContext.memoryWork.members.length, members.length);
    assert.deepEqual(envelope.untrustedTaskContext.memoryWork.members.map(member => member.key), ['member_0', 'member_1']);
    assert.equal(envelope.authorizedContextRanges.ranges.length, 1, 'the context catalog cannot add extraction targets');
    assert.deepEqual(envelope.authorizedContextRanges.ranges, [{memberRef: 'member_0'}], 'an identical authorized range reuses its exact member identity');
    assert.deepEqual(taskTools(query), ['evidence', 'context_evidence']);
    assert.ok(!taskTools(query).some(name => ['search_context', 'timeline', 'material_catalog', 'material_read'].includes(name)));
    assert.deepEqual(query, before, 'wire compaction never mutates the Central Memory input');
  }
});

test('missing author context, unknown coverage keys and empty targets remain exact or invalid without widening the grant', () => {
  const withoutAuthorContext = members.map(({attributionContext: _context, ...member}) => member), task = {turns: [], memoryWork: work(withoutAuthorContext)};
  const wire = compactMemoryTaskContext(task);
  assert.equal(wire.memoryWork.members.length, 2);
  assert.equal(wire.memoryWork.members[0].attributionContextRef, undefined);
  assert.equal(wire.memoryWork.attributionContexts && Object.keys(wire.memoryWork.attributionContexts).length, 0);
  assert.deepEqual(wire.memoryWork.members.map(member => member.key), ['member_0', 'member_1']);
  assert.equal(wire.memoryWork.contextEncoding, 'memory-context@3');

  const coverage = JSON.stringify({coverage: [{key: 'member_999'}, {key: key('a')}, {key: 'member_00'}]});
  assert.equal(restoreMemoryCoverageKeys(coverage, task), coverage, 'unknown or malformed aliases are never guessed into a host target');

  const empty = work([]), emptyTask = {turns: [], memoryWork: empty}, emptyInput = input('memory-extraction', {evidenceIds: [], evidenceRanges: [], evidenceReadRanges: [], taskContext: emptyTask});
  const prepared = prepareTaskContext(emptyInput), envelope = buildContextEnvelope(emptyInput, []);
  assert.equal(prepared.id, 'extraction');
  assert.equal(envelope.untrustedTaskContext.memoryWork.members.length, 0);
  assert.equal(envelope.untrustedEvidence, undefined);
  assert.equal(envelope.authorizedContextRanges, undefined);
  assert.deepEqual(compactMemoryTaskContext(emptyTask).memoryWork.members, []);
  assert.deepEqual(compactMemoryReadCatalog([], compactMemoryTaskContext(emptyTask)), []);
});

test('the Coding procedure keeps its own exact content while sharing the Memory extraction profile', async () => {
  const registry = new TaskRegistry(), dispose = installCodingMemoryTaskPack(registry);
  try {
    assert.equal(registry.skill('coding-memory').id, 'coding-memory');
    assert.equal(registry.skill('coding-memory').version, '6.2.0');
    assert.equal(registry.skill('coding-memory').content, codingMemorySkillDescriptor.content);
    assert.match(registry.skill('coding-memory').content, /^---\nname: coding-memory\n/);
  } finally {
    dispose();
  }
  assert.equal(codingMemorySkillDescriptor.responseMode, 'memory-extraction');
  const prepared = prepareTaskContext(input('coding-memory'));
  assert.equal(prepared.id, 'extraction');
  assert.equal(prepared.skill?.version, '6.2.0');
});
