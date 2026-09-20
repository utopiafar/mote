import {readFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {verifiedDevInstallers} from './dev-assets.mjs';
const directory=resolve(process.env.MOTE_RELEASE_OUTPUT||'artifacts/release');
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const policy=JSON.parse(readFileSync('release/signing-policy.json','utf8'));
const repo=policy.repository,tag=`v${version}`;
const names=verifiedDevInstallers(directory,version,policy);
const existing=spawnSync('gh',['release','view',tag,'--repo',repo,'--json','isDraft'],{encoding:'utf8'});
if(existing.status===0&&!JSON.parse(existing.stdout).isDraft)throw Error('Published versions are immutable; create a new version');
const notes=resolve(`release/notes/${version}.md`);readFileSync(notes);
if(existing.status!==0)execFileSync('gh',['release','create',tag,'--repo',repo,'--verify-tag','--draft','--prerelease','--title',`Mote ${version} DEV`,'--notes-file',notes],{stdio:'inherit'});
execFileSync('gh',['release','upload',tag,'--repo',repo,'--clobber',...names.map(n=>join(directory,n))],{stdio:'inherit'});
const remote=JSON.parse(execFileSync('gh',['release','view',tag,'--repo',repo,'--json','assets'],{encoding:'utf8'}));
if(remote.assets.length!==2)throw Error('Release contains unexpected attachments');
for(const name of names){if(!remote.assets.some(a=>a.name===name&&a.size===statSync(join(directory,name)).size))throw Error('Uploaded installer is incomplete');}
execFileSync('gh',['release','edit',tag,'--repo',repo,'--draft=false','--prerelease','--latest=false'],{stdio:'inherit'});
console.log(JSON.stringify({published:tag,assets:names,url:`https://github.com/${repo}/releases/tag/${tag}`}));
