import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanSupportBundle, scanText} from './sensitive-scan.mjs';

const script = fileURLToPath(new URL('./sensitive-scan.mjs', import.meta.url));
const generated = () => randomBytes(8).toString('hex');

function cleanAndroidSupportBundle() {
  return {
    version: 1,
    app: {platform: 'android', version: '0.0.1', profile: 'dev', applicationId: 'dev.mote.collector', androidApi: 35},
    state: {captureEnabled: true, accessibilityConnected: true, queueDepth: 2, queueBytes: 90, localSourceCount: 1},
    configuration: {configured: true, diagnosticsEnabled: true, intervalSeconds: 5, wifiOnly: false},
    logs: {after: '2026-11-04T00:00:00Z', before: '2026-11-04T01:00:00Z', oldestRetainedAt: null, retentionLimited: false, text: '2026-11-04T00:00:00Z INFO  [thread-1] UPLOAD - AUTH httpStatus=401'},
    events: [{atMs: 1, stage: 'upload', code: 'auth', level: 'error', httpStatus: 401, errorName: 'OtherError'}],
    samples: [{atMs: 1, batteryPct: 80, charging: true, queueDepth: 2}],
    batteryAttribution: 'device-wide, not attributable to Mote',
  };
}

test('a clean compiled bundle and clean support bundle pass', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-sensitive-clean-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const cleanBundle = 'export const answer = 42;\nconst label = "Generated clean bundle";\n';
  assert.deepEqual(scanText(cleanBundle), []);
  const support = cleanAndroidSupportBundle();
  assert.deepEqual(scanSupportBundle(JSON.stringify(support)), []);
  writeFileSync(join(directory, 'app.js'), cleanBundle);
  mkdirSync(join(directory, 'support'));
  writeFileSync(join(directory, 'support', 'mote-support.json'), JSON.stringify(support));
  const result = spawnSync(process.execPath, [script, '--json', directory], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.findings.length, 0);
  assert.equal(report.files, 2);
});

test('injected key, private body and host-private path are detected in a support bundle', () => {
  const secret = `sk-fixture-${generated()}${generated()}`;
  const privateBody = `GENERATED_PRIVATE_BODY_${generated()}`;
  const privatePath = join(homedir(), `mote-private-${generated()}`, 'profiles', 'dev');
  const support = cleanAndroidSupportBundle();
  support.logs.text += `\nAuthorization: Bearer ${secret}\nopen ${privatePath} failed`;
  support.events[0].capturedText = privateBody;
  const findings = scanSupportBundle(JSON.stringify(support));
  assert.deepEqual(new Set(findings.map(finding => finding.type)), new Set(['secret', 'private-body', 'private-path']));
  assert.ok(findings.some(finding => finding.rule === 'bearer-token'));
  assert.ok(findings.some(finding => finding.rule === 'forbidden-support-field:capturedText'));
  assert.ok(findings.some(finding => finding.type === 'private-path'));
  const output = JSON.stringify(findings);
  for (const privateValue of [secret, privateBody, privatePath]) assert.ok(!output.includes(privateValue), 'findings must not echo the matched value');
});

test('compiled bundle scanning detects credentials, host paths and supplied generated private markers', () => {
  const secret = `ghp_${generated()}${generated()}${generated()}`;
  const privateBody = `GENERATED_PRIVATE_BODY_${generated()}`;
  const privatePath = join(homedir(), `mote-private-${generated()}`, 'workspace', 'bundle.js');
  const bundle = `const credential = ${JSON.stringify(secret)};\nconst profile = ${JSON.stringify(privatePath)};\nconst captured = ${JSON.stringify(privateBody)};\n`;
  const withoutMarker = scanText(bundle);
  assert.ok(withoutMarker.some(finding => finding.type === 'secret'));
  assert.ok(withoutMarker.some(finding => finding.type === 'private-path'));
  assert.ok(!withoutMarker.some(finding => finding.type === 'private-body'), 'arbitrary private prose needs an explicit generated marker');
  const findings = scanText(bundle, {privateValues: [privateBody]});
  assert.deepEqual(new Set(findings.map(finding => finding.type)), new Set(['secret', 'private-body', 'private-path']));
  assert.ok(findings.some(finding => finding.rule === 'github-token'));
  assert.ok(findings.some(finding => finding.rule === 'known-private-value'));
  assert.ok(findings.some(finding => finding.rule === 'host-private-root'));
});

test('the command reports findings without leaking them and succeeds only for clean artifacts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-sensitive-cli-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const secret = `sk-fixture-${generated()}${generated()}`;
  const privateBody = `GENERATED_PRIVATE_BODY_${generated()}`;
  const privatePath = join(homedir(), `mote-private-${generated()}`, 'profile');
  const clean = spawnSync(process.execPath, [script, '--bundle', join(directory, 'missing-clean.js')], {encoding: 'utf8'});
  assert.notEqual(clean.status, 0);
  assert.match(clean.stderr, /ENOENT|no such file/i);
  const bundle = join(directory, 'bundle.js');
  writeFileSync(bundle, 'export const answer = 42;\n');
  const passed = spawnSync(process.execPath, [script, '--bundle', bundle], {encoding: 'utf8'});
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /Sensitive scan passed/);
  writeFileSync(bundle, `const credential = ${JSON.stringify(secret)};\nconst profile = ${JSON.stringify(privatePath)};\nconst captured = ${JSON.stringify(privateBody)};\n`);
  const failed = spawnSync(process.execPath, [script, '--bundle', '--private', privateBody, '--json', bundle], {encoding: 'utf8'});
  assert.equal(failed.status, 1);
  assert.ok(!failed.stdout.includes(secret));
  assert.ok(!failed.stdout.includes(privateBody));
  assert.ok(!failed.stdout.includes(privatePath));
  const report = JSON.parse(failed.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.findings.length >= 3);
  assert.equal(report.files, 1);
});
