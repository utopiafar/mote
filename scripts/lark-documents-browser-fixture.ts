/** Generated-only provider fixture for the real central application and browser entry points. */
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import {LARK_SCOPES} from '../apps/server/src/connectors/lark.js';
import type {LarkCommand,LarkRunner} from '../apps/server/src/connectors/lark-cli.js';
import {ConnectorError} from '../apps/server/src/connectors/types.js';
const directory=process.argv[2];if(!directory)throw Error('Generated fixture directory required');
const token=randomBytes(32).toString('hex'),calls:LarkCommand[]=[];
let meetingFails=true;
const runner:LarkRunner=async command=>{
 calls.push(command);
 switch(command.kind){
  case 'version':return 'lark-cli version 1.0.85';
  case 'status':return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'generated-document-owner',userName:'Generated document owner',scope:[...LARK_SCOPES,'drive:drive:readonly','calendar:calendar:readonly'].join(' ')}}});
  case 'login':return JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?generated-only',device_code:'generated-private-code',expires_in:600});
  case 'complete':return '{}';
  case 'documents-search':return JSON.stringify({results:[['GeneratedDiary123','Generated journal'],['GeneratedMeeting123','Generated meeting notes']].map(([id,title])=>({title,result_meta:{url:'https://fixture.feishu.cn/docx/'+id}})),has_more:false});
  case 'document':{
   const id=command.document.split('/').at(-1)!;
   if(id==='GeneratedMeeting123'&&meetingFails){meetingFails=false;throw new ConnectorError('lark_permission_required');}
   return JSON.stringify({data:{document:{document_id:id,revision_id:1,title:id==='GeneratedDiary123'?'Generated journal':'Generated meeting notes',content:id==='GeneratedDiary123'?'# Generated journal\n\nI prepared an outline before my presentation and felt calmer. I plan to try it again.':'# Generated meeting notes\n\nWe agreed that the first release will only read documents. I will validate the interfaces; the review is next week.'}}});
  }
  case 'calendars':return JSON.stringify({data:{calendar_list:[],has_more:false}});
  default:return '{}';
 }
};
const runtime=await buildApp({dataDir:join(directory,'data'),dataKey:undefined,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxExportBytes:10_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{connectorTesting:{lark:runner},agent:{configured:false,query:async()=>{throw Error('No model calls allowed in browser fixture');},close:async()=>{}}});
runtime.app.get('/generated/lark-metrics',async request=>{
 if(request.headers.authorization!=='Bearer '+token)throw Error('Generated owner credential required');
 return {generatedOnly:true,bodyReads:calls.filter(command=>command.kind==='document').length,searches:calls.filter(command=>command.kind==='documents-search').length,modelCalls:0};
});
await runtime.app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({server:runtime.app.server.address(),token,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
