#!/usr/bin/env node
/** Build-only verification for the default plugin distribution.
 *
 * Every product keeps its own release identity and artifact. This runner
 * builds Central, Web, Mac and Android from the current candidate, writes the
 * default composition/dependency descriptors beside those artifacts, checks
 * that a deliberately mismatched client is rejected with a concrete reason,
 * and can start Central plus an SDK sample from a clean directory.
 *
 * It is intentionally a manual/stage runner: it is not part of test globs and
 * it never publishes, tags or uploads an artifact. */
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir, tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const repository = resolve(fileURLToPath(new URL('../', import.meta.url)));
const defaultOutput = join(repository, 'artifacts', 'plugin-distribution');
const products = ['central', 'web', 'mac', 'android'];
const json = value => JSON.stringify(value, null, 2) + '\n';
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function writeJson(path, value) { await mkdir(dirname(path), {recursive: true}); await writeFile(path, json(value)); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw Error(`${command} ${args.join(' ')} failed with status ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout;
}
function runVisible(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: repository, stdio: 'inherit', env: process.env, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
}
function report(event, value = {}) { console.log(JSON.stringify({event, ...value})); }
async function copyTree(source, target) {
  await mkdir(dirname(target), {recursive: true});
  try {
    // macOS clonefile keeps a large dependency closure cheap; other hosts use
    // a normal recursive copy. Both produce an independent directory.
    run('cp', [process.platform === 'darwin' ? '-cR' : '-aR', source, target], {cwd: repository});
  } catch {
    await cp(source, target, {recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true});
  }
}
async function copyFileTree(source, target) {
  if (!(await exists(source))) return;
  await copyTree(source, target);
}
function gitState() {
  try {
    return {commit: run('git', ['rev-parse', 'HEAD']).trim(), dirty: run('git', ['status', '--porcelain']).trim() !== ''};
  } catch { return {commit: null, dirty: null}; }
}
function pluginContract() {
  const moduleFile = join(repository, 'packages/plugin-api/dist/contracts/snapshot.js');
  if (!existsSync(moduleFile)) throw Error('Build @mote/plugin-api before packaging the plugin distribution');
  return import(pathToFileURL(moduleFile).href + '?distribution=' + Date.now()).then(module => module.PLUGIN_CONTRACT_VERSION);
}
async function protocolContract() {
  const value = await readJson(join(repository, 'protocol/contract.json'));
  if (value.format !== 'mote.protocol' || !Number.isInteger(value.range?.min) || !Number.isInteger(value.range?.max)) throw Error('protocol/contract.json is invalid');
  return value;
}
function productVersion(product) {
  if (product === 'android') {
    const properties = run('cat', [join(repository, 'apps/android/version.properties')]);
    const version = /^versionName=(.+)$/m.exec(properties)?.[1]?.trim();
    if (!version) throw Error('Android version.properties has no versionName');
    return version;
  }
  const path = product === 'central' ? 'apps/server/package.json' : product === 'web' ? 'apps/web/package.json' : 'apps/desktop/package.json';
  const version = JSON.parse(run('cat', [join(repository, path)])).version;
  if (typeof version !== 'string' || !version) throw Error(`${path} has no version`);
  return version;
}
async function directDependencies(paths) {
  const values = new Map();
  for (const path of paths) {
    const manifest = await readJson(join(repository, path));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const installed = join(repository, 'node_modules', ...name.split('/'), 'package.json');
      if (!(await exists(installed))) continue;
      const version = (await readJson(installed)).version;
      if (typeof version === 'string') values.set(name, version);
    }
  }
  return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([name, version]) => ({name, version}));
}
async function sourceWebInventory() {
  const code = `import {loadDefaultWebPlugins,pluginContributions} from './src/plugins/default-inventory.ts';
const plugins=await loadDefaultWebPlugins();
console.log(JSON.stringify(plugins.map(plugin=>({id:plugin.id,contributions:pluginContributions(plugin).map(value=>({id:value.entry.id,surface:value.surface}))}))));`;
  const output = run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {cwd: join(repository, 'apps/web')});
  return JSON.parse(output.trim().split('\n').at(-1));
}
async function sourceDesktopInventory() {
  const code = `import {defaultDesktopPluginInventory} from './src/plugin-inventory.ts';
console.log(JSON.stringify(defaultDesktopPluginInventory));`;
  const output = run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {cwd: join(repository, 'apps/desktop')});
  return JSON.parse(output.trim().split('\n').at(-1));
}
async function sourceAndroidInventory() {
  const directory = join(repository, 'apps/android/app/src/main/java/dev/mote/collector/plugins');
  const files = (await readdir(directory)).filter(file => file.endsWith('.kt'));
  const constants = new Map(), unqualified = new Map();
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8');
    const owner = basename(file, '.kt');
    for (const match of text.matchAll(/const val ([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) {
      constants.set(`${owner}.${match[1]}`, match[2]);
      const prior = unqualified.get(match[1]);
      unqualified.set(match[1], prior === undefined || prior === match[2] ? match[2] : null);
    }
  }
  const inventory = await readFile(join(directory, 'NativeDefaultPluginInventory.kt'), 'utf8');
  const block = /val packages: List<NativeDefaultPackage> = listOf\(([\s\S]*?)\n\s*\)\n\n/.exec(inventory)?.[1];
  if (!block) throw Error('NativeDefaultPluginInventory packages block is missing');
  const packages = [];
  for (const match of block.matchAll(/NativeDefaultPackage\("([^"]+)", listOf\(([^)]*)\)/g)) {
    const capabilities = match[2].split(',').map(value => value.trim()).filter(Boolean).map(token => {
      if (/^"[^"]+"$/.test(token)) return token.slice(1, -1);
      return constants.get(token) ?? unqualified.get(token) ?? undefined;
    });
    if (capabilities.some(value => !value)) throw Error(`Unknown Android capability in ${match[1]}`);
    packages.push({id: match[1], capabilities});
  }
  if (!packages.length) throw Error('Android default plugin inventory has no package');
  const owners = [...inventory.matchAll(/NativeComponentOwner\("([^"]+)", (?:component\("([^"]+)"\)|"([^"]+)"), "([^"]+)", (?:[^")]+|"[^"]*")\)/g)]
    .map(match => ({kind: match[1], component: match[2] ?? match[3], packageId: match[4]}));
  return {packages, owners};
}
async function centralManifest(contract, protocol, version = productVersion('central')) {
  const moduleFile = join(repository, 'apps/server/dist/distribution/default.js');
  if (!existsSync(moduleFile)) throw Error('Build @mote/server before packaging the plugin distribution');
  const module = await import(pathToFileURL(moduleFile).href + '?distribution=' + Date.now());
  const distribution = module.defaultDistribution;
  const foundations = distribution.foundations.map(provider => ({
    id: provider.id, version: provider.version, contribution: provider.contribution,
  }));
  const domainPackages = distribution.plugins.map(plugin => ({
    id: plugin.contribution.id,
    version: plugin.contribution.version,
    replacement: plugin.replacement,
    contributions: [plugin.contribution],
    capabilities: (plugin.contribution.provides ?? []).map(provider => provider.id),
    dependencies: [],
  }));
  const hostDependencies = [
    ...foundations.map(provider => ({id: provider.id, version: provider.version})),
    {id: 'mote.plugin.contract', version: String(contract)},
    {id: 'mote.protocol', version: String(protocol.range.max)},
  ].sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    product: 'central',
    productVersion: version,
    source: gitState(),
    contract: {plugin: contract, protocol: protocol.range, ingress: protocol.ingressVersion},
    features: [...distribution.features],
    foundations,
    packages: domainPackages,
    hostDependencies,
    runtimeDependencies: await directDependencies(['apps/server/package.json', 'packages/agent/package.json', 'packages/shared/package.json', 'packages/plugin-api/package.json', 'packages/plugin-host/package.json']),
  };
}
async function webManifest(contract, protocol, inventory, version = productVersion('web')) {
  const packages = inventory.map(plugin => ({
    id: plugin.id,
    version: '1',
    contributions: plugin.contributions.map(contribution => ({
      id: `${plugin.id}:${contribution.surface}:${contribution.id}`,
      version: '1',
      surface: contribution.surface,
      runtime: 'host',
    })),
    capabilities: [],
    dependencies: [],
  }));
  return {
    schemaVersion: 1,
    product: 'web',
    productVersion: version,
    source: gitState(),
    contract: {plugin: contract, protocol: protocol.range, ingress: protocol.ingressVersion},
    packages,
    hostDependencies: [
      {id: 'mote.plugin.contract', version: String(contract)},
      {id: 'mote.protocol', version: String(protocol.range.max)},
    ],
    runtimeDependencies: await directDependencies(['apps/web/package.json']),
  };
}
async function macManifest(contract, protocol, inventory, version = productVersion('mac')) {
  const packages = inventory.packages.map(pkg => ({
    id: pkg.id,
    version: '1',
    contributions: [{
      id: `${pkg.id}:native`,
      version: '1',
      surface: 'data',
      runtime: 'native',
      capabilities: [...pkg.capabilities],
    }],
    capabilities: [...pkg.capabilities],
    channels: [...pkg.channels],
    jobs: [...pkg.jobs],
    dependencies: [],
  }));
  return {
    schemaVersion: 1,
    product: 'mac',
    productVersion: version,
    source: gitState(),
    contract: {plugin: contract, protocol: protocol.range, ingress: protocol.ingressVersion},
    packages,
    hostPrimitives: inventory.hostPrimitives,
    pushChannels: inventory.pushChannels,
    nativeProviders: inventory.nativeProviders,
    hostDependencies: [
      {id: 'mote.plugin.contract', version: String(contract)},
      {id: 'mote.protocol', version: String(protocol.range.max)},
    ],
    runtimeDependencies: await directDependencies(['apps/desktop/package.json']),
  };
}
async function androidManifest(contract, protocol, inventory, version = productVersion('android')) {
  const packages = inventory.packages.map(pkg => ({
    id: pkg.id,
    version: '1',
    contributions: [{
      id: `${pkg.id}:native`,
      version: '1',
      surface: 'data',
      runtime: 'native',
      capabilities: [...pkg.capabilities],
    }],
    capabilities: [...pkg.capabilities],
    dependencies: [],
  }));
  return {
    schemaVersion: 1,
    product: 'android',
    productVersion: version,
    source: gitState(),
    contract: {plugin: contract, protocol: protocol.range, ingress: protocol.ingressVersion},
    packages,
    components: inventory.owners,
    hostDependencies: [
      {id: 'mote.plugin.contract', version: String(contract)},
      {id: 'mote.protocol', version: String(protocol.range.max)},
    ],
    runtimeDependencies: [],
  };
}
function assertManifest(manifest, expectedProduct) {
  const fail = message => { throw Error(`${expectedProduct} distribution: ${message}`); };
  if (!manifest || manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (manifest.product !== expectedProduct) fail(`product is ${manifest.product}`);
  if (typeof manifest.productVersion !== 'string' || !manifest.productVersion) fail('productVersion is missing');
  if (!Number.isInteger(manifest.contract?.plugin) || manifest.contract.plugin < 1) fail('plugin contract version is invalid');
  if (!Number.isInteger(manifest.contract?.protocol?.min) || !Number.isInteger(manifest.contract?.protocol?.max)) fail('protocol range is invalid');
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) fail('default package list is empty');
  const packageIds = new Set(), contributionIds = new Set();
  let contributionCount = 0;
  for (const pkg of manifest.packages) {
    if (typeof pkg.id !== 'string' || !pkg.id) fail('package id is invalid');
    if (packageIds.has(pkg.id)) fail(`duplicate package ${pkg.id}`);
    packageIds.add(pkg.id);
    if (typeof pkg.version !== 'string' || !pkg.version) fail(`${pkg.id} version is missing`);
    if (!Array.isArray(pkg.contributions)) fail(`${pkg.id} contributions are missing`);
    contributionCount += pkg.contributions.length;
    for (const contribution of pkg.contributions) {
      if (typeof contribution.id !== 'string' || !contribution.id) fail(`${pkg.id} contribution id is invalid`);
      const key = `${contribution.id}@${contribution.version}`;
      if (contributionIds.has(key)) fail(`duplicate contribution ${key}`);
      contributionIds.add(key);
      if (!['ingress', 'processing', 'data', 'command', 'page', 'collection', 'home', 'panel', 'renderer'].includes(contribution.surface)) fail(`${pkg.id} contribution surface is invalid`);
      if (!['worker', 'service', 'host', 'native'].includes(contribution.runtime)) fail(`${pkg.id} contribution runtime is invalid`);
    }
    if (!Array.isArray(pkg.capabilities)) fail(`${pkg.id} capabilities are missing`);
  }
  if (contributionCount === 0) fail('default composition has no contribution');
  if (!Array.isArray(manifest.hostDependencies)) fail('hostDependencies are missing');
  const hostIds = new Set();
  for (const dependency of manifest.hostDependencies) {
    if (!dependency || typeof dependency.id !== 'string' || typeof dependency.version !== 'string') fail('host dependency is invalid');
    if (hostIds.has(dependency.id)) fail(`duplicate host dependency ${dependency.id}`);
    hostIds.add(dependency.id);
  }
  if (!hostIds.has('mote.plugin.contract')) fail('host dependency mote.plugin.contract is missing');
  if (!hostIds.has('mote.protocol')) fail('host dependency mote.protocol is missing');
  if (!Array.isArray(manifest.runtimeDependencies)) fail('runtimeDependencies are missing');
}
function fakeClientPackage(manifest, contract) {
  const capabilitySet = new Set();
  const contributions = manifest.packages.flatMap(pkg => pkg.contributions.map(contribution => {
    const id = `${manifest.product}.${pkg.id}.${contribution.id}`.replace(/[^a-zA-Z0-9._:-]/g, '-');
    for (const capability of contribution.capabilities ?? []) capabilitySet.add(capability);
    return {
      id,
      version: String(contribution.version ?? '1'),
      surface: contribution.surface,
      runtime: contribution.runtime,
      ...(contribution.capabilities?.length ? {capabilities: contribution.capabilities} : {}),
    };
  }));
  return {
    schemaVersion: 1,
    id: `mote.distribution.${manifest.product}`,
    name: `Mote ${manifest.product} distribution`,
    version: manifest.productVersion,
    trust: 'official',
    runtime: 'service',
    entry: 'plugin-distribution.json',
    archive: {asset: 'distribution.zip', sha256: '0'.repeat(64)},
    contributions,
    capabilities: [...capabilitySet],
    configuration: [],
    dependencies: [{kind: 'host', id: 'mote.plugin.contract', version: String(contract)}],
    access: ['Build-only default distribution compatibility check'],
  };
}
async function verifyCompatibility(centralDirectory, clientManifests) {
  const hostModule = join(centralDirectory, 'node_modules/@mote/plugin-host/dist/index.js');
  if (!(await exists(hostModule))) throw Error('The Central artifact is missing @mote/plugin-host');
  const {planComposition} = await import(pathToFileURL(hostModule).href + '?distribution=' + Date.now());
  const central = await readJson(join(centralDirectory, 'plugin-distribution.json'));
  const hostDependencies = central.hostDependencies;
  const results = [];
  for (const manifest of clientManifests) {
    assertManifest(manifest, manifest.product);
    const host = manifest.product === 'mac' ? 'mac' : manifest.product === 'android' ? 'android' : manifest.product === 'web' ? 'web' : 'central';
    const accepted = planComposition({revision: 1, host, packages: [fakeClientPackage(manifest, manifest.contract.plugin)], hostDependencies});
    if (!accepted.ok) throw Error(`${manifest.product} default client is incompatible with the Central distribution: ${accepted.failures.map(value => value.message).join('; ')}`);
    results.push({product: manifest.product, contract: manifest.contract.plugin, result: 'accepted'});

    const mismatchedVersion = String(manifest.contract.plugin + 1);
    const mismatched = planComposition({revision: 1, host, packages: [fakeClientPackage(manifest, mismatchedVersion)], hostDependencies});
    const failure = mismatched.failures?.find(value => value.code === 'version_mismatch' && value.dependency?.id === 'mote.plugin.contract');
    if (mismatched.ok || !failure || mismatched.plan !== undefined) throw Error(`${manifest.product} deliberately mismatched contract ${mismatchedVersion} was not rejected with a concrete version_mismatch`);
    results.push({
      product: manifest.product,
      contract: mismatchedVersion,
      result: 'rejected',
      code: failure.code,
      message: failure.message,
      dependency: failure.dependency,
      remediation: failure.remediation,
    });
  }
  return results;
}
async function verifyBuiltCentral(directory, manifest) {
  for (const path of ['apps/server/dist/index.js', 'apps/server/dist/distribution/default.js', 'apps/web/dist/index.html', 'apps/web/dist/build-info.json', 'node_modules/@mote/agent/package.json', 'node_modules/@mote/plugin-host/package.json', 'scripts/mote.mjs']) {
    if (!(await exists(join(directory, path)))) throw Error(`Central artifact is missing ${path}`);
  }
  const webVersion = (await readJson(join(directory, 'apps/web/dist/build-info.json'))).version;
  const serverVersion = (await readJson(join(directory, 'apps/server/package.json'))).version;
  if (webVersion !== serverVersion || serverVersion !== manifest.productVersion) throw Error('Central artifact server/web versions do not match the distribution descriptor');
  const builtModule = await import(pathToFileURL(join(directory, 'apps/server/dist/distribution/default.js')).href + '?verify=' + Date.now());
  const actualPackages = builtModule.defaultDistribution.plugins.map(plugin => plugin.contribution.id).sort();
  const declaredPackages = manifest.packages.map(pkg => pkg.id).sort();
  if (JSON.stringify(actualPackages) !== JSON.stringify(declaredPackages)) throw Error('Central artifact default plugin selection differs from its descriptor');
  if (JSON.stringify([...builtModule.defaultDistribution.features].sort()) !== JSON.stringify([...manifest.features].sort())) throw Error('Central artifact default feature selection differs from its descriptor');
  return {packages: declaredPackages.length, features: manifest.features.length};
}
async function verifyBuiltWeb(directory, manifest) {
  for (const path of ['dist/index.html', 'dist/build-info.json', 'dist/plugin-distribution.json']) if (!(await exists(join(directory, path)))) throw Error(`Web artifact is missing ${path}`);
  if ((await readJson(join(directory, 'dist/build-info.json'))).version !== manifest.productVersion) throw Error('Web artifact version differs from its distribution descriptor');
  if ((await readJson(join(directory, 'dist/plugin-distribution.json'))).product !== 'web') throw Error('Web artifact descriptor is not the built Web composition');
  return {packages: manifest.packages.length, contributions: manifest.packages.reduce((count, pkg) => count + pkg.contributions.length, 0)};
}
async function verifyBuiltMac(directory, manifest) {
  for (const path of ['dist/main.js', 'dist/preload.js', 'dist/ui-bundle.js', 'dist/plugin-distribution.json']) if (!(await exists(join(directory, path)))) throw Error(`Mac artifact is missing ${path}`);
  if ((await readJson(join(directory, 'dist/plugin-distribution.json'))).product !== 'mac') throw Error('Mac artifact descriptor is not the built desktop composition');
  if (manifest.nativeProviders.some(provider => !manifest.packages.some(pkg => pkg.id === provider.packageId))) throw Error('Mac native provider has no owning default package');
  return {packages: manifest.packages.length, nativeProviders: manifest.nativeProviders.length};
}
function javaMajor(javaHome) {
  const result = spawnSync(join(javaHome, 'bin/java'), ['-version'], {encoding: 'utf8'});
  if (result.error || result.status !== 0) return undefined;
  return Number(/version "(\d+)/.exec(String(result.stderr || result.stdout))?.[1]);
}
async function androidTools() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk');
  const javaCandidates = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@21', '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home', '/usr/lib/jvm/java-21-openjdk-amd64', '/usr/lib/jvm/default-java', '/Applications/Android Studio.app/Contents/jbr/Contents/Home'].filter(Boolean);
  const detected = [];
  for (const candidate of javaCandidates) {
    if (!(await exists(join(candidate, 'bin/java')))) continue;
    const major = javaMajor(candidate);
    if (major !== undefined) detected.push({home: candidate, major});
  }
  const chosen = detected.find(value => value.major === 21) ?? detected.find(value => value.major === 17) ?? detected.find(value => value.major >= 17 && value.major <= 24);
  if (!chosen) throw Error(`Android packaging requires JDK 17–24; detected ${detected.map(value => value.major).join(', ') || 'none'} (no build was claimed)`);
  const javaHome = chosen.home;
  if (!(await exists(join(sdk, 'platforms/android-36')))) throw Error(`Android SDK platform 36 is missing under ${sdk}`);
  const buildTools = (await readdir(join(sdk, 'build-tools'))).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
  const aapt2 = buildTools.length ? join(sdk, 'build-tools', buildTools.at(-1), 'aapt2') : undefined;
  return {sdk, javaHome, aapt2, env: {...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}:${process.env.PATH ?? ''}`}};
}
async function verifyBuiltAndroid(directory, manifest) {
  const apk = join(directory, 'app-development.apk');
  if (!(await exists(apk))) throw Error('Android artifact is missing app-development.apk');
  const tools = await androidTools();
  if (!tools.aapt2 || !(await exists(tools.aapt2))) throw Error('Android artifact verification requires aapt2');
  const embedded = JSON.parse(run('unzip', ['-p', apk, 'assets/plugin-distribution.json']));
  if (embedded.product !== 'android' || embedded.packages.length !== manifest.packages.length) throw Error('Android APK distribution descriptor differs from its artifact descriptor');
  const xml = run(tools.aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]);
  const componentPackages = new Set(manifest.components.map(component => component.packageId));
  for (const packageId of componentPackages) if (!xml.includes(`="${packageId}"`)) throw Error(`Android APK manifest has no owner tag for ${packageId}`);
  for (const component of manifest.components) if (!manifest.packages.some(pkg => pkg.id === component.packageId)) throw Error(`Android component owner ${component.packageId} has no default package`);
  if (!xml.includes('="host.shell"')) throw Error('Android APK manifest has no shell owner');
  return {packages: manifest.packages.length, components: manifest.components.length};
}
async function cleanDirectory(prefix) { return realpath(await mkdtemp(join(tmpdir(), prefix))); }
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(error => error ? reject(error) : port ? resolvePort(port) : reject(Error('Could not allocate a free loopback port')));
    });
  });
}
async function waitFor(predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* retry until the deadline */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw Error('Timed out waiting for the packaged distribution');
}
function jsonLines(output) {
  return output.trim().split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
}
async function request(url, token, options = {}) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    ...options,
    headers: {Authorization: `Bearer ${token}`, ...(options.body ? {'Content-Type': 'application/json'} : {}), ...(options.headers ?? {})},
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) throw Error(`${options.method ?? 'GET'} ${url} returned HTTP ${response.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}
async function cleanRun(artifact, manifest) {
  const temporary = await cleanDirectory('mote-plugin-distribution-clean-');
  const clean = join(temporary, 'central');
  const home = join(temporary, 'home');
  let started = false;
  try {
    await copyTree(artifact, clean);
    const cli = join(clean, 'scripts/mote.mjs');
    if (!(await exists(cli))) throw Error('Central artifact does not carry scripts/mote.mjs');
    const port = await freePort();
    run(process.execPath, [cli, 'init', '--profile', 'distcheck', '--home', home, '--port', String(port)], {cwd: clean});
    run(process.execPath, [cli, 'start', '--profile', 'distcheck', '--home', home], {cwd: clean});
    started = true;
    const token = run(process.execPath, [cli, 'token', '--profile', 'distcheck', '--home', home], {cwd: clean}).trim();
    const url = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await request(url + '/api/health', token)).ok !== false);
    const health = await request(url + '/api/health', token);
    if (typeof health.version !== 'string' || health.version !== manifest.productVersion) throw Error('Packaged Central health version differs from the distribution descriptor');
    const inventory = await request(url + '/api/features', token);
    if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.features)) throw Error('Packaged Central feature inventory is invalid');
    for (const id of manifest.features) {
      const feature = inventory.features.find(value => value.id === id);
      if (!feature) throw Error(`Packaged Central is missing default feature ${id}`);
      if (!inventory.capabilities.some(value => value.featureId === id && value.state === 'active')) throw Error(`Packaged Central default feature ${id} is not active`);
    }
    const web = await fetch(url + '/', {redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (!web.ok || !String(web.headers.get('content-type')).includes('text/html')) throw Error('Packaged Central did not serve the bundled Web application');
    await web.body?.cancel();
    const note = {
      id: randomUUID(), deviceId: 'generated-distribution-device', deviceName: 'Generated packaged distribution',
      platform: 'android', capturedAt: new Date().toISOString(), text: 'Generated note read back from the packaged distribution.',
    };
    await request(url + '/api/notes', token, {method: 'POST', body: JSON.stringify(note)});
    const read = await request(url + `/api/notes/${note.id}`, token);
    if (read.ocrText !== note.text) throw Error('Packaged Central did not read back the generated note');

    const sdkDirectory = join(clean, 'sdk');
    const tarballs = (await readdir(sdkDirectory)).filter(name => name.endsWith('.tgz'));
    if (tarballs.length !== 1) throw Error('Central artifact must carry exactly one packed SDK tarball');
    const sample = join(temporary, 'sdk-connector');
    const createOutput = run(process.execPath, [join(clean, 'scripts/plugin-dev.mjs'), 'create', sample, '--template', 'connector', '--sdk-tarball', join(sdkDirectory, tarballs[0])], {cwd: clean});
    const created = jsonLines(createOutput).at(-1);
    if (!created?.created || !(await exists(join(sample, 'mote-plugin.json')))) throw Error(`Packaged SDK sample was not created: ${JSON.stringify(created)}; output=${createOutput.slice(-1000)}`);
    runVisible('npm', ['run', 'build'], {cwd: sample, env: {...process.env, MOTE_REPOSITORY: clean}});
    const dev = jsonLines(run(process.execPath, [join(clean, 'scripts/plugin-dev.mjs'), 'dev', '--plugin', sample, '--home', join(temporary, 'sdk-home'), '--once', '--seed'], {cwd: clean}));
    const result = dev.at(-1);
    if (result?.stopped !== true) throw Error(`Packaged SDK sample did not stop its private Central: ${JSON.stringify(result)}`);
    if (result.connectors?.['example-external-source']?.ready !== true) throw Error(`Packaged SDK sample connector did not become ready: ${JSON.stringify(result.connectors)}`);
    if (!dev.some(value => value.itemCount === 1)) throw Error('Packaged SDK sample did not write its generated item');
    const stopped = run(process.execPath, [cli, 'stop', '--profile', 'distcheck', '--home', home], {cwd: clean});
    started = false;
    return {health, features: manifest.features.length, packages: manifest.packages.length, noteId: note.id, sdk: result.package ?? sample, stopped: jsonLines(stopped).at(-1)?.stopped ?? true};
  } finally {
    if (started) {
      try { run(process.execPath, [join(clean, 'scripts/mote.mjs'), 'stop', '--profile', 'distcheck', '--home', home], {cwd: clean}); } catch { /* best effort after a failed clean run */ }
    }
    await rm(temporary, {recursive: true, force: true});
  }
}
async function packageSdk(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  runVisible('npm', ['run', 'pack:sdk', '-w', '@mote/plugin-sdk', '--', '--pack-destination', directory]);
  const tarballs = (await readdir(directory)).filter(name => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw Error('SDK pack must produce exactly one tarball');
  return join(directory, tarballs[0]);
}
async function npmProductionClosure() {
  const args = ['ls', '--omit=dev', '--all', '--parseable', '--workspace', '@mote/server', '--workspace', '@mote/agent', '--workspace', '@mote/shared', '--workspace', '@mote/plugin-api', '--workspace', '@mote/plugin-host'];
  const result = spawnSync('npm', args, {cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const output = String(result.stdout || '');
  if (!output.trim()) throw Error(String(result.stderr || 'npm dependency closure failed').trim());
  const paths = new Set();
  for (const line of output.split(/\r?\n/)) {
    const marker = line.indexOf('/node_modules/');
    if (marker < 0) continue;
    const relativePath = line.slice(marker + 1);
    if (relativePath.startsWith('node_modules/@mote/') || relativePath.includes('/node_modules/.bin/')) continue;
    paths.add(relativePath);
  }
  return [...paths].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
}
async function copyWorkspaceModule(artifact, name, folder, extras = []) {
  const target = join(artifact, 'node_modules', ...name.split('/'));
  await rm(target, {recursive: true, force: true});
  await mkdir(target, {recursive: true});
  await cp(join(repository, folder, 'package.json'), join(target, 'package.json'));
  for (const extra of ['dist', ...extras]) await copyFileTree(join(repository, folder, extra), join(target, extra));
}
async function stageCentralDependencies(artifact) {
  for (const relativePath of await npmProductionClosure()) {
    const target = join(artifact, relativePath);
    if (await exists(target)) continue;
    const source = join(repository, relativePath);
    if (!(await exists(source))) continue;
    await copyTree(source, target);
  }
  for (const [name, folder, extras] of [
    ['@mote/plugin-api', 'packages/plugin-api', []],
    ['@mote/plugin-host', 'packages/plugin-host', []],
    ['@mote/plugin-sdk', 'packages/plugin-sdk', []],
    ['@mote/shared', 'packages/shared', []],
    ['@mote/agent', 'packages/agent', ['skills']],
  ]) await copyWorkspaceModule(artifact, name, folder, extras);
}
async function buildCentral(output, contract, protocol) {
  runVisible('npm', ['run', 'build', '-w', '@mote/server']);
  const directory = join(output, 'central');
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  for (const [source, target] of [
    ['package.json', 'package.json'],
    ['apps/server/package.json', 'apps/server/package.json'],
    ['apps/web/package.json', 'apps/web/package.json'],
    ['protocol/contract.json', 'protocol/contract.json'],
    ['packages/shared/src/config-file.ts', 'packages/shared/src/config-file.ts'],
    ['apps/server/src/log-retention-config.mjs', 'apps/server/src/log-retention-config.mjs'],
    ['apps/server/src/log-retention-config.d.mts', 'apps/server/src/log-retention-config.d.mts'],
    ['apps/server/src/connectors/cli-runtime.mjs', 'apps/server/src/connectors/cli-runtime.mjs'],
  ]) {
    const destination = join(directory, target);
    await mkdir(dirname(destination), {recursive: true});
    await cp(join(repository, source), destination);
  }
  await copyFileTree(join(repository, 'apps/server/dist'), join(directory, 'apps/server/dist'));
  await copyFileTree(join(repository, 'apps/web/dist'), join(directory, 'apps/web/dist'));
  await copyFileTree(join(repository, 'scripts'), join(directory, 'scripts'));
  await copyFileTree(join(repository, 'examples'), join(directory, 'examples'));
  await stageCentralDependencies(directory);
  const sdk = await packageSdk(join(directory, 'sdk'));
  const manifest = await centralManifest(contract, protocol);
  await writeJson(join(directory, 'plugin-distribution.json'), manifest);
  await writeJson(join(directory, 'apps/server/dist/plugin-distribution.json'), manifest);
  const readme = `# Mote packaged Central distribution\n\nBuilt from ${manifest.source.commit ?? 'unknown'}${manifest.source.dirty ? ' (dirty working tree)' : ''}.\n\nThis directory is a self-contained verification artifact. Start it with:\n\n\`\`\`sh\nnode scripts/mote.mjs init --profile distcheck --home /absolute/private-home\nnode scripts/mote.mjs start --profile distcheck --home /absolute/private-home\nnode scripts/mote.mjs token --profile distcheck --home /absolute/private-home\n\`\`\`\n\nThe packed SDK is \`/sdk/${basename(sdk)}\`. It is build evidence, not a published release.\n`;
  await writeFile(join(directory, 'README.md'), readme);
  return {directory, manifest};
}
async function buildWeb(output, contract, protocol) {
  runVisible('npm', ['run', 'build', '-w', '@mote/web']);
  const directory = join(output, 'web');
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  const manifest = await webManifest(contract, protocol, await sourceWebInventory());
  await copyFileTree(join(repository, 'apps/web/dist'), join(directory, 'dist'));
  await writeJson(join(directory, 'dist/plugin-distribution.json'), manifest);
  await writeJson(join(directory, 'plugin-distribution.json'), manifest);
  return {directory, manifest};
}
async function buildMac(output, contract, protocol, packageApp) {
  runVisible('npm', ['run', 'build', '-w', '@mote/desktop']);
  const directory = join(output, 'mac');
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  const manifest = await macManifest(contract, protocol, await sourceDesktopInventory());
  await writeJson(join(repository, 'apps/desktop/dist/plugin-distribution.json'), manifest);
  await copyFileTree(join(repository, 'apps/desktop/dist'), join(directory, 'dist'));
  await writeJson(join(directory, 'plugin-distribution.json'), manifest);
  if (packageApp) {
    const packageJson = await readJson(join(repository, 'apps/desktop/package.json'));
    const productName = packageJson.build?.productName;
    if (!productName) throw Error('Desktop package has no productName');
    runVisible(join(repository, 'node_modules/.bin/electron-builder'), ['--dir', `--${process.arch}`], {cwd: join(repository, 'apps/desktop'), env: {...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false'}});
    const app = join(repository, 'apps/desktop/release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', `${productName}.app`);
    if (!(await exists(app))) throw Error('Mac packaging did not produce the expected application');
    const asar = join(app, 'Contents/Resources/app.asar');
    const listing = run(process.execPath, [join(repository, 'node_modules/@electron/asar/bin/asar.js'), 'list', asar]);
    if (!listing.split(/\r?\n/).includes('/dist/plugin-distribution.json')) throw Error('Packaged Mac application does not carry the default distribution descriptor');
    await copyTree(app, join(directory, `${productName}.app`));
  }
  return {directory, manifest};
}
async function buildAndroid(output, contract, protocol) {
  const directory = join(output, 'android');
  await rm(directory, {recursive: true, force: true});
  await mkdir(directory, {recursive: true});
  const inventory = await sourceAndroidInventory();
  const manifest = await androidManifest(contract, protocol, inventory);
  const tools = await androidTools();
  const descriptor = join(repository, 'apps/android/app/src/main/assets/plugin-distribution.json');
  const previous = await exists(descriptor) ? await readFile(descriptor) : undefined;
  try {
    await mkdir(dirname(descriptor), {recursive: true});
    await writeJson(descriptor, manifest);
    runVisible(join(repository, 'apps/android/gradlew'), ['-p', join(repository, 'apps/android'), '--no-daemon', ':app:assembleDevelopment'], {cwd: repository, env: tools.env});
    const apk = join(repository, 'apps/android/app/build/outputs/apk/development/app-development.apk');
    if (!(await exists(apk))) throw Error('Android build did not produce app-development.apk');
    const entries = run('unzip', ['-l', apk]);
    if (!entries.includes('assets/plugin-distribution.json')) throw Error('Android APK does not carry the default distribution descriptor');
    await cp(apk, join(directory, 'app-development.apk'));
  } finally {
    if (previous === undefined) await rm(descriptor, {force: true});
    else await writeFile(descriptor, previous);
  }
  await writeJson(join(directory, 'plugin-distribution.json'), manifest);
  return {directory, manifest};
}
async function loadArtifacts(output) {
  const values = {};
  for (const product of products) {
    const directory = join(output, product);
    const manifestPath = join(directory, 'plugin-distribution.json');
    if (await exists(manifestPath)) values[product] = {directory, manifest: await readJson(manifestPath)};
  }
  return values;
}
async function verifyArtifacts(output) {
  const artifacts = await loadArtifacts(output);
  if (!artifacts.central) throw Error('Central distribution artifact is missing; run build first');
  const summary = {};
  summary.central = await verifyBuiltCentral(artifacts.central.directory, artifacts.central.manifest);
  if (artifacts.web) summary.web = await verifyBuiltWeb(artifacts.web.directory, artifacts.web.manifest);
  if (artifacts.mac) summary.mac = await verifyBuiltMac(artifacts.mac.directory, artifacts.mac.manifest);
  if (artifacts.android) summary.android = await verifyBuiltAndroid(artifacts.android.directory, artifacts.android.manifest);
  const clients = [artifacts.web, artifacts.mac, artifacts.android].filter(Boolean);
  summary.compatibility = await verifyCompatibility(artifacts.central.directory, clients.map(value => value.manifest));
  return {artifacts, summary};
}
async function main() {
  const {values, positionals} = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: {
      out: {type: 'string'}, products: {type: 'string'},
      'clean-run': {type: 'boolean'}, 'package-mac': {type: 'boolean'}, 'require-all-products': {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
  });
  if (values.help) {
    console.info(`Mote default plugin distribution (manual build verification)

  node scripts/plugin-distribution.mjs build [--out DIR] [--products central,web,mac,android] [--package-mac]
  node scripts/plugin-distribution.mjs verify [--out DIR]
  node scripts/plugin-distribution.mjs clean-run [--out DIR]
  node scripts/plugin-distribution.mjs all [--out DIR] [--package-mac] [--clean-run]

build writes self-contained artifacts under artifacts/plugin-distribution by
default and never publishes them. verify checks the default composition and
dependency descriptors and deliberately rejects a client whose plugin contract
version differs. clean-run copies the Central artifact to a temporary directory,
starts it from a private generated profile, checks the full default feature
inventory plus a generated note readback, then installs and runs an SDK sample
from the packed SDK tarball. Android build verification requires a JDK and SDK;
Mac packaging additionally needs macOS.`);
    return;
  }
  const command = positionals[0] ?? 'all';
  const output = resolve(values.out ?? defaultOutput);
  const selected = values.products ? values.products.split(',').map(value => value.trim()).filter(Boolean) : products;
  for (const product of selected) if (!products.includes(product)) throw Error(`Unknown product ${product}`);
  const contract = await pluginContract();
  const protocol = await protocolContract();
  if (command === 'build' || command === 'all') {
    await mkdir(output, {recursive: true});
    runVisible('npm', ['run', 'build:libs']);
    const built = [];
    if (selected.includes('central') || selected.includes('web')) {
      const web = await buildWeb(output, contract, protocol);
      const central = await buildCentral(output, contract, protocol);
      built.push(central.manifest.product, web.manifest.product);
    }
    if (selected.includes('mac')) built.push((await buildMac(output, contract, protocol, values['package-mac'] === true)).manifest.product);
    if (selected.includes('android')) {
      try { built.push((await buildAndroid(output, contract, protocol)).manifest.product); }
      catch (error) {
        if (values['require-all-products']) throw error;
        report('distribution.product_skipped', {product: 'android', reason: error.message.split('\n')[0]});
      }
    }
    report('distribution.built', {output, products: [...new Set(built)]});
  }
  if (command === 'verify' || command === 'all') {
    const {summary} = await verifyArtifacts(output);
    report('distribution.verified', summary);
  }
  if (command === 'clean-run' || command === 'all' || values['clean-run']) {
    const {artifacts} = await verifyArtifacts(output);
    const result = await cleanRun(artifacts.central.directory, artifacts.central.manifest);
    report('distribution.clean_run', result);
  }
}
main().catch(error => { console.error(`Mote plugin distribution: ${error.message}`); process.exitCode = 1; });
