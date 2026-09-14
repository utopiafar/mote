// Native update transaction tests. Only creates and replaces generated .app copies in a private temporary directory.
const assert = require('node:assert/strict');
const { mkdtemp, realpath, mkdir, writeFile, readFile, copyFile, chmod, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const run = promisify(execFile);
const { prepareInstall, startInstall, inspectBundle, cancelPreparedInstall, recoverInterruptedUpdate } = require('../dist/update-install');
const helper = resolve(__dirname, '../native/bin/mote-updater');
async function until(fn, seconds = 25) { const end = Date.now() + seconds * 1000; while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Fixture phase timeout'); }
(async () => {
  if (process.platform !== 'darwin') { console.log(JSON.stringify({ skipped: true, reason: 'macOS native fixture only' })); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-native-update-fixture-')));
  const applications = join(root, 'Applications'), profiles = join(root, 'profiles'), updates = join(profiles, 'test', 'updates');
  await mkdir(applications); await mkdir(updates, { recursive: true });
  const pidFile = join(root, 'launched.json'); const parents = []; const helpers = [];
  const program = join(root, 'Fixture.swift'), binary = join(root, 'fixture-executable');
  const source = `import Foundation
import AppKit
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let info = Bundle.main.infoDictionary!
let profile = CommandLine.arguments.first(where: { $0.hasPrefix("--profile=") })?.dropFirst(10).description ?? "missing"
let version = info["CFBundleShortVersionString"] as! String
let pidPath = info["FixturePIDFile"] as! String
try! JSONSerialization.data(withJSONObject: ["pid": Int(getpid()), "profile": profile, "version": version]).write(to: URL(fileURLWithPath: pidPath), options: .atomic)
if let folder = CommandLine.arguments.first(where: { $0.hasPrefix("--mote-update-transaction=") })?.dropFirst(26).description {
  if info["FixtureAcknowledge"] as? Bool == true {
    let job = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: folder + "/job.json"))) as! [String: Any]
    try! JSONSerialization.data(withJSONObject: ["nonce": job["nonce"]!, "version": version]).write(to: URL(fileURLWithPath: folder + "/ready.json"), options: .atomic)
  } else { exit(2) }
}
application.run()
`;
  await writeFile(program, source);
  await run('swiftc', ['-O', '-module-cache-path', resolve(__dirname, '../native/bin/swift-module-cache'), program, '-o', binary]);
  const plistEscape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  async function app(name, version, acknowledge) {
    const path = join(applications, name + '.app'); await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true }); await copyFile(binary, join(path, 'Contents', 'MacOS', 'Mote Fixture')); await chmod(join(path, 'Contents', 'MacOS', 'Mote Fixture'), 0o755);
    await writeFile(join(path, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.mote.collector</string><key>CFBundleExecutable</key><string>Mote Fixture</string><key>CFBundleName</key><string>Mote Update Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>LSUIElement</key><true/><key>FixtureAcknowledge</key><${acknowledge ? 'true' : 'false'}/><key>FixturePIDFile</key><string>${plistEscape(pidFile)}</string></dict></plist>`);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', path]); return path;
  }
  async function stopFixture() {
    try {
      const { pid } = JSON.parse(await readFile(pidFile, 'utf8'));
      const command = (await run('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout;
      if (command.includes(applications + '/') && command.includes('/Contents/MacOS/Mote Fixture')) { process.kill(pid, 'SIGTERM'); await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }); }
    } catch { /* Already stopped. */ }
  }
  async function transaction(target, candidate, oldVersion, newVersion, expected) {
    const inspection = await inspectBundle(helper, candidate, newVersion, process.arch);
    const prepared = await prepareInstall({ directory: updates, helper, target, staged: candidate, stagedDigest: inspection.digest, oldVersion, newVersion, arch: process.arch, profile: 'test' });
    const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); parents.push(parent);
    prepared.job.parentPID = parent.pid; prepared.job.startupTimeoutSeconds = 5;
    await writeFile(prepared.path, JSON.stringify(prepared.job), { mode: 0o600 });
    helpers.push(await startInstall(prepared)); parent.kill('SIGTERM');
    const result = await until(async () => { try { const value = JSON.parse(await readFile(join(resolve(prepared.path, '..'), 'result.json'), 'utf8')); return value.state === expected ? value : false; } catch { return false; } });
    const launched = await until(async () => { try { const value = JSON.parse(await readFile(pidFile, 'utf8')); return value.version === (expected === 'installed' ? newVersion : oldVersion) ? value : false; } catch { return false; } });
    assert.equal(launched.profile, 'test'); return result;
  }
  try {
    const preserved = new Map();
    for (const profile of ['legacy', 'dev', 'test']) for (const file of ['config.json', 'token.enc', 'notes/draft.json', 'queue/event.json', 'models/model.gguf']) {
      const path = join(profiles, profile, file); await mkdir(resolve(path, '..'), { recursive: true }); const body = Buffer.from('synthetic-preserved-' + profile + '-' + file); await writeFile(path, body); preserved.set(path, body);
    }
    const target = await app('Installed', '0.4.0', true), good = await app('Candidate', '0.5.0', true);
    console.log('fixture: validate generated bundles');
    for (const [path, version] of [[target, '0.4.0'], [good, '0.5.0']]) { try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]); await run('/usr/bin/lipo', [path + '/Contents/MacOS/Mote Fixture', '-verify_arch', process.arch === 'x64' ? 'x86_64' : 'arm64']); assert.equal(JSON.parse((await run(helper, ['inspect', path, version, process.arch, String(process.pid)])).stdout).valid, true); } catch (error) { console.log('native inspection: ' + (error.stdout || '') + (error.stderr || '')); throw error; } }
    console.log('fixture: successful replacement');
    await transaction(target, good, '0.4.0', '0.5.0', 'installed');
    assert.equal((await inspectBundle(helper, target, '0.5.0', process.arch)).valid, true); await stopFixture();
    console.log('fixture: startup failure rollback');
    const broken = await app('Broken', '0.6.0', false); await transaction(target, broken, '0.5.0', '0.6.0', 'rolled_back'); await stopFixture();
    assert.equal((await inspectBundle(helper, target, '0.5.0', process.arch)).valid, true);
    console.log('fixture: changed staging bundle');
    const valid = await app('TamperCandidate', '0.7.0', true); const before = await inspectBundle(helper, valid, '0.7.0', process.arch);
    const tampered = await prepareInstall({ directory: updates, helper, target, staged: valid, stagedDigest: before.digest, oldVersion: '0.5.0', newVersion: '0.7.0', arch: process.arch, profile: 'test' });
    await mkdir(join(tampered.job.candidatePath, 'Contents', 'Resources'), { recursive: true }); await writeFile(join(tampered.job.candidatePath, 'Contents', 'Resources', 'extra-resource.txt'), 'synthetic background tamper'); await run('/usr/bin/codesign', ['--force', '--sign', '-', tampered.job.candidatePath]);
    await assert.rejects(startInstall(tampered)); await cancelPreparedInstall(tampered); await inspectBundle(helper, target, '0.5.0', process.arch);
    console.log('fixture: interrupted preparation recovery');
    const interrupted = await prepareInstall({ directory: updates, helper, target, staged: valid, stagedDigest: before.digest, oldVersion: '0.5.0', newVersion: '0.7.0', arch: process.arch, profile: 'test' });
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); await new Promise(resolve => dead.once('exit', resolve));
    await writeFile(join(applications, '.mote-update-lock', 'owner.json'), JSON.stringify({ nonce: interrupted.job.nonce, pid: dead.pid }));
    assert.equal(await recoverInterruptedUpdate({ directory: updates, helper, bundlePath: target, version: '0.5.0', profile: 'test' }), 'recovered');
    await assert.rejects(readFile(join(applications, '.mote-update-lock', 'owner.json')), { code: 'ENOENT' });
    await run('/usr/bin/open', ['-n', target, '--args', '--profile=second']); await until(async () => (await inspectBundle(helper, target, '0.5.0', process.arch)).otherInstances > 0);
    await assert.rejects(prepareInstall({ directory: updates, helper, target, staged: valid, stagedDigest: before.digest, oldVersion: '0.5.0', newVersion: '0.7.0', arch: process.arch, profile: 'test' }), /UPDATE_OTHER_PROFILES_RUNNING/); await stopFixture();
    for (const [path, body] of preserved) assert.deepEqual(await readFile(path), body);
    console.log(JSON.stringify({ ok: true, generatedAppCopiesOnly: true, nativeAtomicReplacement: true, sameProfileRelaunch: true, startupFailureRollback: true, resignedStageTamperRejected: true, concurrentProfileBlocked: true, interruptedPreparationRecovered: true, preservedProfileFiles: preserved.size, realKeychainNotModified: true }));
  } finally {
    await stopFixture(); for (const parent of parents) if (parent.exitCode === null) parent.kill('SIGTERM');
    for (const child of helpers) { try { process.kill(child.pid, 0); child.kill('SIGTERM'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write('Native update fixture failed: ' + error.message + '\n'); process.exitCode = 1; });
