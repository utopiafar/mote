/** Generated-only production UI fixture; never reads a native vendor account. */
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import type {RecordingProvider} from '../apps/server/src/connectors/recordings.js';
import {feishuTranscript} from '../apps/server/src/connectors/recording-formats.js';
const directory=process.argv[2];if(!directory)throw Error('Fixture directory required');
const token=randomBytes(32).toString('hex'),at=new Date().toISOString(),text='Generated diary\n\nGenerated speaker 00:00:00.000\nI finished a generated prototype today.\n';
const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
const provider:RecordingProvider={id:'feishu',version:'generated-browser@1',account:async()=>({id:'generated-owner',name:'Generated recording owner'}),discover:async()=>({ids:['generated-recording']}),metadata:async()=>({id:'generated-recording',title:'Generated recording',recordedAt:at,durationMs:1000}),transcript:async()=>({rawText:text,transcript:feishuTranscript(text,1000)}),media:async()=>({bytes:wav,mimeType:'audio/wav'})};
const runtime=await buildApp({dataDir:join(directory,'data'),dataKey:undefined,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{connectorTesting:{recordings:[provider]},agent:{configured:false,query:async()=>{throw Error('No model calls allowed');},close:async()=>{}}});
runtime.app.get('/__fixture-bootstrap',async(_request,reply)=>reply.type('text/html').send('<!doctype html><html><body>Generated fixture bootstrap</body></html>'));
await runtime.app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({server:runtime.app.server.address(),token,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
