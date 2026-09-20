import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export function verifiedDevInstallers(directory,version,policy) {
// Verification metadata stays in CI. Public releases contain exactly two DEV installers.
const names=readdirSync(directory).filter(name=>new RegExp(`^mote-(?:desktop-macos-dev-(?:arm64|x64)-${version.replaceAll('.','\\.') }\\.zip|android-dev-arm64-${version.replaceAll('.','\\.')}\\.apk)$`).test(name));
if(names.length!==2||!names.some(n=>n.endsWith('.zip'))||!names.some(n=>n.endsWith('.apk')))throw Error('Expected exactly one Mac DEV and one Android DEV installer');
for(const name of names){
  const metadata=JSON.parse(readFileSync(join(directory,name+'.asset.json'),'utf8'));
  const file=readFileSync(join(directory,name));
  if(metadata.name!==name||metadata.size!==file.length||metadata.sha256!==createHash('sha256').update(file).digest('hex'))throw Error('Installer changed after verification');
  if(name.endsWith('.apk')&&(metadata.packageName!=='dev.mote.collector.dev'||metadata.certificateSha256!==policy.androidCertificateSha256))throw Error('Unexpected Android identity');
  if(name.endsWith('.zip')&&metadata.bundleId!=='dev.mote.collector.dev')throw Error('Unexpected Mac identity');
}
return names;
}
