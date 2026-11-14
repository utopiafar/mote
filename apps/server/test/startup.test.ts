import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { serializeConfigDocument } from '@mote/shared/config-file';
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
async function startNode(directory:string, port:number, prepareSelfPid:boolean) {
  const configFile = join(directory, 'mote.yaml');
  await writeFile(configFile, serializeConfigDocument({ version: 1, revision: 0, server: { profile: 'test', runtime: 'native', host: '127.0.0.1', port, token: 'synthetic-startup-fixture-token-only' }, storage: { dataDir: directory, maxStorageBytes: 10 * 1024 * 1024, maxExportBytes: 1024 * 1024 }, models: { deployment: { model: '' } }, diagnostics: { level: 'silent' } }), { mode: 0o600 });
  const script = `${prepareSelfPid ? `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; writeFileSync(join(${JSON.stringify(directory)},'server.pid'),String(process.pid));` : ''}\nawait import(${JSON.stringify(entry)});`;
  const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', script], {
    stdio:['ignore','pipe','pipe'],
    // Explicit synthetic configuration; never forward model credentials or personal data paths.
    env:{ PATH:process.env.PATH, TMPDIR:tmpdir(), MOTE_CONFIG_FILE:configFile },
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
  const port = await availablePort(); const node = await startNode(directory, port, true);
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
  // Wait for the fork to initialize too: an inherited --eval bootstrap could
  // replace server.pid just after health becomes available.
  let maintenanceReady = false;
  const workerDeadline = Date.now() + 10000;
  while (Date.now() < workerDeadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers:{authorization:'Bearer synthetic-startup-fixture-token-only'}, signal:AbortSignal.timeout(2000),
    });
    const status = await response.json() as {runtime?:{maintenance?:{status:string}}};
    if (status.runtime?.maintenance?.status === 'ready') { maintenanceReady = true; break; }
    await delay(50);
  }
  assert.ok(maintenanceReady, `Maintenance worker did not become ready: ${node.output()}`);
  assert.equal(await readFile(join(directory, 'server.pid'), 'utf8'), String(node.child.pid));
  await stop(node.child, node.exited);
  assert.equal(await node.exited, 0);
  await assert.rejects(readFile(join(directory, 'server.pid')), { code:'ENOENT' });
});

test('a real central process refuses a lock belonging to another live process without replacing it', { timeout:20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-startup-test-'));
  const path = join(directory, 'server.pid');
  await writeFile(path, String(process.pid));
  const node = await startNode(directory, await availablePort(), false);
  t.after(async () => { await stop(node.child, node.exited); await rm(directory, { recursive:true, force:true }); });
  assert.notEqual(await node.exited, 0);
  assert.match(node.output(), /data_directory_in_use/);
  assert.equal(await readFile(path, 'utf8'), String(process.pid));
});

test('a real central process reports an occupied HTTP port and releases startup resources', { timeout:20000 }, async t => {
  const directory=await mkdtemp(join(tmpdir(),'mote-startup-test-'));
  const socket=createServer();
  let node:Awaited<ReturnType<typeof startNode>>|undefined;
  t.after(async()=>{
    try{if(node)await stop(node.child,node.exited);}finally{
      await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
      await rm(directory,{recursive:true,force:true});
    }
  });
  await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
  const port=(socket.address() as {port:number}).port;
  node=await startNode(directory,port,false);
  assert.equal(await node.exited,1);
  assert.match(node.output(),/"event":"server.start_failed","category":"port_in_use"/);
  await assert.rejects(readFile(join(directory,'server.pid')),{code:'ENOENT'});
  await assert.rejects(readFile(join(directory,'.mote.yaml.runtime.json')),{code:'ENOENT'});
});
