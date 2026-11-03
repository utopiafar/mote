import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The existing managed-calendar-native.ts fixture starts the generated Central
// node (real capability declaration, grant, delivery, claim and receipt writes).
// Only the unavailable Android HTTP runtime is replaced by JDK HTTP inside the
// JVM test. The emulator native Calendar Provider journey remains separately
// gated and is never started by this process.
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.deepEqual(process.argv.slice(2), [], 'This case accepts no arguments');
let fixture: ChildProcess | undefined;
let child: ChildProcess | undefined;
let interrupted = false;
let failure: unknown;
const terminate = (target: ChildProcess | undefined) => {
  if (!target?.pid || target.exitCode !== null || target.signalCode !== null) return;
  try { process.kill(process.platform === 'win32' ? target.pid : -target.pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
};
const interrupt = () => { interrupted = true; terminate(child); terminate(fixture); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const startFixture = () => new Promise<{origin: string; token: string}>((done, reject) => {
  const fixtureProcess = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'apps/android/test-fixtures/managed-calendar-native.ts')], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'], detached: process.platform !== 'win32',
  });
  fixture = fixtureProcess;
  let output = '';
  const timeout = setTimeout(() => { terminate(fixtureProcess); reject(Error('Managed calendar fixture did not publish its origin')); }, 120_000);
  fixtureProcess.stdout!.setEncoding('utf8');
  fixtureProcess.stdout!.on('data', chunk => {
    output += chunk;
    const line = output.split('\n')[0];
    if (!line) return;
    let value: {origin?: string; ownerToken?: string};
    try { value = JSON.parse(line); } catch { return; }
    if (!value.origin || !value.ownerToken) return;
    clearTimeout(timeout);
    done({origin: value.origin, token: value.ownerToken});
  });
  fixtureProcess.once('error', error => { clearTimeout(timeout); reject(error); });
  fixtureProcess.once('exit', (code, signal) => { clearTimeout(timeout); reject(Error(`Managed calendar fixture exited early (${signal ?? code})`)); });
});
try {
  const host = await startFixture();
  if (interrupted) throw Error('Managed calendar acknowledgement interrupted before Gradle started');
  const args = ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    '--tests', 'dev.mote.collector.plugins.ManagedCalendarDeliveryContractTest'];
  child = spawn(resolve(root, 'apps/android/gradlew'), args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_MANAGED_CALENDAR_ORIGIN: host.origin, MOTE_MANAGED_CALENDAR_TOKEN: host.token}});
  await new Promise<void>((done, reject) => {
    let processFailure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      processFailure = Error('Managed calendar acknowledgement Gradle process exceeded 15 minutes');
      terminate(child);
      force = setTimeout(() => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processFailure = new AggregateError([processFailure, error], 'Gradle timeout and termination failed'); }
        }
      }, 5000);
    }, 15 * 60 * 1000);
    child!.once('error', error => { processFailure = error; });
    child!.once('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(force);
      if (processFailure) reject(processFailure);
      else if (code !== 0 || interrupted) reject(Error(`Managed calendar acknowledgement Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const report = await readFile(resolve(root,
    'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.plugins.ManagedCalendarDeliveryContractTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 1, 'The managed calendar acknowledgement case must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Managed calendar ${attribute}`);
  console.log('Real Central declaration/grant/delivery/claim/receipt → Kotlin managed calendar journal passed (generated SQLite/HTTP; no device calendar).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  terminate(child);
  terminate(fixture);
}
if (failure) throw failure;
process.exit(0);
