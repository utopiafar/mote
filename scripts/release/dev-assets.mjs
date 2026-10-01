import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export function verifiedReleaseAssets(directory,release,policy) {
const {component,version,tag,assetComponent}=release;
if(!['central','desktop','android'].includes(component))throw Error('Choose a supported release component');
// Verification metadata stays in CI. Each public stream contains only its own DEV installer/source archive.
const escapedVersion=version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const pattern=component==='central'?`^mote-server-${escapedVersion}\\.tar\\.gz$`:component==='desktop'?`^mote-desktop-macos-dev-(?:arm64|x64)-${escapedVersion}\\.zip$`:`^mote-android-dev-arm64-${escapedVersion}\\.apk$`;
const names=readdirSync(directory).filter(name=>/\.(?:zip|apk|tar\.gz)$/.test(name));
if(names.length!==1||!new RegExp(pattern).test(names[0]))throw Error(`Expected exactly one ${component} DEV installer/source archive and no other component attachments`);
for(const name of names){
  const metadata=JSON.parse(readFileSync(join(directory,name+'.asset.json'),'utf8'));
  const file=readFileSync(join(directory,name));
  if(metadata.name!==name||metadata.size!==file.length||metadata.sha256!==createHash('sha256').update(file).digest('hex'))throw Error('Installer changed after verification');
  if(metadata.component!==assetComponent||metadata.url!==`https://github.com/${policy.repository}/releases/download/${tag}/${name}`)throw Error('Unexpected release component or version identity');
  const arch=component==='desktop'?/^mote-desktop-macos-dev-(arm64|x64)-/.exec(name)?.[1]:component==='android'?'arm64':'all';
  const platform=component==='central'?'source':component==='desktop'?'darwin':'android',format=component==='central'?'tar.gz':component==='desktop'?'zip':'apk';
  if(metadata.platform!==platform||metadata.arch!==arch||metadata.format!==format)throw Error('Unexpected release platform, architecture or format');
  if(name.endsWith('.apk')&&(metadata.packageName!=='dev.mote.collector.dev'||metadata.certificateSha256!==policy.androidCertificateSha256))throw Error('Unexpected Android identity');
  if(name.endsWith('.apk')&&metadata.versionCode!==release.versionCode)throw Error('Unexpected Android versionCode');
  if(name.endsWith('.zip')&&(metadata.bundleId!=='dev.mote.collector.dev'||!['adhoc','developer-id'].includes(metadata.signing)))throw Error('Unexpected Mac identity');
  if(name.endsWith('.zip')&&metadata.signing==='developer-id'&&!/^[A-Z0-9]{10}$/.test(metadata.teamId||''))throw Error('Unexpected Mac signing team');
}
return names;
}
export function verifiedDevInstallers(directory,release,policy) {
if(!['desktop','android'].includes(release.component))throw Error('Choose desktop or android DEV installers');
return verifiedReleaseAssets(directory,release,policy);
}
