import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {verifiedReleaseAssets} from './dev-assets.mjs';
import {releaseFixture,fixtureAsset} from './fixtures.mjs';
for(const component of ['central','desktop','android']) {
 test(`${component} publication verifies only its own package and rejects altered files or URLs`,t=>{
  const fixture=releaseFixture(t),asset=fixtureAsset(fixture,component),verify=()=>verifiedReleaseAssets(asset.directory,asset.release,fixture.policy);
  assert.deepEqual(verify(),[asset.name]);
  for(const name of ['SHA256SUMS','mote-release.json'])writeFileSync(join(asset.directory,name),'Generated metadata fixture');
  assert.deepEqual(verify(),[asset.name]);
  fixtureAsset(fixture,component,{url:`https://github.com/fixture/mote/releases/download/v${asset.release.version}/${asset.name}`});
  assert.throws(verify,/component or version/);
  fixtureAsset(fixture,component);
  writeFileSync(join(asset.directory,asset.name),'altered fixture');assert.throws(verify,/changed/);
 });
 test(`${component} publication rejects attachments from other components`,t=>{
  const fixture=releaseFixture(t),asset=fixtureAsset(fixture,component);
  fixtureAsset(fixture,component==='central'?'desktop':'central');
  assert.throws(()=>verifiedReleaseAssets(asset.directory,asset.release,fixture.policy),/exactly one/);
 });
 test(`${component} publication rejects mismatched metadata platform, architecture and format`,t=>{
  const fixture=releaseFixture(t),asset=fixtureAsset(fixture,component),verify=()=>verifiedReleaseAssets(asset.directory,asset.release,fixture.policy);
  for(const overrides of [{platform:'invalid'},{arch:'invalid'},{format:'invalid'}]) {
   fixtureAsset(fixture,component,overrides);assert.throws(verify,/platform, architecture or format/);
  }
 });
}
test('DEV installers reject production application identities and wrong Android code/certificates',t=>{
 const fixture=releaseFixture(t),android=fixtureAsset(fixture,'android',{packageName:'dev.mote.collector'}),verify=()=>verifiedReleaseAssets(android.directory,android.release,fixture.policy);
 assert.throws(verify,/Android identity/);
 fixtureAsset(fixture,'android',{versionCode:88});assert.throws(verify,/versionCode/);
 fixtureAsset(fixture,'android',{certificateSha256:'different-fixture-cert'});assert.throws(verify,/Android identity/);
 const macFixture=releaseFixture(t),mac=fixtureAsset(macFixture,'desktop',{bundleId:'dev.mote.collector'});
 assert.throws(()=>verifiedReleaseAssets(mac.directory,mac.release,macFixture.policy),/Mac identity/);
 fixtureAsset(macFixture,'desktop',{signing:'developer-id'});
 assert.throws(()=>verifiedReleaseAssets(mac.directory,mac.release,macFixture.policy),/signing team/);
 fixtureAsset(macFixture,'desktop',{signing:'developer-id',teamId:'FIXTURE12'});
 assert.throws(()=>verifiedReleaseAssets(mac.directory,mac.release,macFixture.policy),/signing team/);
 fixtureAsset(macFixture,'desktop',{signing:'developer-id',teamId:'FIXTURE123'});
 assert.deepEqual(verifiedReleaseAssets(mac.directory,mac.release,macFixture.policy),[mac.name]);
});
