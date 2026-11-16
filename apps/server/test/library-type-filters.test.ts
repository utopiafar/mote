import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {libraryMaterialTypes,type LibraryMaterialType,type SourceItem} from '@mote/shared';
import {buildApp} from '../src/app.js';
import {materialId,type MaterialDraft} from '../src/materials.js';
import {gmailItems} from '../src/connectors/gmail.js';

test('owner Library types filter published original facts before paging, preserve overlapping facts and pin cursor scope',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-library-types-')),at='2026-10-20T01:00:00.000Z';
 const node=await buildApp({dataDir:directory,token:'generated-library-type-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer generated-library-type-token','x-mote-ingress-version':'2'};
 node.sources.register({id:'generated-type-source',kind:'custom',name:'Generated source',deviceId:'generated-type-device',platform:'import'});
 const drafts=new Map<string,MaterialDraft>();
 async function original(name:string,extra:Partial<SourceItem>={},kind?:string){
  const item:SourceItem={externalId:name,revision:'v1',observedAt:at,title:'Generated '+name,text:'Generated literal body for '+name,kind:'file',layer:'snapshot',...extra};
  let captureId:string;
  if(kind==='mote.note'){
   captureId=randomUUID();const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:captureId,deviceId:'generated-type-device',deviceName:'Generated device',platform:'import',capturedAt:at,text:item.text}});assert.equal(response.statusCode,201,response.body);
  }else captureId=(await node.sources.upsert('generated-type-source',item)).id;
  const member={id:captureId,kind:'capture',ref:'capture:'+captureId,...(kind==='mote.note'?{}:{revision:item.revision})};
  const draft:MaterialDraft={id:materialId('generated-type-source',item.externalId),kind:kind??'mote.'+item.kind,schemaVersion:1,title:item.title!,origin:{sourceId:'generated-type-source',externalId:item.externalId,deviceId:'generated-type-device',firstAt:at,lastAt:at},members:[member],blocks:[{id:'body',kind:'text',format:'plain',text:item.text||'Generated metadata-only reference',memberIds:[member.id]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:item.layer==='reference'?'unavailable':'retained',policy:'keep'}};
  drafts.set(name,draft);return node.materials.publish(draft);
 }
 const note=await original('note',{kind:'message'},'mote.note');
 const image=await original('image',{mimeType:'image/png'});
 const referenceImage=await original('reference-image',{mimeType:'image/png',layer:'reference',text:''});
 const transcript=await original('transcript',{mimeType:'text/plain',document:{contentRole:'transcript'}});
 const document=await original('document',{mimeType:'application/pdf'});
 await original('json',{mimeType:'application/json'});
 await original('spreadsheet',{mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 const unknown=await original('unknown-image-title.png',{mimeType:'application/octet-stream'});
 await original('message',{kind:'message',mimeType:'text/plain'});
 const gmail=gmailItems({id:'generated-mail',payload:{mimeType:'text/plain',body:{data:Buffer.from('Generated mail text').toString('base64url')},headers:[{name:'subject',value:'Generated mail'}]}},at)[0]!;
 const email=await original('email',gmail);
 const rfc=await original('rfc-mail',{mimeType:'message/rfc822'});
 await original('calendar',{kind:'calendar',calendar:{start:at,end:'2026-10-20T02:00:00.000Z',allDay:false}});
 await original('coding',{kind:'message'},'mote.coding-session');
 const custom=await original('custom',{kind:'message'},'generated.custom');
 // Attachments cannot turn a note into an image or transcript.
 const noteDraft=drafts.get('note')!,imageMember=drafts.get('image')!.members[0]!;
 node.materials.publish({...noteDraft,members:[...noteDraft.members,imageMember],blocks:[...noteDraft.blocks,{id:'attachment-transcript',kind:'text',format:'transcript',text:'Generated attached transcript',memberIds:[noteDraft.members[0]!.id,imageMember.id],locator:{startMs:0,endMs:1000}}]},{expectedRevision:note.revision});
 const timed=await original('timed',{mimeType:'audio/wav'}),timedDraft=drafts.get('timed')!;
 node.materials.publish({...timedDraft,blocks:[...timedDraft.blocks,{id:'timed',kind:'text',format:'speech-text',text:'Generated timed transcript',memberIds:[timedDraft.members[0]!.id],locator:{startMs:0,endMs:1000}}]},{expectedRevision:timed.revision});
 const ocr=await original('ocr',{mimeType:'image/jpeg'}),ocrDraft=drafts.get('ocr')!;
 node.materials.publish({...ocrDraft,blocks:[...ocrDraft.blocks,{id:'ocr',kind:'text',format:'speech-text',text:'Generated OCR with spatial fields',memberIds:[ocrDraft.members[0]!.id],locator:{imageLocation:{x:0,y:0}}}]},{expectedRevision:ocr.revision});
 // More than a default page of unrelated recent inputs cannot hide filtered files.
 for(let index=0;index<27;index++)await original('later-note-'+index,{kind:'message'},'mote.note');
 const read=async(query:URLSearchParams|string,expected=200,auth=headers)=>{const response=await node.app.inject({url:'/api/library/catalog?'+query,headers:auth});assert.equal(response.statusCode,expected,response.body);return response.json();};
 async function ids(type:LibraryMaterialType){const output:string[]=[];let cursor:string|undefined;do{const page=await read(new URLSearchParams({type,limit:'2',...(cursor?{cursor}:{})}));output.push(...page.items.map((item:{id:string})=>item.id));cursor=page.nextCursor??undefined;}while(cursor);assert.equal(new Set(output).size,output.length);return new Set(output);}
 assert.deepEqual(await ids('image'),new Set([image.id,referenceImage.id,ocr.id]));
 assert.deepEqual(await ids('document'),new Set([document.id,transcript.id,materialId('generated-type-source','json'),materialId('generated-type-source','spreadsheet')]));
 assert.deepEqual(await ids('transcript'),new Set([transcript.id,timed.id]));
 assert.deepEqual(await ids('reference'),new Set([referenceImage.id]));
 assert.deepEqual(await ids('email'),new Set([email.id,rfc.id]));
 assert.equal((await ids('note')).size,28);
 assert.deepEqual(await ids('calendar'),new Set([materialId('generated-type-source','calendar')]));
 assert.deepEqual(await ids('coding'),new Set([materialId('generated-type-source','coding')]));
 assert.equal((await read('limit=100')).items.some((item:{id:string})=>item.id===unknown.id),true);
 assert.equal((await read('kind=generated.custom')).items[0].id,custom.id);
 for(const type of libraryMaterialTypes)assert.equal((await ids(type)).has(custom.id),false);
 const page=await read('type=image&limit=1');assert.ok(page.nextCursor);
 await read(new URLSearchParams({type:'document',limit:'1',cursor:page.nextCursor}),409);
 await read(new URLSearchParams({type:'image',sourceId:'other',limit:'1',cursor:page.nextCursor}),409);
 assert.deepEqual((await read('type=image&sourceId=other')).items,[]);
 assert.deepEqual((await read('type=image&deviceId=other')).items,[]);
 assert.deepEqual((await read('type=image&after=2026-10-21T00%3A00%3A00Z')).items,[]);
 await read('type=made-up',400);
 // A newer source head cannot relabel the still-published, pinned old material.
 await node.sources.upsert('generated-type-source',{externalId:'image',revision:'v2',observedAt:at,title:'Generated newer PDF',text:'New version',kind:'file',layer:'snapshot',mimeType:'application/pdf'});
 assert.equal((await ids('image')).has(image.id),true);assert.equal((await ids('document')).has(image.id),false);
 node.materials.retire(referenceImage.id,{expectedRevision:referenceImage.revision});
 assert.equal((await ids('image')).has(referenceImage.id),false);assert.deepEqual(await ids('reference'),new Set());
 await read(new URLSearchParams({type:'image',limit:'1',cursor:page.nextCursor}),409);
 assert.equal((await node.app.inject('/api/library/catalog?type=image')).statusCode,401);
 const invitation=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated collector'}});
 const redeemed=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'}});
 assert.equal(redeemed.statusCode,200,redeemed.body);
 await read('type=image',403,{...headers,authorization:'Bearer '+redeemed.json().token});
});
