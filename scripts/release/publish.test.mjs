import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { releaseFixture, fixtureAsset } from './fixtures.mjs';

function fakeGitHub(fixture, asset) {
  // Local CLI fixture only: no tokens, network, tags or real GitHub releases.
  const binary = join(fixture.root, 'bin/gh'), state = join(fixture.root, 'github-fixture.json'), log = join(fixture.root, 'github-calls.jsonl');
  fixture.write('bin/gh', `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nconst args=process.argv.slice(2),state=process.env.FIXTURE_GITHUB_STATE;\nfs.appendFileSync(process.env.FIXTURE_GITHUB_LOG,JSON.stringify(args)+'\\n');\nconst current=fs.existsSync(state)?JSON.parse(fs.readFileSync(state,'utf8')):undefined;\nif(args[1]==='view'){if(!current)process.exit(1);process.stdout.write(JSON.stringify(args.at(-1)==='isDraft'?{isDraft:current.isDraft}:{assets:current.assets}));}\nelse if(args[1]==='create')fs.writeFileSync(state,JSON.stringify({isDraft:true,assets:[]}));\nelse if(args[1]==='upload'){current.assets=args.slice(args.indexOf('--clobber')+1).map(file=>({name:path.basename(file),size:fs.statSync(file).size}));fs.writeFileSync(state,JSON.stringify(current));}\nelse if(args[1]==='edit'){current.isDraft=false;fs.writeFileSync(state,JSON.stringify(current));}\nelse process.exit(2);\n`);
  chmodSync(binary, 0o755);
  return { state, log, env: { ...process.env, PATH: join(fixture.root, 'bin') + delimiter + process.env.PATH, MOTE_RELEASE_OUTPUT: asset.directory, GITHUB_REF: `refs/tags/${asset.release.tag}`, GITHUB_REPOSITORY: fixture.policy.repository, FIXTURE_GITHUB_STATE: state, FIXTURE_GITHUB_LOG: log } };
}
for (const component of ['central', 'desktop', 'android']) {
  test(`${component} publication creates its own DEV prerelease with only one expected attachment`, t => {
    const fixture = releaseFixture(t), asset = fixtureAsset(fixture, component), github = fakeGitHub(fixture, asset);
    const output = execFileSync(process.execPath, [new URL('./publish.mjs', import.meta.url).pathname, component], { cwd: fixture.root, env: github.env, encoding: 'utf8' });
    assert.equal(JSON.parse(output).published, asset.release.tag);
    const remote = JSON.parse(readFileSync(github.state, 'utf8'));
    assert.equal(remote.isDraft, false); assert.deepEqual(remote.assets.map(a => a.name), [asset.name]);
    const calls = readFileSync(github.log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), create = calls.find(args => args[1] === 'create');
    assert.ok(create.includes('--verify-tag')); assert.ok(create.includes('--prerelease'));
    assert.equal(create.at(-1), join(fixture.root, asset.release.notes));
    const repeat = spawnSync(process.execPath, [new URL('./publish.mjs', import.meta.url).pathname, component], { cwd: fixture.root, env: github.env, encoding: 'utf8' });
    assert.notEqual(repeat.status, 0); assert.match(repeat.stderr, /Published versions are immutable/);
  });
}
test('publication rejects a different group tag before invoking GitHub', t => {
  const fixture = releaseFixture(t), asset = fixtureAsset(fixture, 'desktop'), github = fakeGitHub(fixture, asset);
  const result = spawnSync(process.execPath, [new URL('./publish.mjs', import.meta.url).pathname, 'desktop'], { cwd: fixture.root, env: { ...github.env, GITHUB_REF: 'refs/tags/android-v2.5.0' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exact component version tag/);
  assert.throws(() => readFileSync(github.log), /ENOENT/);
});
