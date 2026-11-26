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
test('Android workflow keeps focused producer contracts and combines consumer units in one Gradle owner', () => {
  const auto = workflow('component-checks'), android = auto.jobs.android;
  assert.equal(auto.jobs.affected.outputs.android_contract, '${{ steps.affected.outputs.android_contract }}');
  assert.equal(android.if, "needs.affected.outputs.android == 'true' || needs.affected.outputs.android_contract == 'true'");
  const setup = android.steps.filter(step => step.uses?.startsWith('actions/setup-node') || /npm ci|npm rebuild|npm run build/.test(step.run ?? ''));
  assert.equal(setup.length, 4);
  assert.ok(setup.every(step => step.if === "needs.affected.outputs.android_contract == 'true'"));
  assert.ok(setup.some(step => step.run === 'npm ci --ignore-scripts'));
  assert.ok(setup.some(step => step.run === 'npm rebuild better-sqlite3'));
  assert.ok(setup.some(step => step.run?.includes('@mote/shared') && step.run.includes('@mote/agent')));
  assert.ok(setup.some(step => step.run === 'npm run build -w @mote/plugin-host && npm run build -w @mote/shared && npm run build -w @mote/agent'));
  const execution = android.steps.filter(step => /central-kotlin-contract|gradlew/.test(step.run ?? ''));
  const enabled = (condition, units, contract) => Function('return ' + condition.replaceAll('needs.affected.outputs.android_contract', JSON.stringify(String(contract))).replaceAll('needs.affected.outputs.android', JSON.stringify(String(units))))();
  for (const [units, contract, expected] of [
    [false, true, 'node --import tsx apps/android/test-fixtures/central-kotlin-contract.ts'],
    [true, true, 'node --import tsx apps/android/test-fixtures/central-kotlin-contract.ts --all-unit-tests'],
    [true, false, 'apps/android/gradlew -p apps/android --no-daemon :app:testDebugUnitTest'],
  ]) assert.deepEqual(execution.filter(step => enabled(step.if, units, contract)).map(step => step.run), [expected]);
  assert.deepEqual(execution.filter(step => enabled(step.if, false, false)), []);
  assert.ok(execution.every(step => !step['continue-on-error']));
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

test('the component and integration jobs install FFmpeg before their ASR process fixture', () => {
  const component = workflow('component-checks').jobs.regressions.steps;
  const integration = workflow('checks').jobs['protocol-and-app-tests'].steps;
  const ffmpeg = steps => steps.find(step => /apt-get install[^\n]*\bffmpeg\b/.test(step.run ?? ''));
  assert.equal(ffmpeg(component)?.if, "matrix.task == 'server-1'");
  for (const [steps, command] of [[component, '--task "$CHECK_TASK"'], [integration, '--task integration-units']]) {
    assert.ok(ffmpeg(steps));
    assert.ok(steps.indexOf(ffmpeg(steps)) < steps.findIndex(step => step.run?.includes(command)));
  }
});

test('tag-triggered release checks also avoid the broad server glob and manual performance/scale cases', () => {
  const release = workflow('release-central');
  assert.ok(release.on.push.tags.includes('central-v*'));
  const {version, native, verify, package: pack, publish} = release.jobs;
  assert.match(release.env.MOTE_CENTRAL_CHECKS, /startsWith\(github.ref, 'refs\/tags\/'\) \|\|/);
  assert.equal(version.outputs.checks, '${{ steps.checks.outputs.required }}');
  assert.match(version.steps.find(step => step.id === 'checks').run, /\$MOTE_CENTRAL_CHECKS/);
  const gate = "needs.version.outputs.checks == 'true'";
  assert.equal(native.if, gate);
  assert.equal(verify.if, gate);
  assert.deepEqual(verify.needs, ['version', 'native']);
  assert.equal(verify.strategy['fail-fast'], false);
  assert.deepEqual(verify.strategy.matrix.task, ['central-workspaces', 'central-server-1', 'central-server-2', 'central-server-3', 'central-server-4', 'central-server-timing', 'central-release-tools']);
  assert.deepEqual(pack.needs, ['version', 'verify']);
  assert.match(pack.if, /needs\.verify\.result == 'success' \|\| \(needs\.version\.outputs\.checks == 'false' && needs\.verify\.result == 'skipped'\)/);
  assert.deepEqual(publish.needs, ['version', 'package']);
  assert.ok(pack.steps.some(step => step.run?.includes('scripts/release/source-package.mjs')));
  const steps = verify.steps;
  const check = steps.find(step => step.run?.includes('node scripts/ci/run.mjs --task '));
  const verifyNative = steps.find(step => step.run?.includes('native:prepare -w @mote/agent -- --verify'));
  assert.equal(check['timeout-minutes'], 30);
  assert.equal(check.env.CHECK_TASK, '${{ matrix.task }}');
  assert.equal(verify.env.MOTE_TEST_PYTHON_OS_SANDBOX, '1');
  assert.ok(verifyNative && steps.indexOf(verifyNative) < steps.indexOf(check));
  const archive = native.steps.find(step => step.run?.includes('tar -C packages/agent/native/bin'));
  assert.ok(native.steps.findIndex(step => step.run?.includes('native:prepare -w @mote/agent -- --verify')) < native.steps.indexOf(archive));
  assert.equal(native.steps.find(step => step.uses?.startsWith('actions/upload-artifact')).with.name, steps.find(step => step.uses?.startsWith('actions/download-artifact')).with.name);
  const sandbox = steps.find(step => step.run?.includes('apt-get install') && step.run.includes('bubblewrap'));
  assert.match(sandbox.run, /apparmor_parser -r \/etc\/apparmor\.d\/bwrap-userns-restrict/);
  assert.match(sandbox.run, /bwrap --unshare-user --unshare-net --ro-bind/);
  assert.match(sandbox.run, /apt-get install[^\n]*\bffmpeg\b/);
  assert.ok(steps.indexOf(sandbox) < steps.indexOf(check));
  assert.ok(!steps.some(step => /check:central|npm test|--suite/.test(step.run ?? '')));
});
