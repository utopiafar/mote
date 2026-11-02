import {mkdtemp, readFile, writeFile, mkdir, cp, rm, lstat, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Raw workspace pack omits hoisted private dependencies. Keep all staging out
// of workspace node_modules, including failure paths and existing local links.
if (process.env.npm_lifecycle_event === 'prepack') {
  throw Error('Use npm run pack:sdk -- --pack-destination <directory> to bundle the private SDK dependencies');
}
const sdk = fileURLToPath(new URL('../', import.meta.url));
const origin = process.cwd(), args = [], input = process.argv.slice(2);
let destination;
for (let i = 0; i < input.length; i++) {
  const value = input[i];
  if (value === '--pack-destination') {
    if (!input[i + 1]) throw Error('Missing pack destination');
    destination = resolve(origin, input[++i]);
  } else if (value.startsWith('--pack-destination=')) {
    destination = resolve(origin, value.slice('--pack-destination='.length));
  } else if (['--json', '--dry-run', '--quiet'].includes(value)) args.push(value);
  else throw Error('Unsupported SDK pack argument: ' + value);
}
args.push('--pack-destination', destination ?? origin);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(commandArgs, cwd, env = process.env, output = 'inherit') {
  const result = spawnSync(npm, commandArgs, {cwd, env, stdio: ['ignore', output, 'inherit']});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('SDK pack command failed with status ' + result.status);
  return result.stdout;
}
async function regularTree(path) {
  const value = await lstat(path);
  if (value.isSymbolicLink() || !(value.isDirectory() || value.isFile())) throw Error('SDK bundle input must contain only regular files and directories');
  if (value.isDirectory()) for (const name of await readdir(path)) await regularTree(join(path, name));
}
async function copyPackage(source, target) {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await regularTree(join(source, 'dist'));
  await mkdir(target, {recursive: true});
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await cp(join(source, 'dist'), join(target, 'dist'), {recursive: true, force: false, errorOnExist: true});
  return manifest;
}
// Build diagnostics go to stderr; --json pack output remains machine readable.
run(['run', 'build'], sdk, process.env, 2);
const stage = await mkdtemp(join(tmpdir(), 'mote-plugin-sdk-pack-'));
try {
  const manifest = await copyPackage(sdk, stage);
  for (const name of ['plugin-api', 'plugin-host']) {
    const dependency = await copyPackage(resolve(sdk, '..', name), join(stage, 'node_modules', '@mote', name));
    if (dependency.name !== '@mote/' + name || manifest.dependencies[dependency.name] !== dependency.version) throw Error('SDK private dependency identity/version mismatch');
  }
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^npm_config_(workspace|workspaces|include_workspace_root)$/i.test(key)) delete env[key];
  const stdout = run(['pack', '--ignore-scripts', '--workspaces=false', ...args], stage, env, 'pipe');
  if (stdout) process.stdout.write(stdout);
} finally {
  await rm(stage, {recursive: true, force: true});
}
