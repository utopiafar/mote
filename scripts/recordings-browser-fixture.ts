/** Generated-only production UI fixture; never reads a native vendor account. */
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import type {RecordingProvider} from '../apps/server/src/connectors/recordings.js';
import {feishuTranscript} from '../apps/server/src/connectors/recording-formats.js';
import {dingtalkTranscript} from '../apps/server/src/connectors/dingtalk-recordings.js';
const directory=process.argv[2];if(!directory)throw Error('Fixture directory required');
const token=randomBytes(32).toString('hex'),at=new Date().toISOString();
const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
function generatedProvider(id:'feishu'|'dingtalk'):RecordingProvider {
 const recordingId=`generated-${id}-recording`,text=`Generated ${id} diary\n\nGenerated ${id} speaker 00:00:00.000\nI finished a generated ${id} prototype today.\n`;
 return {id,version:'generated-browser@2',
  account:async()=>({id:`generated-${id}-owner`,name:`Generated ${id} recording owner`}),
  discover:async()=>({ids:[recordingId]}),
  metadata:async()=>({id:recordingId,title:`Generated ${id} recording`,recordedAt:at,durationMs:id==='feishu'?1000:0}),
  transcript:async()=>id==='feishu'?{rawText:text,transcript:feishuTranscript(text,1000)}:
   dingtalkTranscript({taskUuid:recordingId,complete:true,paragraphList:[{speakerNick:'Generated dingtalk speaker',text:'I finished a generated dingtalk prototype today.'}]}),
  media:async()=>({bytes:wav,mimeType:'audio/wav'}),
 };
}
const runtime=await buildApp({dataDir:join(directory,'data'),dataKey:undefined,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxExportBytes:10_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{connectorTesting:{recordings:[generatedProvider('feishu'),generatedProvider('dingtalk')]},agent:{configured:false,query:async()=>{throw Error('No model calls allowed');},close:async()=>{}}});
await runtime.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({server:runtime.app.server.address(),token,providers:['feishu','dingtalk'],generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
