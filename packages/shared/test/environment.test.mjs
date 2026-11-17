import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadEnvironment} from '../dist/environment.js';
import {serializeConfigDocument,parseConfigDocument,redactConfigDocument,configSecretEnvironment,readConfigDocument} from '../dist/config-file.js';
const rootFor = t => { const root=mkdtempSync(join(tmpdir(),'mote-yaml-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; };
test('a selected YAML determines CLI connection settings and ordinary environment cannot override it',t=>{
 const root=rootFor(t);mkdirSync(join(root,'dev'));writeFileSync(join(root,'.env'),'MOTE_TOKEN=legacy-secret');
 const file=join(root,'dev','mote.yaml');writeFileSync(file,serializeConfigDocument({version:1,revision:0,server:{profile:'dev',port:47842,token:'dev-only'},storage:{dataDir:'./vault'}}));
 const inherited={MOTE_CONFIG_FILE:file,MOTE_PORT:'47942',MOTE_TOKEN:'ambient'};
 const result=loadEnvironment(root,{env:inherited});assert.equal(Object.hasOwn(result,'envFile'),false);assert.equal(result.configFile,file);assert.equal(result.baseDir,join(root,'dev'));assert.equal(result.env.MOTE_TOKEN,'dev-only');assert.equal(result.env.MOTE_PORT,'47842');assert.equal(result.env.MOTE_URL,'http://127.0.0.1:47842');
 assert.deepEqual(inherited,{MOTE_CONFIG_FILE:file,MOTE_PORT:'47942',MOTE_TOKEN:'ambient'});
 assert.throws(()=>loadEnvironment(root,{env:{MOTE_ENV_FILE:join(root,'old.env')}}),/unsupported/);
 assert.throws(()=>loadEnvironment(root,{env:{MOTE_CONFIG_FILE:''}}),/must name/);
 assert.throws(()=>loadEnvironment(root,{env:{MOTE_CONFIG_FILE:join(root,'missing')}}));
 assert.equal(loadEnvironment(root,{env:{}}).env.MOTE_MODEL,undefined);
});
test('two YAML profile connections remain isolated without process environment mutation',t=>{
 const root=rootFor(t);
 for(const profile of ['dev','test'])writeFileSync(join(root,profile+'.yaml'),serializeConfigDocument({version:1,revision:0,server:{profile,token:profile+'-only'}}));
 const a=loadEnvironment(root,{env:{MOTE_CONFIG_FILE:join(root,'dev.yaml')}}),b=loadEnvironment(root,{env:{MOTE_CONFIG_FILE:join(root,'test.yaml')}});
 assert.equal(a.env.MOTE_PROFILE,'dev');assert.equal(b.env.MOTE_PROFILE,'test');assert.notEqual(a.env.MOTE_TOKEN,b.env.MOTE_TOKEN);
});
test('secret references resolve only in registered credentials, while serialization preserves the reference',()=>{
 const input={version:1,revision:0,server:{token:'${OWNER}',profile:'${PROFILE}'},models:{deployment:{apiKey:'${MODEL_KEY}',extraBody:{private:'${BODY_KEY}'}}}};
 const result=parseConfigDocument(serializeConfigDocument(input),{OWNER:'generated-owner',PROFILE:'prod',MODEL_KEY:'generated-model',BODY_KEY:'generated-body'});
 assert.equal(result.document.server.token,'generated-owner');assert.equal(result.document.server.profile,'${PROFILE}');assert.deepEqual(result.savedDocument,input);
 assert.deepEqual(configSecretEnvironment(input,{OWNER:'generated-owner',PROFILE:'prod',MODEL_KEY:'generated-model',BODY_KEY:'generated-body'}),{OWNER:'generated-owner',MODEL_KEY:'generated-model',BODY_KEY:'generated-body'});
 const serialized=JSON.stringify(redactConfigDocument(result.document));for(const secret of ['generated-owner','generated-model','generated-body'])assert.ok(!serialized.includes(secret));
 assert.throws(()=>parseConfigDocument(serializeConfigDocument(input),{}),/Missing secret environment/);
});
test('YAML duplicates, aliases, invalid roots, old versions and oversized files reject safely',()=>{
 for(const raw of ['version: 1\nversion: 1\nrevision: 0','version: 1\nrevision: 0\na: &a [generated]\nb: *a','[generated]','version: 0\nrevision: 0','version: 1\nrevision: -1','version: 1\nrevision: 0\nvalue: '+ 'a'.repeat(1024*1024)])assert.throws(()=>parseConfigDocument(raw));
});

test('file loading refuses symbolic and hard links before reading private contents',t=>{const root=rootFor(t),file=join(root,'mote.yaml');writeFileSync(file,'version: 1\nrevision: 0\n');symlinkSync(file,join(root,'alias.yaml'));assert.throws(()=>readConfigDocument(join(root,'alias.yaml')));linkSync(file,join(root,'hard.yaml'));assert.throws(()=>readConfigDocument(file));});

test('plugin references reach only secret env transport and remain unresolved and fully masked until registered',()=>{
 const input={version:1,revision:0,plugins:{configuration:{generated:{apiKey:'${PLUGIN_SECRET}',mode:'${ORDINARY_PLUGIN}'}}},server:{profile:'${ORDINARY_SERVER}'}};
 const env={PLUGIN_SECRET:'generated-plugin-secret',ORDINARY_PLUGIN:'generated-mode',ORDINARY_SERVER:'prod'};
 assert.deepEqual(configSecretEnvironment(input,env),{PLUGIN_SECRET:env.PLUGIN_SECRET,ORDINARY_PLUGIN:env.ORDINARY_PLUGIN});
 const parsed=parseConfigDocument(serializeConfigDocument(input),env);assert.deepEqual(parsed.document.plugins.configuration,input.plugins.configuration);assert.equal(redactConfigDocument(parsed.document).plugins.configuration,'[redacted]');
 for(const key of ['MOTE_CONFIG_FILE','NODE_OPTIONS','NODE_PATH','PATH','DOCKER_HOST','LD_PRELOAD'])assert.throws(()=>configSecretEnvironment({version:1,revision:0,plugins:{configuration:{generated:{apiKey:'${'+key+'}'}}}},{}),/bootstrap/);
});
