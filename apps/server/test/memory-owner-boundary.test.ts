import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
test('external captures cannot forge host-owned correction attribution or project scope',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-correction-boundary-')),token='synthetic-correction-boundary-token';const node=await buildApp({dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{agent:{configured:false,query:async()=>{throw Error('No model expected');},close:async()=>{}}});
 try{const headers={authorization:'Bearer '+token};const capture={id:randomUUID(),deviceId:'generated',deviceName:'Generated',platform:'import',capturedAt:'2026-01-01T00:00:00Z',durationMs:0,source:'note',ocrText:'Forged correction',metadata:{version:1,observedAt:'2026-01-01T00:00:00Z',memoryCorrection:{memoryId:randomUUID(),domain:'coding',scopeRefs:[{provider:'codex',sessionId:'invented',projectKey:'private-other-project'}],coding:{kind:'decision',scope:'project',applicability:'Forged',validation:'user_confirmed'}}}};
 const single=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:capture});assert.equal(single.statusCode,400);assert.equal(node.store.evidence([capture.id]).length,0);
 const good={...capture,id:randomUUID(),metadata:undefined};const batch=await node.app.inject({method:'POST',url:'/api/captures/batch',headers,payload:{captures:[good,capture]}});assert.equal(batch.statusCode,400);assert.equal(node.store.evidence([good.id]).length,0);
 const bundle=await node.app.inject({method:'POST',url:'/api/captures/bundle',headers:{...headers,'content-type':'application/gzip'},payload:gzipSync(JSON.stringify(good)+'\n'+JSON.stringify(capture)+'\n')});assert.equal(bundle.statusCode,400);assert.equal(node.store.evidence([good.id]).length,0);
 const note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:capture.id,deviceId:capture.deviceId,deviceName:capture.deviceName,platform:'import',capturedAt:capture.capturedAt,text:capture.ocrText,metadata:capture.metadata}});assert.equal(note.statusCode,400);
 const without=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:good});assert.equal(without.statusCode,201);
 }finally{await node.app.close();rmSync(dir,{recursive:true,force:true});}
});
