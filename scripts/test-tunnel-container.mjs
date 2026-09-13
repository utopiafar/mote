#!/usr/bin/env node
// Real pinned cloudflared, network disabled and invalid synthetic credentials only.
// Separate labelled Node containers test removal; they do not simulate a connected tunnel.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialize, profilePaths, loadProfile, composeEnvironment, composeArgs, execute } from './profile-lib.mjs';
import { CLOUDFLARED_IMAGE, tunnelTokenPath, dockerTunnelUser } from './tunnel-lib.mjs';
import { cli, command } from './profile-fixtures.mjs';
const directory=await mkdtemp(join(tmpdir(),'mote-tunnel-compose-fixture-')), home=join(directory,'profiles');
const source=join(directory,'synthetic-private-token'), synthetic='synthetic-invalid-token-'+randomUUID().replaceAll('-','');
const containers=new Set(); let p, available=false;
const noSecret=value=>assert.equal(String(value).includes(synthetic),false,'Credential must not appear in process output');
async function docker(args,options={}) {
  const result=await command('docker',args,{timeoutMs:120000,...options}); noSecret(result.stdout);noSecret(result.stderr);
  assert.equal(result.code,0,`Docker fixture ${args[0]} failed; raw output suppressed`);return result.stdout.trim();
}
try {
  await docker(['version','--format','{{.Server.Version}}']);available=true;
  await initialize(profilePaths('test',home),{runtime:'docker',image:'node:24-bookworm-slim'});
  await writeFile(source,synthetic+'\n',{mode:0o600});
  await cli(home,'test','tunnel',['--enable','--token-file',source,'--public-url','https://synthetic.invalid']);
  p=await loadProfile(profilePaths('test',home));
  p.tunnelUser=await dockerTunnelUser(p,execute);assert.equal((await stat(tunnelTokenPath(p))).mode&0o777,0o600);
  // Generate raw central env/config using the real CLI; cloudflared receives no central env_file.
  const config=JSON.parse((await cli(home,'test','compose',['--','config','--format','json'])).stdout);
  assert.equal(config.services.cloudflared.image,CLOUDFLARED_IMAGE);
  assert.equal(config.services.cloudflared.logging.driver,'none');
  assert.equal(config.services.cloudflared.command.includes('--token'),false);
  assert.equal(config.services.cloudflared.command.includes('--token-file'),true);
  assert.equal(config.services.cloudflared.ports,undefined);
  assert.equal(Object.keys(config.services.cloudflared.environment||{}).length,0);
  assert.equal(config.secrets['cloudflared-token'].file,tunnelTokenPath(p));
  await docker(['pull',CLOUDFLARED_IMAGE],{timeoutMs:180000});
  const blocked=join(directory,'network-disabled.yaml');
  await writeFile(blocked,'services:\n  cloudflared:\n    network_mode: none\n    restart: "no"\n');
  // Compose's actual file-source secret and the fixed image must read mode 0600 as the selected UID.
  // The invalid token is rejected before connecting; network_mode:none additionally forbids egress.
  const args=[...composeArgs(p,[]),'-f',blocked,'run','--rm','--no-deps','cloudflared'];
  const invalid=await command('docker',args,{env:composeEnvironment(p),timeoutMs:60000});
  noSecret(invalid.stdout);noSecret(invalid.stderr);
  assert.notEqual(invalid.code,0,'Invalid synthetic token must be rejected');
  const output=invalid.stdout+invalid.stderr;
  assert.match(output,/Provided Tunnel token is not valid/);
  assert.doesNotMatch(output,/Failed to read token file/);
  console.info('[tunnel-compose] Real pinned image and Compose 0600 file-secret readability passed with networking disabled');

  await docker(['pull','node:24-bookworm-slim'],{timeoutMs:180000});
  async function fixture(project,service='cloudflared') {
    const id=await docker(['run','--detach','--network','none','--label',`com.docker.compose.project=${project}`,'--label',`com.docker.compose.service=${service}`,'node:24-bookworm-slim','node','-e','setInterval(()=>{},1000)']);containers.add(id);return id;
  }
  const owned=await fixture(p.project), unrelated=await fixture(p.project+'-other'), central=await fixture(p.project,'mote');
  // The credential can be missing during incident recovery. Stop/status must still be usable.
  await rm(tunnelTokenPath(p));
  await cli(home,'test','compose',['--','ps','--all','--format','json']);
  await cli(home,'test','stop');
  const disabled=JSON.parse((await cli(home,'test','tunnel',['--disable'])).stdout);assert.equal(disabled.removedSidecars,1);
  assert.notEqual((await command('docker',['inspect',owned])).code,0);containers.delete(owned);
  assert.equal(await docker(['inspect','--format','{{.State.Running}}',unrelated]),'true');
  await docker(['inspect','--format','{{.Id}}',central]);
  // A partly completed disable can leave a labelled orphan; repeating disable must remove it too.
  const orphan=await fixture(p.project);await cli(home,'test','tunnel',['--disable']);
  assert.notEqual((await command('docker',['inspect',orphan])).code,0);containers.delete(orphan);
  // Rotation replaces the mounted old inode only after the previous connector has stopped.
  await cli(home,'test','tunnel',['--enable','--token-file',source]);
  const oldConnector=await fixture(p.project);
  await cli(home,'test','tunnel',['--enable','--token-file',source,'--protocol','http2']);
  assert.notEqual((await command('docker',['inspect',oldConnector])).code,0);containers.delete(oldConnector);
  p=await loadProfile(profilePaths('test',home));assert.equal(p.meta.tunnel.protocol,'http2');assert.equal(p.meta.tunnel.enabled,true);
  assert.equal((await stat(tunnelTokenPath(p))).mode&0o777,0o600);
  assert.equal((await readFile(tunnelTokenPath(p),'utf8')).trim()===synthetic,true);
  await cli(home,'test','tunnel',['--disable']);
  console.info('[tunnel-compose] Exact labelled fixture removal, missing-token recovery, repeat disable and rotation passed');
  console.info('[tunnel-compose] No real Cloudflare connection, DNS change or account credential was used');
} finally {
  if(available) {
    for(const id of containers) await command('docker',['rm','--force',id]).catch(()=>undefined);
    if(p)await cli(home,'test','compose',['--','down','--remove-orphans']).catch(()=>undefined);
  }
  await rm(directory,{recursive:true,force:true});
}
