/** G1 stage journey (manual selection only; not part of ordinary checks).
 *
 * Same shortest server journey as plugin-startup-contract.test.ts — real
 * entrypoint start, owner authentication, POST note, GET original, stop,
 * same-profile restart, reread — plus one stage step: a repository-external
 * plugin package (the H08 examples/external-plugin sample) is loaded by the
 * real Central connector registry through connectors.modules. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPrivateProcess, type PrivateProcess } from '../../test-fixtures/native-plugins/process.mjs';

const repository = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const report: { status:string; fixtureOnly:true; liveModel:false; physicalDevice:false; checks:string[]; failure?:string } = {
  status: 'running', fixtureOnly: true, liveModel: false, physicalDevice: false, checks: [],
};
let run: PrivateProcess | undefined;
const work = await mkdtemp(join(tmpdir(), 'mote-jny1-stage-'));

/** Copy the H08 sample outside the repository and give it the packed SDK
 * dependency the same way `npm install <tarball>` would, without network. */
async function stageExternalPlugin() {
  const plugin = join(work, 'external-plugin');
  await cp(join(repository, 'examples/external-plugin'), plugin, { recursive: true });
  await mkdir(join(plugin, 'node_modules/@mote'), { recursive: true, mode: 0o700 });
  await symlink(join(repository, 'packages/plugin-sdk'), join(plugin, 'node_modules/@mote/plugin-sdk'), 'junction');
  const sdkPath = createRequire(join(plugin, 'package.json')).resolve('@mote/plugin-sdk/node');
  const sdk = await import(pathToFileURL(sdkPath).href) as { PLUGIN_CONTRACT_VERSION?:unknown; PLUGIN_SDK_VERSION?:unknown };
  assert.equal(sdk.PLUGIN_CONTRACT_VERSION, 1);
  assert.equal(sdk.PLUGIN_SDK_VERSION, '0.1.0');
  return { plugin, source: pathToFileURL(join(plugin, 'source.mjs')).href };
}

async function pluginStatus(): Promise<{ ready?:boolean; sdkVersion?:string; launches?:number }> {
  const status = await run!.request('/api/connectors/example-external-source/status') as { ready?:boolean; sdkVersion?:string; launches?:number };
  assert.equal(status.ready, true);
  assert.equal(status.sdkVersion, '0.1.0');
  const all = await run!.request('/api/connectors/status') as Record<string, unknown>;
  assert.ok(Object.hasOwn(all, 'example-external-source'), 'the external connector status key is published');
  return status;
}

try {
  const { source } = await stageExternalPlugin();
  run = await createPrivateProcess({ extraDocument: { connectors: { modules: [source] } } });
  assert.equal((await fetch(run.url + '/api/status')).status, 401);
  const status = await run.request('/api/status') as { storage?:{ captures?:number } };
  assert.equal(typeof status.storage?.captures, 'number');
  report.checks.push('real entrypoint serves owner-only surfaces on a private generated profile');

  const note = { id: randomUUID(), deviceId: 'generated-jny1', deviceName: 'Generated JNY1 stage', platform: 'import', capturedAt: new Date().toISOString(), text: `Generated JNY1 stage note ${randomUUID()} original` };
  assert.equal(((await run.writeNote(note)) as { receipt?:{ state?:string } }).receipt?.state, 'received');
  assert.equal(((await run.readNote(note.id)) as { ocrText?:string }).ocrText, note.text);
  report.checks.push('owner POST note and GET original round-trip on the real listener');

  assert.equal((await pluginStatus()).launches, 1);
  report.checks.push('repository-external plugin loaded by the real host: owner route ready, host-injected state initialized');

  const stopped = await run.stop();
  assert.equal(stopped.exited, true);
  assert.equal(stopped.code, 0);
  report.checks.push('graceful shutdown of the plugin-carrying profile');

  await run.restart();
  assert.equal(((await run.readNote(note.id)) as { ocrText?:string }).ocrText, note.text);
  assert.equal((await pluginStatus()).launches, 2);
  report.checks.push('same-profile restart rereads the original and preserves host-injected plugin state');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (run) await run.close({ strict: false }).catch(cleanup => { report.failure ??= `cleanup: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`; process.exitCode = 1; });
  await rm(work, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
