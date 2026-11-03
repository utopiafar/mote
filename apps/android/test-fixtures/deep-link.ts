import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serializeMoteLink,parseMoteLink,parseDeepLinkHash,resolveMoteLink} from '@mote/shared';

// The Kotlin MoteLinkTest literals below are asserted against the shared
// schema here, so a drift between the TS schema and the Kotlin mirror fails
// before the JVM suite runs. No device, server or model is involved: the
// schema is pure route data.
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.deepEqual(process.argv.slice(2), [], 'This case accepts no arguments');
const origin = 'https://central.example';
const id = '6a1f2b3c-4d5e-46f7-8a9b-0c1d2e3f4a5b';
const ref = 'capture:1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b5c6d';

// Canonical literals — the same strings MoteLinkTest parses.
assert.equal(serializeMoteLink({origin}, {kind:'conversation', id}), `${origin}/#/ask?conversation=${id}`);
assert.equal(serializeMoteLink({origin}, {kind:'run', id:'generated-run-42'}), `${origin}/#/activity?work=generated-run-42`);
assert.equal(serializeMoteLink({origin}, {kind:'reference', ref}), `${origin}/#/ask?evidence=${encodeURIComponent(ref)}`);
const viewLiteral = `${origin}/#/view?package=mote.notes&route=notes.editor&evidence=${encodeURIComponent(ref)}`;
assert.equal(serializeMoteLink({origin}, {kind:'view', view:{packageId:'mote.notes', routeId:'notes.editor', ref}}), viewLiteral);
assert.deepEqual(parseMoteLink(viewLiteral), {scope:{origin}, route:{kind:'view', view:{packageId:'mote.notes', routeId:'notes.editor', ref}}});
assert.deepEqual(parseDeepLinkHash('#/activity?work=run%2Bplus'), {kind:'run', id:'run+plus'});

// Same-end resolution semantics the Kotlin mirror implements.
const viewLink = parseMoteLink(viewLiteral);
assert.ok(viewLink);
assert.deepEqual(resolveMoteLink(viewLink, {origin, knownRoute: v => v.routeId === 'notes.editor'}), {status:'route', route:viewLink.route});
assert.deepEqual(resolveMoteLink(viewLink, {origin, knownRoute: () => false}), {status:'reader', ref});
assert.deepEqual(resolveMoteLink(viewLink, {origin:'https://other.example'}), {status:'foreign-scope'});
assert.deepEqual(resolveMoteLink(viewLink, {origin, granted:false}), {status:'denied'});
assert.deepEqual(resolveMoteLink(viewLink, {origin, exists:false}), {status:'missing'});

let child: ChildProcess | undefined;
let interrupted = false;
let failure: unknown;
const terminate = () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
};
const interrupt = () => { interrupted = true; terminate(); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  child = spawn(resolve(root, 'apps/android/gradlew'), ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    '--tests', 'dev.mote.collector.MoteLinkTest'], {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32', env: process.env});
  await new Promise<void>((done, reject) => {
    let failed: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      failed = Error('Deep-link Gradle process exceeded 15 minutes');
      terminate();
      force = setTimeout(() => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failed = new AggregateError([failed, error], 'Gradle timeout and termination failed'); }
        }
      }, 5000);
    }, 15 * 60 * 1000);
    child!.once('error', error => { failed = error; });
    child!.once('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(force);
      if (failed) reject(failed);
      else if (code !== 0 || interrupted) reject(Error(`Deep-link Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const report = await readFile(resolve(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.MoteLinkTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 5, 'The Kotlin deep-link cases must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Kotlin deep-link ${attribute}`);
  console.log('Shared deep-link schema → Kotlin mirror passed (generated links; no device or server).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  try { terminate(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Deep-link failed; cleanup also failed') : error; }
}
if (failure) throw failure;
