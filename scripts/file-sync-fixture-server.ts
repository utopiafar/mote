/** Isolated, opt-in central node for generated Android file fixtures. Never starts capture. */
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {configFromFile} from '../apps/server/src/config.js';
import {buildApp} from '../apps/server/src/app.js';

const directory=resolve(process.env.MOTE_FILE_TEST_DIR??'.mote/file-validation');
mkdirSync(directory,{recursive:true,mode:0o700});
const modelFile=process.env.MOTE_FILE_TEST_MODEL_ENV;
const modelEnv=modelFile?parseEnv(readFileSync(resolve(modelFile),'utf8')):{};
// Copy only explicit model settings, never the source node's address, storage, tokens or collectors.
for(const key of Object.keys(process.env))if(key.startsWith('MOTE_'))delete process.env[key];
for(const [key,value] of Object.entries(modelEnv))if(key.startsWith('MOTE_MODEL_')||key==='MOTE_MODEL')process.env[key]=value;
const ownerFile=join(directory,'fixture-owner-token');
const owner=existsSync(ownerFile)?readFileSync(ownerFile,'utf8'):randomBytes(32).toString('hex');
writeFileSync(ownerFile,owner,{mode:0o600});
process.env.MOTE_FIXTURE_OWNER_TOKEN=owner;
const deployment:Record<string,string>={};
for(const [name,field] of [['MOTE_MODEL_PROVIDER','provider'],['MOTE_MODEL_PROTOCOL','protocol'],['MOTE_MODEL_BASE_URL','baseUrl'],['MOTE_MODEL','model'],['MOTE_MODEL_REASONING_EFFORT','reasoningEffort']] as const)if(modelEnv[name])deployment[field]=modelEnv[name];
if(modelEnv.MOTE_MODEL_API_KEY)deployment.apiKey='${MOTE_MODEL_API_KEY}';
const configFile=join(directory,'mote.yaml');
writeFileSync(configFile,serializeConfigDocument({version:1,revision:0,
  server:{profile:'file-fixture',host:'127.0.0.1',port:57569,token:'${MOTE_FIXTURE_OWNER_TOKEN}'},
  storage:{dataDir:join(directory,'archive')},diagnostics:{directory:join(directory,'logs'),level:'silent'},
  ...(Object.keys(deployment).length?{models:{deployment}}:{})}),{mode:0o600});
const config=configFromFile(configFile),node=await buildApp(config);
const deviceId='android-file-fixture',server='http://127.0.0.1:57569';
const {invitation}=node.connections.invite({serverUrl:server,label:'Generated Android file fixtures',deviceId});
const collector=await node.connections.redeem({code:invitation.code,deviceId,deviceName:'Generated Android file fixtures',platform:'android'});
writeFileSync(join(directory,'connection.json'),JSON.stringify({server,token:collector.token,ownerToken:owner,deviceId}),{mode:0o600});
await node.app.listen({host:'127.0.0.1',port:57569});
writeFileSync(join(config.dataDir,'server.pid'),String(process.pid),{mode:0o600});
console.info(JSON.stringify({ready:true,url:server,model:config.model||null,modelConfigured:!!config.apiKey,connectionFile:join(directory,'connection.json')}));
let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;void node.app.close().then(()=>process.exit(0));});
