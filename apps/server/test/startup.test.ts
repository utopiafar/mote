import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const loader = createRequire(import.meta.url).resolve('tsx');
const entry = new URL('../src/index.ts', import.meta.url).href;
async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = (socket.address() as { port:number }).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}
function startNode(directory:string, port:number, prepareSelfPid:boolean) {
  const script = `${prepareSelfPid ? "import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; writeFileSync(join(process.env.MOTE_DATA_DIR,'server.pid'),String(process.pid));" : ''}\nawait import(${JSON.stringify(entry)});`;
  const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', script], {
    stdio:['ignore','pipe','pipe'],
    // Explicit synthetic configuration; never forward model credentials or personal data paths.
    env:{ PATH:process.env.PATH, TMPDIR:tmpdir(), MOTE_DATA_DIR:directory, MOTE_HOST:'127.0.0.1', MOTE_PORT:String(port),
      MOTE_TOKEN:'synthetic-startup-fixture-token-only', MOTE_MODEL:'', MOTE_MODEL_BASE_URL:'', MOTE_MODEL_API_KEY:'',
      MOTE_EMBEDDING_MODEL:'', MOTE_EMBEDDING_BASE_URL:'', MOTE_EMBEDDING_API_KEY:'', MOTE_DATA_KEY:'',
      MOTE_RETENTION_DAYS:'0', MOTE_INSIGHT_INTERVAL_HOURS:'0', MOTE_MAX_STORAGE_MB:'10', MOTE_MAX_EXPORT_MB:'1', MOTE_LOG_LEVEL:'silent' },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk:Buffer) => { output = (output + chunk.toString('utf8')).slice(-8000); });
  const exited = new Promise<number|null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  return { child, exited, output:() => output };
}
async function stop(child:ChildProcess, exited:Promise<number|null>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const force = setTimeout(() => child.kill('SIGKILL'), 5000); force.unref();
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(force); }
}

test('a real central process recovers a previous lock with its own reused PID and serves health', { timeout:20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-startup-test-'));
  const port = await availablePort(); const node = startNode(directory, port, true);
  t.after(async () => { await stop(node.child, node.exited); await rm(directory, { recursive:true, force:true }); });
  let healthy = false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (node.child.exitCode !== null || node.child.signalCode !== null) assert.fail(`Central node exited before health: ${node.output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal:AbortSignal.timeout(1000) });
      if (response.ok && (await response.json() as {ok?:boolean}).ok === true) { healthy = true; break; }
    } catch { /* The subprocess is still initializing. */ }
    await delay(50);
  }
  assert.ok(healthy, `Central health did not become ready: ${node.output()}`);
  assert.equal(await readFile(join(directory, 'server.pid'), 'utf8'), String(node.child.pid));
  await stop(node.child, node.exited);
  assert.equal(await node.exited, 0);
  await assert.rejects(readFile(join(directory, 'server.pid')), { code:'ENOENT' });
});

test('a real central process refuses a lock belonging to another live process without replacing it', { timeout:20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-startup-test-'));
  const path = join(directory, 'server.pid');
  await writeFile(path, String(process.pid));
  const node = startNode(directory, await availablePort(), false);
  t.after(async () => { await stop(node.child, node.exited); await rm(directory, { recursive:true, force:true }); });
  assert.notEqual(await node.exited, 0);
  assert.match(node.output(), /already in use by a running central node/);
  assert.equal(await readFile(path, 'utf8'), String(process.pid));
});
