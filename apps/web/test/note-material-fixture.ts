import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {buildApp} from '../../server/src/app.js';
import {materialId} from '../../server/src/materials.js';
/** Generated originals and host Material publication. No model or private source reads. */
export async function noteMaterialFixture(directory:string,webRoot?:string,prepare?:(node:Awaited<ReturnType<typeof buildApp>>)=>void){
 const token='generated-note-material-'+randomUUID();let modelCalls=0;
 const node=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'},{webRoot,backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('No models in Note Material UI fixture');},close:async()=>{}}});
 try{
 prepare?.(node);
 const headers={authorization:'Bearer '+token},at='2026-10-29T00:00:00.000Z';
 async function note(text:string,metadata?:Record<string,unknown>,attachment=false){
  const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-note-reader',deviceName:'Generated reader fixture',platform:'import',capturedAt:at,text,...(metadata?{metadata:{version:1,observedAt:at,...metadata}}:{})}});if(response.statusCode!==201)throw Error(response.body);
  const file=attachment?node.archivedFiles.put({name:'generated-note-attachment.txt',mimeType:'text/plain',bytes:Buffer.from('Exact generated attachment bytes.')}):undefined;if(file)node.archivedFiles.attach(id,[file.id]);
  await node.materialOrganizer.tick(100);const material=node.materials.list({kind:'mote.note'}).items.find(item=>item.origin.externalId===id);if(!material)throw Error('Generated Note Material missing');return{id,material,file};
 }
 const literal='{"text":"This JSON-shaped string is literal owner prose."}\n<script>literal, never execute()</script>\nFinal literal line.';
 const short=await note(literal,{ownerDescription:'Generated separate description; never part of the original body.'},true);
 const quoted='Generated saved question?\n\nGenerated saved answer with exact attribution.';
 const shared=await note('Generated personal addition, preserved independently.',{ownerDescription:'Generated saved-Q&A description.',noteOrigin:{kind:'conversation',conversationId:randomUUID(),messageIds:[randomUUID()],text:quoted}});
 const citedAnswer='## Generated heading\n\n**Generated answer** ['+short.id+']';
 const result={runId:randomUUID(),answer:citedAnswer,citations:[{id:short.id,appName:'Generated source',capturedAt:at,excerpt:literal}],trace:[],evidenceDependencies:{version:1 as const,complete:true,ids:[short.id]}};
 const exactTurn=node.conversations.append(undefined,{question:'Generated saved question?'},result),exactSnapshot='Generated saved question?\n\n'+citedAnswer;
 const exact=await note('Generated exact Android addition.',{ownerDescription:'Generated exact separate description.',noteOrigin:{kind:'conversation',conversationId:exactTurn.conversationId,messageIds:[exactTurn.turnId],text:exactSnapshot}});
 const longQuestion='Generated long question?',longPrefix='## Generated long answer\n\n'+('x'.repeat(3910))+'\n\n```\n**Literal code** ['+short.id+']\n```\n\nVerified citation ['+short.id+']\n\n',unicodePad=11999-longQuestion.length-2-longPrefix.length,longAnswer=longPrefix+('x'.repeat(unicodePad))+'😀'+('x'.repeat(100000-longQuestion.length-2-longPrefix.length-unicodePad-2)),longSnapshot=longQuestion+'\n\n'+longAnswer;
 const longTurn=node.conversations.append(undefined,{question:longQuestion},{runId:randomUUID(),answer:longAnswer,citations:[{id:short.id,appName:'Generated source',capturedAt:at,excerpt:literal}],trace:[],evidenceDependencies:{version:1,complete:true,ids:[short.id]}});
 const longQuote=await note('Generated long quote addition.',{noteOrigin:{kind:'conversation',conversationId:longTurn.conversationId,messageIds:[longTurn.turnId],text:longSnapshot}});
 const long=await note('Generated long original: '+('完整正文😀\n'.repeat(1200))+' END OF GENERATED ORIGINAL.');
 // Controlled host publication tests bounded /read, not an authored-organizer block-order claim.
 const paged=node.materials.publish({id:materialId(short.material.origin.sourceId,'generated-metadata-first'),kind:'mote.note',schemaVersion:2,title:'Generated metadata-first page',origin:{...short.material.origin,externalId:'generated-metadata-first'},members:[{id:short.id,kind:'capture',ref:'capture:'+short.id}],blocks:[{id:'record-metadata',kind:'text',format:'json',text:JSON.stringify({generatedDiagnostic:'x'.repeat(4200)}),memberIds:[short.id]},{id:'record',kind:'text',format:'plain',text:'Generated body on the following page.',memberIds:[short.id]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
 return{...node,token,headers,short,shared,exact,exactTurn,exactSnapshot,citedAnswer,longQuote,longSnapshot,long,paged,literal,quoted,modelCalls:()=>modelCalls};
 }catch(error){await node.app.close();throw error;}
}
