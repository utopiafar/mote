import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,stat,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const composeAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
import {profilePaths,initialize,loadProfile,effectiveConfiguration,isolatedEnvironment,setPublicUrl,compose,composeEnvironment,dockerConfigurationUser} from '../profile-lib.mjs';
import {parseConfigDocument,serializeConfigDocument} from '../../packages/shared/src/config-file.ts';
async function fixture(t) {const directory=await mkdtemp(join(tmpdir(),'mote-yaml-profile-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
function changedPaths(before,after,path=[]) {
 if(Object.is(before,after))return [];
 if(!before||!after||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)!==Array.isArray(after))return [path];
 const keys=new Set([...Object.keys(before),...Object.keys(after)]);
 return [...keys].flatMap(key=>changedPaths(before[key],after[key],[...path,key]));
}
test('init creates one private YAML without a model, preserves secret references during atomic edits, and rejects ambient server overrides',async t=>{
 const home=await fixture(t),paths=profilePaths('test',home);await initialize(paths);let p=await loadProfile(paths);
 assert.equal((await stat(paths.configFile)).mode&0o777,0o600);assert.equal(await stat(paths.legacyEnvFile).then(()=>true,()=>false),false);
 const initialized=await readFile(paths.configFile,'utf8');assert.deepEqual(p.savedDocument.models,{});assert.equal(initialized.includes('codex'),false);assert.equal(initialized.includes('gpt-6.1-sol'),false);
 const source=parseConfigDocument(initialized).savedDocument;source.server.token='${GENERATED_OWNER}';
 source.models={deployment:{provider:'deepseek',protocol:'deepseek',baseUrl:'https://generated-model.invalid/anthropic',model:'generated-model',reasoningEffort:'high',maxTokens:4096,modelRequestTimeoutMs:10000,agentTimeoutMs:20000,allowUnauthenticatedLocal:false,apiKey:'${GENERATED_OWNER}',headers:{},extraBody:{private:'${GENERATED_BODY}'}}};
 const oldOwner=process.env.GENERATED_OWNER,oldBody=process.env.GENERATED_BODY;process.env.GENERATED_OWNER='generated-owner-'.repeat(4);process.env.GENERATED_BODY='generated-body-secret';
 t.after(()=>{if(oldOwner===undefined)delete process.env.GENERATED_OWNER;else process.env.GENERATED_OWNER=oldOwner;if(oldBody===undefined)delete process.env.GENERATED_BODY;else process.env.GENERATED_BODY=oldBody;});
 await writeFile(paths.configFile,serializeConfigDocument(source));p=await loadProfile(paths);await setPublicUrl(p,'https://generated.invalid');
 assert.equal(p.savedDocument.server.token,'${GENERATED_OWNER}');assert.equal(p.savedDocument.models.deployment.apiKey,'${GENERATED_OWNER}');assert.equal(p.savedDocument.models.deployment.extraBody.private,'${GENERATED_BODY}');assert.equal(p.savedDocument.revision,1);
 assert.equal(p.document.models.deployment.apiKey,'generated-owner-'.repeat(4));assert.equal(p.document.models.deployment.extraBody.private,'generated-body-secret');
 const env=isolatedEnvironment(p,{MOTE_UNUSED:'client-only'});assert.equal(env.MOTE_CONFIG_FILE,paths.configFile);assert.equal(env.MOTE_PORT,undefined);assert.equal(env.MOTE_LOG_DIR,undefined);assert.equal(env.GENERATED_BODY,'generated-body-secret');
 const offline=JSON.stringify(effectiveConfiguration(p));for(const secret of [p.env.MOTE_TOKEN,p.env.MOTE_MODEL_API_KEY,'generated-body-secret',p.document.media.workerToken])assert.equal(offline.includes(secret),false);
 await assert.rejects(initialize(paths),/already exists/);
 const replaced=join(p.directory,'replacement.yaml');await writeFile(replaced,serializeConfigDocument({...p.savedDocument,revision:2,server:{...p.savedDocument.server,port:47953}}));await rename(replaced,p.configFile);
 assert.equal((await loadProfile(paths)).port,47953);
});
test('init changes only the model domain and keeps listener, port and origin defaults',async t=>{
 const home=await fixture(t),paths=profilePaths('test',home);await initialize(paths,{port:49160});
 const current=parseConfigDocument(await readFile(paths.configFile,'utf8')).savedDocument;
 assert.deepEqual(current.models,{});assert.equal(current.server.host,'127.0.0.1');assert.equal(current.server.port,49160);
 assert.deepEqual(current.server.allowedOrigins,['http://localhost:5174','http://127.0.0.1:5174']);
 const previous=structuredClone(current);previous.models={deployment:{provider:'codex',protocol:'codex-app-server',model:'gpt-6.1-sol',reasoningEffort:'high',serviceTier:'fast'}};
 const differences=changedPaths(previous,current);assert.ok(differences.length>0);assert.ok(differences.every(path=>path[0]==='models'),JSON.stringify(differences));
 const portChanged=structuredClone(current);portChanged.server.port+=1;
 assert.deepEqual(changedPaths(current,portChanged),[['server','port']],'the comparison must report a deliberate port change');
});
test('legacy profile refusal leaves the selected old configuration and data untouched',async t=>{
 const home=await fixture(t),paths=profilePaths('test',home);await mkdir(join(paths.directory,'data'),{recursive:true});const body='MOTE_TOKEN=generated-old-private-token';await writeFile(paths.legacyEnvFile,body);await writeFile(join(paths.directory,'data/sentinel'),'generated archive');
 await assert.rejects(loadProfile(paths),/Legacy mote.env profiles are unsupported/);await assert.rejects(initialize(paths),/already exists/);
 assert.equal(await readFile(paths.legacyEnvFile,'utf8'),body);assert.equal(await readFile(join(paths.directory,'data/sentinel'),'utf8'),'generated archive');assert.equal(await stat(paths.configFile).then(()=>true,()=>false),false);
});
test('Docker uses the same parent-mounted YAML, declared paths and private file owner without ordinary env injection',{skip: !composeAvailable ? 'Docker Compose CLI is unavailable' : false},async t=>{
 const home=await fixture(t),paths=profilePaths('test',home);await initialize(paths,{runtime:'docker',port:47954});const p=await loadProfile(paths);
 assert.equal(p.document.server.port,47954);assert.equal(p.document.server.host,'0.0.0.0');assert.equal(p.document.storage.dataDir,'/data');assert.equal(p.document.diagnostics.directory,'/data/logs');
 const config=JSON.parse(await compose(p,['config','--format','json'],{capture:true}));assert.deepEqual(config.services.mote.environment,{MOTE_CONFIG_FILE:'/config/mote.yaml'});
 assert.equal(config.services.mote.healthcheck,undefined,'Central retains the image healthcheck with its local PID check');
 for(const [name,role] of [['ocr-worker','ocr'],['asr-worker','asr']])assert.deepEqual(config.services[name].healthcheck.test,['CMD','node','scripts/media-worker-health.mjs',role],'each media worker reports its own idle or listening health instead of probing the Central listener');
 assert.equal(config.services.mote.ports[0].target,47954);assert.equal(config.services.mote.volumes.find(value=>value.target==='/config').source,p.directory);assert.equal(config.services.mote.volumes.find(value=>value.target==='/config').read_only,undefined);
 for(const [name,role,runtime] of [['ocr-worker','ocr','ocr'],['asr-worker','asr','dialogue']])assert.deepEqual(config.services[name].command,['node','scripts/media-worker-entry.mjs',role,`/opt/mote-media/${runtime}/bin/python`],'each worker selects its own bundled interpreter');
 assert.equal(config.services['storage-init'].network_mode,'none');
 for(const name of ['mote','ocr-worker','asr-worker','storage-init']) {
  for(const volume of config.services[name].volumes) {
   if(volume.type==='volume')assert.equal(volume.volume.nocopy,true,`${name} must preserve initialized volume ownership`);
   else assert.equal(volume.volume,undefined,'Configuration bind mounts retain their existing options');
  }
 }
 assert.equal(await readFile(join(p.directory,'generated/secrets.env'),'utf8'),'\n');
 const clean={...process.env};delete process.env.DOCKER_CONTEXT;delete process.env.DOCKER_HOST;t.after(()=>{if(clean.DOCKER_CONTEXT!==undefined)process.env.DOCKER_CONTEXT=clean.DOCKER_CONTEXT;if(clean.DOCKER_HOST!==undefined)process.env.DOCKER_HOST=clean.DOCKER_HOST;});
 const engine=security=>async(_name,args)=>JSON.stringify(args[0]==='context'?'unix:///generated/docker.sock':security);
 const metadata=await stat(p.configFile);assert.equal(await dockerConfigurationUser(p,engine([])),`${metadata.uid}:${metadata.gid}`);assert.equal(await dockerConfigurationUser(p,engine(['name=rootless'])),'0:0');await assert.rejects(dockerConfigurationUser(p,engine(['name=userns'])),/userns-remap/);
 process.env.DOCKER_HOST='ssh://generated.invalid';await assert.rejects(dockerConfigurationUser(p,engine([])),/local Unix/);
 assert.equal(composeEnvironment(p).MOTE_CONFIG_DIRECTORY,p.directory);
});

test('offline configuration hides credentials embedded in invalid endpoint edits', async t => {
 const home = await fixture(t), paths = profilePaths('test', home); await initialize(paths);
 const raw = parseConfigDocument(await readFile(paths.configFile, 'utf8')).savedDocument;
 raw.server.publicUrl = 'https://generated:private-password@fixture.invalid/?key=private-query';
 raw.models.deployment = { baseUrl: 'https://generated:private-model-password@fixture.invalid/?key=private-model-query' };
 raw.models.embedding = { baseUrl: 'https://generated:private-embedding-password@fixture.invalid/?key=private-embedding-query' };
 raw.connectors.googleRedirectUri = 'https://generated:private-google-password@fixture.invalid/?key=private-google-query';
 await writeFile(paths.configFile, serializeConfigDocument(raw));
 const output = JSON.stringify(effectiveConfiguration(await loadProfile(paths)));
 for (const value of ['private-password', 'private-query', 'private-model-password', 'private-model-query', 'private-embedding-password', 'private-embedding-query', 'private-google-password', 'private-google-query']) assert.equal(output.includes(value), false);
});

test('Docker model paths share the YAML mount target and reject collisions with product mounts', {skip: !composeAvailable ? 'Docker Compose CLI is unavailable' : false}, async t => {
 const home = await fixture(t), paths = profilePaths('test', home); await initialize(paths,{runtime:'docker'});
 const raw = parseConfigDocument(await readFile(paths.configFile,'utf8')).savedDocument;
 raw.media.modelDirectory='/generated-model-resources'; await writeFile(paths.configFile,serializeConfigDocument(raw));
 const p=await loadProfile(paths),config=JSON.parse(await compose(p,['config','--format','json'],{capture:true}));
 assert.equal(p.modelDirectory,raw.media.modelDirectory);
 for (const service of ['mote','ocr-worker','asr-worker','storage-init']) {const volume=config.services[service].volumes.find(volume=>volume.source==='mote-models');assert.equal(volume.target,raw.media.modelDirectory);assert.equal(volume.volume.nocopy,true);}
 assert.equal(config.services['storage-init'].command.at(-1),raw.media.modelDirectory);
 for (const path of ['/','/config','/config/models','/data','/data/models','/app','/app/models','relative-models']) {raw.media.modelDirectory=path;await writeFile(paths.configFile,serializeConfigDocument(raw));await assert.rejects(loadProfile(paths),/media.modelDirectory/);}
});
