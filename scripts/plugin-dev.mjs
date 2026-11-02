#!/usr/bin/env node
/** Minimal repository-external plugin create/dev entry.
 *
 * dev always uses a private generated profile under the system temp directory,
 * a free loopback port, and only the real Central start path. It never scans a
 * vault, edits a user's profile, configures credentials or calls a model. */
import {parseArgs} from 'node:util';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {cp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
  initialize, loadProfile, nativeIdentity, profilePaths, startNative, stopNative,
  updateProfileConfiguration, withProfileLock,
} from './profile-lib.mjs';

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
const template = join(repository, 'examples', 'external-plugin');
const ownershipFile = 'plugin-dev.json';
const help = `Mote external plugin development (Node 24+)
  create <directory> [--sdk-tarball PATH]  copy the source template; install a packed SDK when supplied
  dev --plugin DIRECTORY [--home PATH] [--profile NAME] [--port N] [--once] [--seed]
  stop --home PATH [--profile NAME]
  plugin-dev supports only --host central; other client hosts use their native build and UI/provider integration.`;

const print = value => console.info(JSON.stringify(value));
function requireCentral(host) {
  if (host !== 'central') throw Error(`plugin-dev does not support host ${host}; only central has a generic connector dev host. Build the ${host} client/provider in its native project.`);
}
function validateProfile(profile) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile) || profile === 'legacy') throw Error('Profile must be a 1–32 character isolated name; legacy is not managed by plugin-dev');
  return profile;
}
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(error => error ? reject(error) : port ? resolvePort(port) : reject(Error('Could not allocate a private dev port')));
    });
  });
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function loopbackHost(host) { return ['127.0.0.1', 'localhost', '[::1]'].includes(host); }
async function writeOwnership(paths) {
  await writeFile(join(paths.directory, ownershipFile), JSON.stringify({version: 1, createdBy: 'mote-plugin-dev', profile: paths.profile, home: paths.directory}) + '\n', {mode: 0o600, flag: 'wx'});
}
async function assertOwnership(paths, p) {
  let marker;
  try { marker = JSON.parse(await readFile(join(paths.directory, ownershipFile), 'utf8')); }
  catch { throw Error('Refusing to modify an existing profile not created by plugin-dev; use a new --home/--profile or run init explicitly.'); }
  if (marker.version !== 1 || marker.createdBy !== 'mote-plugin-dev' || marker.profile !== paths.profile || marker.home !== paths.directory) throw Error('Refusing an existing profile without a valid plugin-dev ownership marker');
  if (p.meta.runtime !== 'native' || p.profile === 'prod' || !loopbackHost(p.env.MOTE_HOST)) throw Error('plugin-dev only reuses a native loopback profile not named prod');
  if (!resolve(p.dataDir).startsWith(resolve(paths.directory) + '/')) throw Error('plugin-dev reuses only profiles whose storage stays inside the private home');
}
async function runSeed(p, plugin) {
  const seed = join(plugin, 'seed.mjs');
  if (!(await exists(seed))) throw Error(`--seed requires ${seed}`);
  const {execute} = await import('./profile-lib.mjs');
  await execute(process.execPath, [seed], {
    cwd: plugin,
    env: {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '', LANG: process.env.LANG ?? '', MOTE_URL: p.url, MOTE_TOKEN: p.env.MOTE_TOKEN},
    timeoutMs: 30000,
  });
}
async function copyTemplate(target, sdkTarball) {
  if (await exists(target)) {
    const entries = await import('node:fs/promises').then(({readdir}) => readdir(target));
    if (entries.length) throw Error(`Target ${target} is not empty; create only writes a new external plugin directory`);
  }
  await mkdir(target, {recursive: true, mode: 0o700});
  for (const name of ['source.mjs', 'seed.mjs', 'README.md', 'package.json']) await cp(join(template, name), join(target, name), {force: false});
  if (sdkTarball) {
    const source = resolve(sdkTarball);
    if (!(await exists(source))) throw Error(`SDK tarball does not exist: ${source}`);
    await mkdir(join(target, 'vendor'), {recursive: true, mode: 0o700});
    const copied = join(target, 'vendor', basename(source));
    await cp(source, copied, {force: false});
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    manifest.dependencies = {...manifest.dependencies, '@mote/plugin-sdk': `file:vendor/${basename(source)}`};
    await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    const {execute} = await import('./profile-lib.mjs');
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: target, timeoutMs: 120000});
  }
}
async function resolveSdk(plugin) {
  let resolved;
  try { resolved = createRequire(join(plugin, 'package.json')).resolve('@mote/plugin-sdk/node'); }
  catch { throw Error('Missing @mote/plugin-sdk dependency. Install the packed H07 SDK tarball with `npm install --ignore-scripts /absolute/mote-plugin-sdk-0.1.0.tgz` in the plugin project.'); }
  const sdk = await import(resolved);
  if (sdk.PLUGIN_CONTRACT_VERSION !== 1) throw Error(`Unsupported @mote/plugin-sdk contract version: ${String(sdk.PLUGIN_CONTRACT_VERSION)}; this host supports 1`);
  if (sdk.PLUGIN_SDK_VERSION !== '0.1.0') throw Error(`Unsupported @mote/plugin-sdk package version: ${String(sdk.PLUGIN_SDK_VERSION)}; this host supports 0.1.0`);
  return resolved;
}
async function dev(values) {
  requireCentral(values.host);
  const plugin = resolve(values.plugin ?? process.cwd());
  const source = join(plugin, 'source.mjs');
  if (!(await exists(source))) throw Error(`External source template is missing ${source}`);
  await resolveSdk(plugin);
  const port = values.port === undefined ? await freePort() : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('--port must be an integer between 1 and 65535');
  const home = resolve(values.home ?? join(tmpdir(), `mote-plugin-dev-${randomUUID().slice(0, 8)}`));
  const profile = validateProfile(values.profile);
  const paths = profilePaths(profile, home);
  let p;
  if (await exists(paths.configFile)) { p = await loadProfile(paths); await assertOwnership(paths, p); }
  else { await initialize(paths, {port, runtime: 'native'}); await writeOwnership(paths); p = await loadProfile(paths); }
  if ((await nativeIdentity(p)).running) throw Error('The plugin-dev profile is already running; use a separate --home/--profile for this smoke test.');
  let started, interrupted = false;
  const onSignal = () => { interrupted = true; if (started && !started.alreadyRunning) void stopNative(p).catch(() => undefined); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    started = await withProfileLock(p, async () => {
      if ((await nativeIdentity(p)).running) throw Error('The plugin-dev profile is already running; use a separate --home/--profile for this smoke test.');
      await updateProfileConfiguration(p, document => {
        document.connectors = {...(document.connectors ?? {}), modules: [source]};
        document.plugins = {...(document.plugins ?? {}), backendModules: []};
      });
      p = await loadProfile(paths);
      return startNative(p, !values.once);
    });
    if (started.alreadyRunning) throw Error('The plugin-dev profile was started by another process; refusing to stop or reuse it');
    if (interrupted) throw Error('plugin-dev was interrupted before verification completed');
    let connectors;
    const status = await fetch(p.url + '/api/connectors/status', {headers: {Authorization: `Bearer ${p.env.MOTE_TOKEN}`}, redirect: 'error', signal: AbortSignal.timeout(5000)});
    if (!status.ok) throw Error(`Central started but the connector status endpoint returned HTTP ${status.status}`);
    connectors = await status.json();
    if (values.once) {
      if (values.seed) await runSeed(p, plugin);
      print({profile, home, url: p.url, pid: started.pid, started: true, stopped: true, connectors});
      return;
    }
    print({profile, home, url: p.url, pid: started.pid, started: true, view: 'foreground'});
    if (values.seed) await runSeed(p, plugin);
    const result = await started.wait();
    if (interrupted) throw Error('plugin-dev was interrupted');
    if (result?.code !== 0 || result?.signal) throw Error(`Central exited ${result?.signal ? 'on ' + result.signal : 'with status ' + result?.code}`);
  } catch (error) {
    if (started && !started.alreadyRunning) await stopNative(p).catch(() => undefined);
    throw error;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    if (values.once && started && !started.alreadyRunning) await stopNative(p);
  }
}

async function main(argv) {
  const {values, positionals} = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      plugin: {type: 'string'}, home: {type: 'string'}, profile: {type: 'string', default: 'plugin-dev'},
      host: {type: 'string', default: 'central'}, port: {type: 'string'}, once: {type: 'boolean'}, seed: {type: 'boolean'},
      'sdk-tarball': {type: 'string'}, help: {type: 'boolean', short: 'h'},
    },
  });
  if (values.help || positionals.length === 0) { console.info(help); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or newer is required');
  const command = positionals[0];
  if (command === 'create') {
    if (!positionals[1] || positionals.length > 2) throw Error('create requires exactly one target directory');
    await copyTemplate(resolve(positionals[1]), values['sdk-tarball']);
    print({created: resolve(positionals[1]), sdkTarball: values['sdk-tarball'] ?? null});
    return;
  }
  if (command === 'dev') return dev(values);
  if (command === 'stop') {
    requireCentral(values.host);
    if (!values.home) throw Error('stop requires the private --home printed by plugin-dev dev');
    const home = resolve(values.home);
    const paths = profilePaths(validateProfile(values.profile), home);
    const p = await loadProfile(paths);
    await assertOwnership(paths, p);
    print({profile: p.profile, home, ...(await stopNative(p))});
    return;
  }
  throw Error(`Unknown plugin-dev command: ${command}`);
}

export {main as runPluginDev, dev, copyTemplate, resolveSdk};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`Mote plugin-dev: ${error.message}`); process.exitCode = 1; });
}
