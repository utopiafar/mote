import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute=promisify(execFile);

/** Only a local APFS volume with an OS-provided UUID is used for rename matching.
 * Network mounts and unknown filesystems deliberately have no such guarantee. */
export async function localVolumeIdentity(path: string): Promise<string | undefined> {
  if(process.platform!=='darwin')return undefined;
  try {
    const options={timeout:3000,maxBuffer:256*1024,env:{...process.env,LC_ALL:'C'}};
    const {stdout:df}=await execute('/bin/df',['-P',path],options);
    const device=df.trim().split('\n').at(-1)?.trim().split(/\s+/)[0];
    if(!device || !/^\/dev\/disk\d+(?:s\d+)*$/.test(device))return undefined;
    const {stdout:plist}=await execute('/usr/sbin/diskutil',['info','-plist',device],options);
    const value=(key:string)=>plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
    const uuid=value('VolumeUUID');
    if(value('DeviceNode')!==device || value('FilesystemType')!=='apfs' || !uuid || !/^[0-9A-Fa-f-]{36}$/.test(uuid))return undefined;
    return 'apfs:'+uuid.toLowerCase();
  } catch { return undefined; }
}
