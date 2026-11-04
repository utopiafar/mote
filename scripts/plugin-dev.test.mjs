import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {initialize, profilePaths} from './profile-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'scripts/plugin-dev.mjs');
const run = (args, cwd = root) => execFileSync(process.execPath, [cli, ...args], {cwd, encoding: 'utf8', stdio: 'pipe'});

test('create copies the source template without scanning a vault or configuring credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-create-'));
  try {
    const created = JSON.parse(run(['create', join(directory, 'plugin')]));
    assert.equal(created.created, join(directory, 'plugin'));
    for (const file of ['plugin.mjs', 'source.mjs', 'seed.mjs', 'mote-plugin.json', 'scripts/pack.mjs', 'package.json', 'README.md']) assert.ok(readFileSync(join(directory, 'plugin', file)));
    assert.doesNotMatch(readFileSync(join(directory, 'plugin', 'source.mjs'), 'utf8'), /apps\/|apps\\|@mote\/shared/);
    assert.match(readFileSync(join(directory, 'plugin', 'README.md'), 'utf8'), /plugin-dev dev/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('create copies each runnable template and rejects an unknown template', () => {
  const expected = {
    connector: ['plugin.mjs', 'source.mjs', 'seed.mjs', 'mote-plugin.json', 'scripts/pack.mjs', 'package.json', 'README.md'],
    worker: ['main.mjs', 'mote-plugin.json', 'scripts/pack.mjs', 'package.json', 'README.md'],
    domain: ['plugin.mjs', 'domain.mjs', 'port.mjs', 'source.mjs', 'seed.mjs', 'mote-plugin.json', 'web/index.html', 'scripts/pack.mjs', 'package.json', 'README.md'],
  };
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-templates-'));
  try {
    for (const [template, files] of Object.entries(expected)) {
      const target = join(directory, template);
      const created = JSON.parse(run(['create', target, '--template', template]));
      assert.equal(created.template, template);
      for (const file of files) assert.ok(readFileSync(join(target, file)), `${template}/${file}`);
      for (const file of files.filter(name => name.endsWith('.mjs') || name === 'package.json'))
        assert.doesNotMatch(readFileSync(join(target, file), 'utf8'), /apps\/|apps\\|@mote\/shared/, `${template}/${file} imports only the public SDK`);
    }
    assert.throws(() => run(['create', join(directory, 'bad'), '--template', 'bogus']), /Unknown template/);
    assert.throws(() => readFileSync(join(directory, 'bad', 'package.json'), 'utf8'), /ENOENT/, 'a rejected template leaves no project behind');
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('an existing non-plugin-dev profile is rejected without changing its configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-ordinary-'));
  try {
    const home = join(directory, 'home');
    const paths = profilePaths('plugin-dev', home);
    await initialize(paths, {port: 47861, runtime: 'native'});
    const before = readFileSync(paths.configFile, 'utf8');
    assert.throws(() => run(['dev', '--plugin', join(root, 'examples/external-plugin'), '--home', home, '--once']), /not created by plugin-dev/);
    assert.equal(readFileSync(paths.configFile, 'utf8'), before);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('missing SDK and unsupported hosts fail before a private profile is created', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-dev-failure-'));
  try {
    const plugin = join(directory, 'plugin');
    run(['create', plugin]);
    assert.throws(() => run(['dev', '--plugin', plugin, '--home', join(directory, 'home'), '--once']), /Missing @mote\/plugin-sdk/);
    assert.throws(() => run(['dev', '--plugin', plugin, '--host', 'web', '--home', join(directory, 'home'), '--once']), /only central/);
    let profile;
    try { profile = readFileSync(join(directory, 'home', 'plugin-dev', 'mote.yaml'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(profile, undefined);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
