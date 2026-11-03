import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {architectureViolations} from '../../../scripts/ci/architecture.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(packageRoot, '../..');
const read = path => readFileSync(join(packageRoot, path), 'utf8');
const run = (command, args, cwd) => execFileSync(command, args, {cwd, encoding: 'utf8', stdio: 'pipe'});

test('the SDK declares separate node/browser entries and no private app export', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.name, '@mote/plugin-sdk');
  for (const entry of ['.', './browser', './node']) assert.ok(manifest.exports[entry], entry);
  assert.equal(manifest.exports['.'].browser.import, './dist/browser.js');
  assert.equal(manifest.exports['.'].browser.types, './dist/browser.d.ts');
  assert.equal(manifest.exports['.'].types, './dist/browser.d.ts');
  assert.equal(manifest.exports['./browser'].import, './dist/browser.js');
  assert.equal(manifest.exports['./node'].import, './dist/node.js');
  assert.doesNotMatch(read('dist/browser.d.ts'), /planComposition/);
  assert.ok(!JSON.stringify(manifest.exports).includes('apps/'));
  const browser = read('dist/browser.js');
  assert.doesNotMatch(browser, /@mote\/plugin-host|node:|from ['"](?:node:)?(?:fs|path|child_process)['"]/);
  const node = read('dist/node.js');
  assert.match(node, /@mote\/plugin-host/);
});

test('a private app import is rejected by the SDK architecture boundary', () => {
  const from = 'packages/plugin-sdk/src/generated-private.ts';
  const result = architectureViolations({
    nodes: new Map([[from, [{specifier: '@mote/server', kind: 'runtime', from, to: 'apps/server/src/index.ts', line: 1}]]]),
    browserEntries: [],
    unresolved: [],
  });
  assert.ok(result.some(issue => issue.rule === 'sdk-public-boundary' && issue.from === from));
});

test('an external project consumes the packed SDK tarball and browser bundle without private paths', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'mote-plugin-sdk-external-'));
  t.after(() => execFileSync('rm', ['-rf', temporary]));
  const packed = JSON.parse(run(process.execPath, [join(packageRoot, 'scripts/pack.mjs'), '--json', '--pack-destination', temporary], packageRoot));
  const tarball = join(temporary, String(packed[0].filename));
  const external = join(temporary, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'package.json'), JSON.stringify({
    private: true, type: 'module', dependencies: {'@mote/plugin-sdk': `file:${tarball}`},
  }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], external);

  writeFileSync(join(external, 'consumer.ts'), `
import { packageManifestSchema, PLUGIN_SDK_VERSION, StateError, type StateStore } from '@mote/plugin-sdk';
import { planComposition } from '@mote/plugin-sdk/node';
const manifest = packageManifestSchema.parse({
  schemaVersion: 1, id: 'external.fixture', name: 'External fixture', version: '1.0.0', runtime: 'worker',
  entry: 'main.mjs', archive: {asset: 'fixture.zip', sha256: 'a'.repeat(64)},
  contributions: [{id: 'external.page', version: '1', surface: 'page', runtime: 'host', entry: 'page.html'}],
  capabilities: [], configuration: [], dependencies: [], access: ['generated external fixture'],
});
const plan = planComposition({revision: 1, host: 'central', packages: [manifest]});
const state = undefined as StateStore | undefined;
if (state) void state.get('host-bound-key');
const stateError: StateError = new StateError('invalid_namespace');
if (!plan.ok || PLUGIN_SDK_VERSION !== '0.1.0' || stateError.code !== 'invalid_namespace') throw new Error('external SDK consumer failed');
console.log(plan.plan.contributions[0]?.address.contributionId);
`);
  writeFileSync(join(external, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist', skipLibCheck: true},
    include: ['consumer.ts'],
  }));
  run(join(root, 'node_modules/.bin/tsc'), ['-p', external], external);
  const output = run(process.execPath, ['dist/consumer.js'], external);
  assert.equal(output.trim(), 'external.page');

  const browserTsc = ['--noEmit', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler'];
  writeFileSync(join(external, 'browser-consumer.ts'), "import {packageManifestSchema} from '@mote/plugin-sdk'; console.log(typeof packageManifestSchema.parse);");
  run(join(root, 'node_modules/.bin/tsc'), [...browserTsc, 'browser-consumer.ts'], external);
  writeFileSync(join(external, 'browser-host.ts'), "import {planComposition} from '@mote/plugin-sdk'; console.log(typeof planComposition);");
  let browserHostFailure;
  try { run(join(root, 'node_modules/.bin/tsc'), [...browserTsc, 'browser-host.ts'], external); } catch (error) { browserHostFailure = error; }
  assert.ok(browserHostFailure);
  assert.match(String(browserHostFailure.stdout || browserHostFailure.stderr), /no exported member|TS2305/);

  const {build} = await import('esbuild');
  const bundled = await build({
    stdin: {contents: "import {packageManifestSchema} from '@mote/plugin-sdk'; console.log(typeof packageManifestSchema.parse);", resolveDir: external, sourcefile: 'browser.ts'},
    bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
  });
  const browserOutput = bundled.outputFiles[0].text;
  assert.doesNotMatch(browserOutput, /node:|from ['"](?:node:)?(?:fs|path|child_process)['"]|planComposition/);
  assert.ok(!browserOutput.includes(root));
  assert.ok(!browserOutput.includes('MOTE_TOKEN'));
});
