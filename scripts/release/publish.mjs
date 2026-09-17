import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {verifyReleaseEnvelope} from '../../packages/shared/dist/release.js';
const directory=resolve(process.env.MOTE_RELEASE_OUTPUT||'artifacts/release');
const manifest=verifyReleaseEnvelope(readFileSync(join(directory,'mote-release.json')));
const tag=manifest.tag,repo=manifest.repository;
const existing=spawnSync('gh',['release','view',tag,'--repo',repo,'--json','isDraft'],{encoding:'utf8'});
if(existing.status===0&&!JSON.parse(existing.stdout).isDraft)throw Error('Published versions are immutable; create a new version rather than replacing assets');
const notes=resolve(`release/notes/${manifest.version}.md`);readFileSync(notes);
if(existing.status!==0)execFileSync('gh',['release','create',tag,'--repo',repo,'--verify-tag','--draft','--title',`Mote ${manifest.version}`,'--notes-file',notes],{stdio:'inherit'});
const extras=readdirSync(directory).filter(n=>/^mote-desktop-macos-dev-(arm64|x64)-/.test(n)&&n.endsWith('.zip')).map(n=>join(directory,n));
const files=[...extras,...manifest.assets.map(a=>join(directory,a.name)),join(directory,'mote-release.json'),join(directory,'SHA256SUMS')];
execFileSync('gh',['release','upload',tag,'--repo',repo,'--clobber',...files],{stdio:'inherit'});
const remote=JSON.parse(execFileSync('gh',['release','view',tag,'--repo',repo,'--json','assets'],{encoding:'utf8'}));
for(const asset of manifest.assets){const actual=remote.assets.find(a=>a.name===asset.name);if(!actual||actual.size!==asset.size)throw Error('Uploaded asset is incomplete');}
for(const file of extras){const actual=remote.assets.find(a=>a.name===basename(file));if(!actual||actual.size!==statSync(file).size)throw Error('Uploaded development asset is incomplete');}
execFileSync('gh',['release','edit',tag,'--repo',repo,'--draft=false',...(manifest.channel==='preview'?['--prerelease']:['--latest'])],{stdio:'inherit'});
console.log(JSON.stringify({published:tag,assets:manifest.assets.length,url:manifest.notesUrl}));
