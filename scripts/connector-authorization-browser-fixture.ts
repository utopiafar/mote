/** Generated CLI only. No native vendor credentials or model calls. */
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import {generatedRecordingCli} from '../apps/server/test/fixtures/recording-authorization-cli.js';
const directory=process.argv[2];if(!directory)throw Error('Fixture directory required');
const clis=await Promise.all((['feishu','dingtalk'] as const).map(provider=>generatedRecordingCli(join(directory,provider),provider))),token=randomBytes(32).toString('hex');
const node=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'generated-only',host:'127.0.0.1',port:0,maxExportBytes:10000000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},{connectorTesting:{recordings:clis.map(cli=>cli.provider)},agent:{configured:false,close:async()=>{},query:async()=>{throw Error('No model belongs in authorization UI fixture');}}});
node.app.post('/generated/complete/:provider',async(request,reply)=>{if(request.headers.authorization!=='Bearer '+token)return reply.code(401).send();const cli=clis.find(cli=>cli.provider.id===(request.params as any).provider)!;await cli.complete();return {ok:true};});
node.app.get('/generated/commands/:provider',async(request,reply)=>{if(request.headers.authorization!=='Bearer '+token)return reply.code(401).send();return clis.find(cli=>cli.provider.id===(request.params as any).provider)!.commands();});
await node.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({server:node.app.server.address(),token,urls:Object.fromEntries(clis.map(cli=>[cli.provider.id,cli.url])),generatedOnly:true}));
process.on('SIGTERM',()=>void node.app.close().then(()=>process.exit(0)));
