import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { validateManual, specialistScopes } from './manual-selection.mjs';
const workflow = name => {
  const doc = parseDocument(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
  assert.deepEqual(doc.errors, []); return doc.toJS();
};
test('ordinary push/PR has only affected light entrypoints and a strict always-running required gate', () => {
  const auto = workflow('component-checks');
  assert.deepEqual(Object.keys(auto.on), ['pull_request', 'push']);
  assert.deepEqual(auto.on.push.branches, ['main']);
  assert.ok(auto.concurrency.group.includes('github.run_id'), 'main pending ranges cannot replace each other');
  assert.equal(auto.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  assert.ok(auto.jobs.affected.steps.some(step => step.run === 'node scripts/ci/main-base.mjs' && step.if === "github.event_name == 'push'"));
  const selector = auto.jobs.affected.steps.find(step => step.id === 'affected');
  assert.ok(selector.env.CHECK_BASE.includes('steps.baseline.outputs.base'));
  assert.ok(!selector.env.CHECK_BASE.includes('github.event.before'));
  assert.equal(auto.jobs.regressions.strategy['fail-fast'], false);
  assert.equal(auto.jobs['required-checks'].if, 'always()');
  assert.deepEqual(auto.jobs['required-checks'].needs, ['affected', 'regressions', 'android']);
  assert.equal(auto.jobs['required-checks'].steps.at(-1).run, 'node scripts/ci/gate.mjs');
  for (const job of Object.values(auto.jobs)) for (const step of job.steps ?? []) {
    assert.ok(!/benchmark|--suite|npm test|check:central|test:e2e|test:media-e2e/.test(step.run ?? ''));
  }
});
test('heavy workflow has only workflow_dispatch, immutable revision selection, and retains full integration commands', () => {
  const manual = workflow('checks');
  assert.deepEqual(Object.keys(manual.on), ['workflow_dispatch']);
  assert.deepEqual(manual.on.workflow_dispatch.inputs.suite.options, ['integration', 'docker', 'scale', 'recovery', 'benchmark', 'all']);
  assert.equal(manual.jobs.selection.steps.at(-1).run, 'node "$RUNNER_TEMP/mote-ci/ci/manual-selection.mjs"');
  for (const name of ['protocol-and-app-tests', 'docker-integration', 'specialist']) {
    const job = manual.jobs[name];
    assert.equal(job.needs, 'selection');
    assert.equal(job.steps.filter(step => step.uses?.startsWith('actions/checkout')).at(-1).with.ref, '${{ needs.selection.outputs.revision }}');
    assert.ok(job.steps.some(step => step.run?.includes('cp -R scripts/ci scripts/release')));
  }
  const integration = manual.jobs['protocol-and-app-tests'].steps.map(step => step.run).filter(Boolean);
  for (const command of ['node "$RUNNER_TEMP/mote-ci/ci/run.mjs" --task integration-units', 'npm run test:e2e', 'npm run test:media-e2e', 'npm run test:profiles', 'npm run test:tunnel']) assert.ok(integration.includes(command), command);
  assert.ok(manual.jobs.specialist.steps.at(-1).run.includes('--scope "$CHECK_SCOPE"'));
});
test('manual requests reject unknown modes, invalid scope and a mutable/mismatched revision before jobs run', () => {
  const actual = 'a'.repeat(40);
  for (const suite of ['integration', 'docker', 'all', ...Object.keys(specialistScopes)]) assert.equal(validateManual({ suite, actual }), actual);
  for (const [suite, names] of Object.entries(specialistScopes)) for (const scope of names) assert.equal(validateManual({ suite, scope, revision: actual, actual }), actual);
  for (const options of [{ suite: 'typo' }, { suite: 'scale', scope: 'typo' }, { suite: 'all', scope: 'memory' }, { suite: 'integration', revision: 'main' }, { suite: 'scale', revision: 'b'.repeat(40) }]) assert.throws(() => validateManual({ actual, ...options }));
});

test('tag-triggered release checks also avoid the broad server glob and manual performance/scale cases', () => {
  const release = workflow('release-central');
  assert.ok(release.on.push.tags.includes('central-v*'));
  const checks = release.jobs.package.steps.filter(step => step.run?.includes('--task central-units'));
  assert.equal(checks.length, 1);
  assert.ok(!release.jobs.package.steps.some(step => /check:central|npm test|--suite/.test(step.run ?? '')));
});
