import {readFileSync,rmSync} from 'node:fs';
import {mkdir,writeFile,chmod,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {CHROME_EXTENSION_ID,CHROME_NATIVE_HOST} from './chrome-constants';
export {CHROME_EXTENSION_ID,CHROME_NATIVE_HOST};
const nativeMessagingDirectory=(homeDirectory?:string)=>join(homeDirectory??homedir(),'Library','Application Support','Google','Chrome','NativeMessagingHosts');
const launcherPath=(profileDirectory:string)=>join(resolve(profileDirectory),'chrome-native-host.sh');
export function chromeNativeHostManifestPath(homeDirectory?:string):string{return join(nativeMessagingDirectory(homeDirectory),`${CHROME_NATIVE_HOST}.json`);}
export async function registerChromeNativeHost(options:{profileDirectory:string;extensionDirectory:string;electronExecutable:string;nativeHostScript:string;homeDirectory?:string}):Promise<{extensionId:string;extensionDirectory:string;manifestPath:string}>{
  const profile=resolve(options.profileDirectory);await mkdir(profile,{recursive:true,mode:0o700});const stat=await lstat(profile);if(stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw Error('Untrusted profile directory');await chmod(profile,0o700);
  const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
  const launcher=launcherPath(profile);
  await writeFile(launcher,`#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport MOTE_CHROME_BRIDGE_DESCRIPTOR=${quote(join(profile,'chrome-bridge.json'))}\nexec ${quote(resolve(options.electronExecutable))} ${quote(resolve(options.nativeHostScript))} "$@"\n`,{mode:0o700});await chmod(launcher,0o700);
  const directory=nativeMessagingDirectory(options.homeDirectory);await mkdir(directory,{recursive:true,mode:0o700});
  const manifestPath=chromeNativeHostManifestPath(options.homeDirectory);await writeFile(manifestPath,JSON.stringify({name:CHROME_NATIVE_HOST,description:'Mote visible context relay',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${CHROME_EXTENSION_ID}/`]},null,2)+'\n',{mode:0o600});
  return {extensionId:CHROME_EXTENSION_ID,extensionDirectory:resolve(options.extensionDirectory),manifestPath};
}
/** Unregisters only the manifest that points at this profile's launcher. */
export function unregisterChromeNativeHost(options:{profileDirectory:string;homeDirectory?:string}):boolean{
  const manifestPath=chromeNativeHostManifestPath(options.homeDirectory);
  let manifest:{name?:unknown;path?:unknown};
  try{manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as {name?:unknown;path?:unknown};}catch{return false;}
  if(manifest.name!==CHROME_NATIVE_HOST||typeof manifest.path!=='string'||resolve(manifest.path)!==launcherPath(options.profileDirectory))return false;
  rmSync(manifestPath,{force:true});
  return true;
}
