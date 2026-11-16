import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {profilePaths,initialize,loadProfile,compose,composeEnvironment,composeArgs,repository} from '../profile-lib.mjs';
import {parseDockerMediaWorkers,dockerMediaSelection,assertDockerMediaSelection,assertDockerMediaRuntime} from '../docker-media.mjs';
const available=spawnSync('docker',['compose','version'],{stdio:'ignore'}).status===0;
const fixture=async t=>{const root=await mkdtemp(join(tmpdir(),'mote-image-selection-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;};

test('Docker CLI init defaults to core with no media resources and rejects inconsistent selections before writing',async t=>{
  const root=await fixture(t),entry=join(repository,'scripts/mote.mjs');
  const run=(name,args)=>spawnSync(process.execPath,[entry,'init','--profile',name,'--home',root,'--runtime','docker',...args],{cwd:repository,encoding:'utf8',timeout:10000});
  const result=run('o1core',[]);assert.equal(result.status,0,result.stderr);
  const p=await loadProfile(profilePaths('o1core',root));assert.equal(p.meta.imageVariant,'core');assert.match(p.meta.image,/-core$/);assert.deepEqual(p.document.media.dockerWorkers,[]);
  const full=run('o1full',['--image-variant','full','--media-workers','ocr,asr']);assert.equal(full.status,0,full.stderr);
  const selected=await loadProfile(profilePaths('o1full',root));assert.deepEqual(dockerMediaSelection(selected),{variant:'full',workers:['ocr','asr']});assert.match(selected.meta.image,/-full$/);
  for(const args of [['--media-workers','ocr'],['--image-variant','unknown'],['--image-variant','full','--media-workers','ocr,ocr'],['--image-variant','full','--media-workers','local-image']])assert.notEqual(run('invalid',args).status,0);
  assert.equal(await readFile(profilePaths('invalid',root).metaFile).then(()=>true,()=>false),false);
});

test('real Compose consumes only selected worker roles without inheriting the other role profile',{skip:!available?'Docker Compose CLI unavailable':false},async t=>{
  const root=await fixture(t);
  for(const [name,variant,roles,expected] of [['core','core','none',[]],['idle','full','none',[]],['ocr','full','ocr',['ocr-worker']],['asr','full','asr',['asr-worker']],['both','full','ocr,asr',['asr-worker','ocr-worker']]]){
    const paths=profilePaths(name,root);await initialize(paths,{runtime:'docker','image-variant':variant,'media-workers':roles});const p=await loadProfile(paths),config=JSON.parse(await compose(p,['config','--format','json'],{capture:true}));
    assert.deepEqual(Object.keys(config.services).filter(value=>value.endsWith('-worker')).sort(),expected,name);assert.equal(config.services.mote.build.target,variant);
    assert.equal(config.services.mote.ports[0].host_ip,'127.0.0.1');assert.equal(config.services['storage-init'].network_mode,'none');
    for(const service of expected){assert.equal(config.services[service].network_mode,'service:mote');assert.deepEqual(config.services[service].profiles,['media-'+service.split('-')[0]]);assert.equal(config.services[service].depends_on.mote.condition,'service_healthy');assert.equal(config.services[service].volumes.find(value=>value.source==='mote-models').volume.nocopy,true);}
    assert.ok(!Object.hasOwn(composeEnvironment(p),'COMPOSE_PROFILES'),'ambient Compose choices cannot become deployment configuration');
    assert.ok(composeArgs(p,['stop']).includes('media-ocr'));assert.ok(composeArgs(p,['stop']).includes('media-asr'),'stop can release resources selected before a config edit');
    assert.equal(await readFile(join(p.directory,'generated/secrets.env'),'utf8'),'\n');
  }
});

test('core/media mismatch is rejected and full probes only selected immutable dependencies without owner data',async()=>{
  const p={meta:{runtime:'docker',image:'generated-full',imageVariant:'full'},document:{media:{dockerWorkers:['asr']}}},calls=[];
  await assertDockerMediaRuntime(p,async(command,args,options)=>{calls.push({command,args,options});});assert.equal(calls.length,1);
  const call=calls[0];assert.deepEqual(call.args.slice(0,9),['run','--rm','--pull','never','--network','none','--entrypoint','node','generated-full']);
  assert.ok(call.args.at(-1).includes('/opt/mote-media/dialogue/bin/python'));assert.ok(!call.args.at(-1).includes('/opt/mote-media/ocr'));
  assert.ok(!call.args.includes('--mount'));assert.ok(!call.args.includes('--volume'));assert.equal(call.options.timeoutMs,15000);
  await assert.rejects(()=>assertDockerMediaRuntime({...p,meta:{...p.meta,imageVariant:'core'}},()=>{throw Error('must not start');}),/require the full/);
  await assertDockerMediaRuntime({...p,document:{media:{dockerWorkers:[]}}},()=>{throw Error('unselected runtime must not be probed');});
  await assert.rejects(()=>assertDockerMediaRuntime(p,async()=>{throw Error('missing Python');}),/lacks the requested/);
  for(const roles of [['ocr','ocr'],['local-image'],null,'asr'])assert.throws(()=>assertDockerMediaSelection({...p,document:{media:{dockerWorkers:roles}}}));
  assert.deepEqual(parseDockerMediaWorkers('none'),[]);assert.deepEqual(parseDockerMediaWorkers('asr,ocr'),['ocr','asr']);
});
