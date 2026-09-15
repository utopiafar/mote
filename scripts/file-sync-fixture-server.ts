/** Isolated, opt-in central node for generated Android file fixtures. Never starts capture. */
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {configFromEnv} from '../apps/server/src/config.js';
import {buildApp} from '../apps/server/src/app.js';

const directory=resolve(process.env.MOTE_FILE_TEST_DIR??'.mote/file-validation');
mkdirSync(directory,{recursive:true,mode:0o700});
const modelFile=process.env.MOTE_FILE_TEST_MODEL_ENV;
const modelEnv=modelFile?parseEnv(readFileSync(resolve(modelFile),'utf8')):{};
// Copy only explicit model settings, never the source node's address, storage, tokens or collectors.
for(const key of Object.keys(process.env))if(key.startsWith('MOTE_'))delete process.env[key];
for(const [key,value] of Object.entries(modelEnv))if(key.startsWith('MOTE_MODEL_')||key==='MOTE_MODEL')process.env[key]=value;
const empty=join(directory,'empty.env');writeFileSync(empty,'',{mode:0o600});
const ownerFile=join(directory,'fixture-owner-token');
const owner=existsSync(ownerFile)?readFileSync(ownerFile,'utf8'):randomBytes(32).toString('hex');
writeFileSync(ownerFile,owner,{mode:0o600});
Object.assign(process.env,{MOTE_ENV_FILE:empty,MOTE_DATA_DIR:join(directory,'archive'),MOTE_LOG_DIR:join(directory,'logs'),MOTE_TOKEN:owner,MOTE_PORT:'57569',MOTE_LOG_LEVEL:'silent',MOTE_PROFILE:'file-fixture',MOTE_RETENTION_DAYS:'0'});
const config=configFromEnv(),node=await buildApp(config);
const deviceId='android-file-fixture',server='http://127.0.0.1:57569';
const {invitation}=node.connections.invite({serverUrl:server,label:'Generated Android file fixtures',deviceId});
const collector=await node.connections.redeem({code:invitation.code,deviceId,deviceName:'Generated Android file fixtures',platform:'android'});
writeFileSync(join(directory,'connection.json'),JSON.stringify({server,token:collector.token,ownerToken:owner,deviceId}),{mode:0o600});
await node.app.listen({host:'127.0.0.1',port:57569});
writeFileSync(join(config.dataDir,'server.pid'),String(process.pid),{mode:0o600});
console.info(JSON.stringify({ready:true,url:server,model:config.model||null,modelConfigured:!!config.apiKey,connectionFile:join(directory,'connection.json')}));
let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;void node.app.close().then(()=>process.exit(0));});
