import {createHash} from 'node:crypto';

/** Only explicit provider Git metadata is eligible. Never inspect a path from transcript content. */
export function repositoryCandidate(remote:unknown):string|undefined {
  if(typeof remote!=='string'||remote.length>4000||/[\s\x00-\x1f]/.test(remote))return;
  // SCP and URL transports can identify the same candidate; this is not authorization or project identity.
  const scp=/^(?:[^/@:]+@)?([a-zA-Z0-9.-]+):([^/].*)$/.exec(remote);
  let url:URL;
  try {url=new URL(scp&&(remote.includes('@')||scp[1].includes('.'))&&!remote.includes('://')?`ssh://${scp[1]}/${scp[2]}`:remote);}catch{return;}
  if(!['https:','http:','ssh:','git:'].includes(url.protocol)||!url.hostname)return;
  const path=url.pathname.replace(/\/+$/,'').replace(/\.git$/,'');
  if(!path||path==='/')return;
  // Credentials, query strings and fragments are deliberately absent from both output and fingerprint.
  return createHash('sha256').update(JSON.stringify([url.hostname.toLowerCase(),url.port,path])).digest('hex');
}
