#!/usr/bin/env node
/** G4 manual deep-extension matrix for Agent runtime/package boundaries.
 *
 * This runner deliberately composes the existing generated-fixture cases
 * instead of reimplementing their protocol servers. Every case starts from
 * generated data only, uses a temporary profile/workspace, and never selects a
 * real model. It verifies the actual named cases ran and passed (a skipped case
 * cannot satisfy the matrix), then checks that the matrix covers:
 *
 *   new package -> hook -> factory replacement -> run -> revoke -> restart
 *
 * with DSH and Codex query/import/Host-delegation closed loops and generated
 * archive preservation after a failed/cancelled/revoked extension.
 *
 * Manual selection only; this script is not part of the ordinary test glob.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** The matrix is intentionally explicit: each generated-fixture file owns one
 * converged seam, and the expected names below are the cases that establish it. */
const cases = [
  {
    id: 'dsh-native-extension',
    cwd: 'packages/agent',
    file: 'test/dsh-native-extension.test.mjs',
    covers: ['new-package', 'hook', 'factory-replacement', 'run', 'restart', 'dsh-query'],
    tests: [
      'native assembly validates public manifest, entries and factory ownership',
      'real DSH loader runs the native package, changes request config, and restarts factory A to B',
    ],
  },
  {
    id: 'dsh-native-lifecycle',
    cwd: 'packages/agent',
    file: 'test/dsh-native-lifecycle.test.mjs',
    covers: ['new-package', 'hook', 'revoke', 'failure-recovery'],
    tests: [
      'duplicate factory and circular inject reject only the candidate generation',
      'acyclic native packages register provider-first regardless of declaration order',
      'host control through the real DSH loader unregisters the native tool and hook',
    ],
  },
  {
    id: 'dsh-native-replacement',
    cwd: 'packages/agent',
    file: 'test/dsh-native-replacement.test.mjs',
    covers: ['factory-replacement', 'run', 'restart', 'failure-recovery', 'dsh-query'],
    tests: [
      'hot replacement keeps the old generation for in-flight runs and rolls back a failed candidate',
      'restart-required factory replacement becomes effective only in a fresh DSH process',
    ],
  },
  {
    id: 'agent-runtime-delegation',
    cwd: 'packages/agent',
    file: 'test/agent-runtime-delegation.test.mjs',
    covers: ['host-delegation', 'revoke'],
    tests: [
      'DSH and Codex descriptors disable native delegation and keep only the Host channel',
      'DSH runtime policy disables every native subagent and child-workflow producer',
      'Codex App Server policy keeps native subagent and team features off',
      'a runtime-native subagent request cannot enter the DSH Host tool surface',
      'the same DSH surface still exposes the Host delegation channel',
    ],
  },
  {
    id: 'codex-runtime-contract',
    cwd: 'packages/agent',
    file: 'test/codex-runtime-contract.test.mjs',
    covers: ['codex-query', 'run'],
    tests: [
      'the App Server fixture consumes the dynamic Host schema and returns structured tool errors before corrected arguments',
      'the same Host output rules reject an unretrieved Codex citation and repair it inside one thread',
      'an unretrieved Codex citation remains rejected after the bounded Host repairs',
    ],
  },
  {
    id: 'dsh-provider-host',
    cwd: 'packages/agent',
    file: 'test/dsh-provider.test.mjs',
    namePattern: 'official DSH plugin publishes through the real Host|selected A05 journey: cancellation releases|Host delegation yield|mandatory Host tool stops',
    covers: ['dsh-query', 'run', 'revoke', 'host-delegation'],
    tests: [
      'official DSH plugin publishes through the real Host without an observer and quiesces admissions',
      'mandatory Host tool stops reject the actual channel failure path',
      'a Host delegation yield crosses the real parent channel as a typed stopping cause',
      'selected A05 journey: cancellation releases the Host barrier and closes the real DSH child before a late model response',
    ],
  },
  {
    id: 'import-capability-lifecycle',
    cwd: 'packages/agent',
    file: 'test/import-lifecycle.test.mjs',
    covers: ['dsh-import', 'codex-import', 'revoke', 'failure-recovery'],
    tests: [
      'import cleanup preserves typed primary errors and sanitizes cleanup-only failures',
      'import close drains preparation that has not created its Harness yet',
      'import repairs final formatting with a bounded budget in the same session and isolates observer failures',
      'import formatting correction shares the initial admitted budget without resetting it',
      'optional import launch hook receives the isolated root and only forwards its executable to the SDK',
      'import transports share one bounded preview contract',
      'import capability registry selects an implementation only from explicit protocol configuration and retires it',
      'import usage includes the formatting repair and stays outside model input',
    ],
  },
  {
    id: 'codex-query-http',
    cwd: 'apps/server',
    nodeArgs: ['--import', 'tsx'],
    file: 'test/codex-query.test.ts',
    covers: ['codex-query', 'run', 'revoke', 'restart', 'archive-integrity'],
    tests: [
      'authenticated HTTP selects Codex, reads generated evidence, and saves the cited answer',
      'authenticated Codex cancellation commits no half answer and releases the child and private runtime',
      'an App Server crash commits no half answer and a later authenticated Codex query recovers',
    ],
  },
  {
    id: 'agent-import-host',
    cwd: 'apps/server',
    nodeArgs: ['--import', 'tsx'],
    file: 'test/agent-import-host.test.ts',
    covers: ['dsh-import', 'codex-import', 'revoke', 'failure-recovery', 'archive-integrity'],
    tests: [
      'DSH fixture preview is consumed by ImportRuntime and manifest while archive stays unpublished',
      'Codex App Server fixture preview is consumed by the same ImportRuntime and manifest as DSH',
      'a cancelled import cannot publish a late manifest from the DSH fixture',
      'revoked model authority stops further sends and rejects the returned manifest',
    ],
  },
  {
    id: 'delegated-query-app',
    cwd: 'apps/server',
    nodeArgs: ['--import', 'tsx'],
    file: 'test/delegated-query-app.test.ts',
    covers: ['host-delegation', 'run', 'restart', 'archive-integrity'],
    tests: [
      'full app delegation yields its only slot and saves an answer citing the original receipt',
      'full app delegation resumes after restart without repeating a successful child',
      'a retryable provider attempt never writes a failed conversation before the successful answer',
      'durable query metadata omits model-authored progress prose while retaining execution fields',
      'real Coding HTTP intake and durable query can deliver citable material originals and finish without a worker',
    ],
  },
  {
    id: 'agent-runtime-generation',
    cwd: 'apps/server',
    nodeArgs: ['--import', 'tsx'],
    file: 'test/agent-runtime-generation.test.ts',
    covers: ['revoke', 'restart', 'failure-recovery', 'archive-integrity'],
    tests: [
      'an interrupted run resumes its exact profile after restart',
      'restart blocks an interrupted run when its pinned profile changed instead of mixing the new generation',
      'revoking the run data after restart starts no new model attempt or final write',
    ],
  },
];

const requirements = Object.freeze({
  'new-package': 'a new generated native package loads through the real DSH loader',
  hook: 'a native hook participates in the live loop and unregisters',
  'factory-replacement': 'factory A is replaced by factory B only through restart',
  run: 'a real fixture query consumes generated evidence through the Host',
  revoke: 'unload/cancel/revocation fences later work',
  restart: 'a fresh process/profile restores only the current generation',
  'dsh-query': 'DSH query closed loop',
  'codex-query': 'Codex App Server query closed loop',
  'dsh-import': 'DSH import preview reaches ImportRuntime without publishing',
  'codex-import': 'Codex import preview reaches ImportRuntime without publishing',
  'host-delegation': 'Host delegation child loop and restart recovery',
  'failure-recovery': 'a failed candidate leaves the active extension usable',
  'archive-integrity': 'generated archive/originals and conversation state stay intact',
});

const help = `Mote Agent deep-extension matrix (manual G4 selection, fixture only)
  node scripts/agent-extension-matrix.mjs [--list] [--only <case|phase>]... [--json] [--timeout MS]

The default run executes every generated-fixture case. Each case must report its
named cases as passed; skipped or renamed coverage fails the matrix. No live
model, physical device or personal profile is used.`;

function nodeEnvironment(home) {
  // Keep the fixture children free of inherited Mote profiles and credentials.
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8',
    TERM: 'dumb',
  };
}

function tapCases(stdout) {
  const found = new Map();
  for (const line of stdout.split('\n')) {
    const match = /^(ok|not ok) \d+ - (.*)$/.exec(line);
    if (!match) continue;
    const directive = /\s+#\s+(SKIP|TODO)\b/i.exec(match[2]);
    const name = match[2].replace(/\s+#\s+(?:SKIP|TODO)\b.*$/i, '').trim();
    found.set(name, {ok: match[1] === 'ok', skipped: Boolean(directive)});
  }
  return found;
}

function tail(value, limit = 160) {
  const lines = value.trim().split('\n');
  return lines.slice(Math.max(0, lines.length - limit)).join('\n');
}

function runCase(testCase, timeoutMs, home) {
  return new Promise((resolveCase, rejectCase) => {
    const args = [
      ...(testCase.nodeArgs ?? []),
      '--test',
      '--test-reporter=tap',
      '--test-concurrency=1',
      `--test-timeout=${timeoutMs}`,
      ...(testCase.namePattern ? [`--test-name-pattern=${testCase.namePattern}`] : []),
      testCase.file,
    ];
    const child = spawn(process.execPath, args, {
      cwd: join(repository, testCase.cwd),
      env: nodeEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectCase);
    child.once('close', (code, signal) => {
      const observed = tapCases(stdout);
      const problems = [];
      if (code !== 0) problems.push(`test process exited ${signal ? `on ${signal}` : `with status ${code}`}`);
      for (const name of testCase.tests) {
        const result = observed.get(name);
        if (!result) problems.push(`missing case: ${name}`);
        else if (result.skipped) problems.push(`skipped case: ${name}`);
        else if (!result.ok) problems.push(`failed case: ${name}`);
      }
      resolveCase({testCase, code, signal, problems, stdout, stderr, observed});
    });
  });
}

function selected(only) {
  if (!only?.length) return cases;
  const wanted = new Set(only);
  const selectedCases = cases.filter(testCase => wanted.has(testCase.id) || testCase.covers.some(phase => wanted.has(phase)));
  if (!selectedCases.length) throw Error(`No matrix case or phase matched: ${[...wanted].join(', ')}`);
  return selectedCases;
}

function printList() {
  for (const testCase of cases) {
    console.info(`${testCase.id} (${testCase.cwd}/${testCase.file})`);
    console.info(`  covers: ${testCase.covers.join(', ')}`);
    for (const name of testCase.tests) console.info(`  - ${name}`);
  }
}

/** Use the real assembly/lifecycle contracts to prove the fixture package and
 * factory replacement shape before the slower runtime cases start. */
async function verifyFixtureShape() {
  const fixtureRoot = join(repository, 'packages/agent/test/fixtures/dsh-native-probe');
  const manifest = JSON.parse(await readFile(join(fixtureRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@mote/dsh-native-probe');
  assert.equal(manifest.type, 'module');
  for (const subpath of ['.', './factory-a', './factory-b', './control']) assert.ok(manifest.exports?.[subpath], `fixture export ${subpath}`);
  assert.deepEqual([...(manifest.dsh?.native?.capabilities ?? [])].sort(), ['agents', 'factory', 'hooks', 'tools']);
  for (const entry of ['index.mjs', 'factory-a.mjs', 'factory-b.mjs', 'control.mjs', 'replacement.mjs', 'lifecycle.mjs', 'lifecycle-control.mjs']) {
    assert.equal(existsSync(join(fixtureRoot, entry)), true, `fixture entry ${entry}`);
  }
  const load = path => import(pathToFileURL(join(repository, path)).href);
  const {planNativeDshAssembly, readNativeDshManifest} = await load('packages/agent/dist/runtime/dsh/native-assembly.js');
  const {nativeDshRequiresRestart} = await load('packages/agent/dist/runtime/dsh/native-lifecycle.js');
  const parsed = await readNativeDshManifest(fixtureRoot);
  const plan = planNativeDshAssembly(fixtureRoot, parsed, [
    {id: 'probe-native', subpath: '.', capabilities: ['tools', 'hooks']},
    {id: 'probe-factory', subpath: './factory-a', factory: true, capabilities: ['factory']},
    {id: 'probe-control', subpath: './control', capabilities: ['agents']},
  ], ['tools', 'hooks', 'factory', 'agents']);
  assert.equal(plan.entries.length, 3);
  assert.equal(plan.factory?.subpath, './factory-a');
  const factoryA = {id: 'factory-a'};
  assert.equal(nativeDshRequiresRestart({factory: factoryA}, {factory: factoryA}), false);
  assert.equal(nativeDshRequiresRestart({factory: factoryA}, {factory: {id: 'factory-b'}}), true);
  return fixtureRoot;
}

async function main(argv) {
  const {values} = parseArgs({
    args: argv,
    options: {
      list: {type: 'boolean'},
      only: {type: 'string', multiple: true},
      json: {type: 'boolean'},
      timeout: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
  });
  if (values.help) {
    console.info(help);
    return;
  }
  if (values.list) {
    printList();
    return;
  }
  const timeoutMs = values.timeout === undefined ? 180_000 : Number(values.timeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw Error('--timeout must be an integer of at least 1000 ms');
  const fixtureRoot = await verifyFixtureShape();
  const selectedCases = selected(values.only);
  const requiredPhases = values.only ? new Set(selectedCases.flatMap(testCase => testCase.covers)) : new Set(Object.keys(requirements));
  const started = Date.now();
  const results = [];
  const home = await mkdtemp(join(tmpdir(), 'mote-agent-extension-matrix-'));
  try {
    for (const [index, testCase] of selectedCases.entries()) {
      if (!values.json) console.info(`[${index + 1}/${selectedCases.length}] ${testCase.id} (${testCase.covers.join(', ')})`);
      const caseStarted = Date.now();
      const result = await runCase(testCase, timeoutMs, home);
      result.durationMs = Date.now() - caseStarted;
      results.push(result);
      if (!values.json) {
        if (result.problems.length) console.info(`  FAILED: ${result.problems.join('; ')}`);
        else console.info(`  ok: ${testCase.tests.length} named cases passed in ${result.durationMs} ms`);
      }
      if (result.problems.length) {
        if (!values.json) {
          if (result.stdout.trim()) console.error(`--- stdout (tail) ---\n${tail(result.stdout)}`);
          if (result.stderr.trim()) console.error(`--- stderr (tail) ---\n${tail(result.stderr)}`);
        }
        break;
      }
    }
  } finally {
    await rm(home, {recursive: true, force: true});
  }
  const passed = results.filter(result => !result.problems.length);
  const coverage = Object.fromEntries(Object.keys(requirements).map(phase => [phase, 0]));
  for (const result of passed) for (const phase of result.testCase.covers) coverage[phase]++;
  const missing = Object.entries(coverage).filter(([phase, count]) => requiredPhases.has(phase) && count === 0).map(([phase]) => phase);
  const failed = results.find(result => result.problems.length);
  const ok = !failed && missing.length === 0;
  const report = {
    status: ok ? 'passed' : 'failed',
    fixtureOnly: true,
    liveModel: false,
    physicalDevice: false,
    matrix: ['new-package', 'hook', 'factory-replacement', 'run', 'revoke', 'restart'],
    fixture: fixtureRoot.replace(/^.*\/packages\//, 'packages/'),
    durationMs: Date.now() - started,
    cases: results.map(result => ({
      id: result.testCase.id,
      file: `${result.testCase.cwd}/${result.testCase.file}`,
      status: result.problems.length ? 'failed' : 'passed',
      covers: result.testCase.covers,
      tests: result.testCase.tests.length,
      durationMs: result.durationMs,
      ...(result.problems.length ? {problems: result.problems} : {}),
    })),
    coverage,
    missing: [...missing, ...(failed ? failed.problems : [])],
  };
  if (values.json) {
    console.info(JSON.stringify(report, null, 2));
  } else {
    console.info('\nCoverage:');
    for (const [phase, description] of Object.entries(requirements)) {
      if (!requiredPhases.has(phase)) continue;
      const count = coverage[phase];
      console.info(`  ${count ? 'ok  ' : 'FAIL'} ${phase.padEnd(20)} ${description} (${count} passing cases)`);
    }
    console.info(`\nResult: ${ok ? 'PASS' : 'FAIL'} (${passed.length}/${selectedCases.length} cases, ${report.durationMs} ms)`);
    if (failed) console.info(`First failure: ${failed.testCase.id}: ${failed.problems.join('; ')}`);
    if (missing.length) console.info(`Missing coverage: ${missing.join(', ')}`);
  }
  if (!ok) process.exitCode = 1;
}

await main(process.argv.slice(2));
