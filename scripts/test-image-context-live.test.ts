/** Generated manifest guards only: no source vault, image, provider or private plan is opened. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

const output=process.env.MOTE_IMAGE_REUSE_TEST_OUTPUT?resolve(process.env.MOTE_IMAGE_REUSE_TEST_OUTPUT):await mkdtemp(join(tmpdir(),'mote-generated-image-reuse-'));
await mkdir(output,{recursive:true});
const outcomes:Array<Record<string,unknown>>=[];
for(const protocol of [undefined,'bounded-views'] as const){
 for(const [name,mode,privateData,switches,expected] of [
  ['private-access','preflight',true,{},'Private source access requires'],
  ['live-admission','live',false,{},'Live requires explicit authorization'],
  ['private-consent','live',true,{MOTE_IMAGE_CONTEXT_LIVE_AUTHORIZED:'1',MOTE_PRIVATE_IMAGE_ACCESS:'1'},'Private image transmission requires explicit user consent'],
 ] as const)test(`${protocol??'default-one-original'} preserves ${name} before source access`,async()=>{
  const key=(protocol??'default')+'-'+name,path=join(output,key+'.manifest.json'),destination=join(output,key+'-output');
  const manifest={sourceRun:join(output,'nonexistent-generated-source'),output:destination,personalDataUsed:privateData,...(protocol?{imageDisclosureProtocol:protocol}:{}),imageSha256:'0'.repeat(64),captionBodySha256:'0'.repeat(64),question:'Generated transport guard.',maximumQueries:1,queryTimeoutMs:300000,model:'gpt-6-sol',reasoningEffort:'max'};
  await writeFile(path,JSON.stringify(manifest),{flag:'wx',mode:0o600});
  const env={...process.env};for(const key of ['MOTE_PRIVATE_IMAGE_ACCESS','MOTE_PRIVATE_IMAGE_CONSENT','MOTE_IMAGE_CONTEXT_LIVE_AUTHORIZED','MOTE_CODEX_BIN','MOTE_CODEX_HOME'])delete env[key];
  const result=spawnSync(process.execPath,['--import','tsx','scripts/test-image-context-live.ts'],{cwd:process.cwd(),env:{...env,...switches,MOTE_IMAGE_CONTEXT_MODE:mode,MOTE_IMAGE_CONTEXT_MANIFEST:path},encoding:'utf8',timeout:30000});
  await writeFile(join(output,key+'.log'),result.stdout+result.stderr,{flag:'wx',mode:0o600});
  assert.equal(result.status,1);assert.ok(result.stderr.includes(expected),result.stderr);assert.ok(!result.stderr.includes('ENOENT'),'The guard must reject before resolving a source');assert.equal(existsSync(destination),false);
  outcomes.push({name:key,status:'passed',sourceOpened:false,realModelCalls:0,stubModelCalls:0});
  await writeFile(join(output,'ROOT_SAFE_guards.json'),JSON.stringify({status:outcomes.length===6?'passed':'running',cases:outcomes,realModelCalls:0,stubModelCalls:0,privateDataRead:false},null,2)+'\n',{mode:0o600});
 });
}
