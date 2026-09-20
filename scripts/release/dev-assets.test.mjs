import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedDevInstallers} from './dev-assets.mjs';
test('DEV publication includes only two verified installers and rejects missing, altered or wrong identities',t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-dev-release-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const version='0.0.57',policy={androidCertificateSha256:'fixture-cert'};
 const mac=`mote-desktop-macos-dev-arm64-${version}.zip`,android=`mote-android-dev-arm64-${version}.apk`;
 function add(name,identity){const bytes=Buffer.from('Generated fixture '+name);writeFileSync(join(dir,name),bytes);writeFileSync(join(dir,name+'.asset.json'),JSON.stringify({name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...identity}));}
 add(mac,{bundleId:'dev.mote.collector.dev'});
 assert.throws(()=>verifiedDevInstallers(dir,version,policy),/exactly/);
 add(android,{packageName:'dev.mote.collector.dev',certificateSha256:'fixture-cert'});
 for(const name of ['SHA256SUMS','mote-release.json',`mote-server-${version}.tar.gz`,`mote-android-arm64-${version}.apk`])writeFileSync(join(dir,name),'Not a public DEV installer');
 assert.deepEqual(verifiedDevInstallers(dir,version,policy).sort(),[mac,android].sort());
 writeFileSync(join(dir,mac),'corrupt');assert.throws(()=>verifiedDevInstallers(dir,version,policy),/changed/);
 add(mac,{bundleId:'dev.mote.collector'});assert.throws(()=>verifiedDevInstallers(dir,version,policy),/identity/);
});
