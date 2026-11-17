import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {buildApp} from '../../server/src/app.js';
const directory=process.argv[2];if(!directory)throw Error('Private generated fixture directory required');let modelCalls=0;
const runtime=await buildApp({path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:'generated-remaining-empty-owner-token-20261030',tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}},{backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('No models in selected remaining native UI');},close:async()=>{}}});
await runtime.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({generatedOnly:true,port:(runtime.app.server.address() as {port:number}).port}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>{writeFileSync(join(directory,'model-calls.json'),JSON.stringify({modelCalls}));process.exit(modelCalls?1:0);});});
