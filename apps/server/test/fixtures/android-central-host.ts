import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {buildApp} from '../../src/app.js';
import type {Config} from '../../src/config.js';

/** Host half of the actual Android fixture journey. The Android test uploads
 * its own Queue payload over HTTP; no TypeScript-generated capture is inserted. */
const [readyPath,resultPath]=process.argv.slice(2);
if(!readyPath||!resultPath||!isAbsolute(readyPath)||!isAbsolute(resultPath))throw Error('Expected absolute ready/result JSON paths');
const directory=mkdtempSync(join(tmpdir(),'mote-android-central-')),token=randomBytes(32).toString('hex');
const config:Config={dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxExportBytes:10_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model calls in actual Android deterministic journey');},close:async()=>{}}});
let succeeded=false;
try{
  const hostUrl=await node.app.listen({host:'127.0.0.1',port:0}),port=(node.app.server.address() as {port:number}).port;
  writeFileSync(readyPath,JSON.stringify({url:`http://10.0.2.2:${port}`,hostUrl,token}),{mode:0o600});
  const headers={authorization:`Bearer ${token}`},marker='Generated original paragraph two.';
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    const capture=node.store.list({source:'ui_page',limit:100}).items.find(record=>record.platform==='android'&&record.metadata?.uiPage?.version===3&&record.ocrText.includes(marker));
    if(!capture){await pause(200);continue;}
    await node.materialOrganizer.tick(100);
    const material=node.materials.list({kind:'mote.ui-page-object',deviceId:capture.deviceId,limit:100}).items.find(material=>node.materials.members(material.ref).items.some(member=>member.id===capture.id));
    if(!material){await pause(200);continue;}
    const raw=await fetch(hostUrl+'/api/capture-browser/'+capture.id,{headers});assert.equal(raw.status,200);assert.equal((await raw.json() as {ocrText:string}).ocrText,capture.ocrText);
    const read=await fetch(hostUrl+`/api/materials/${material.id}/read?length=12000`,{headers});assert.equal(read.status,200);assert.ok((await read.json() as {text:string}).text.includes(marker));
    const search=await fetch(hostUrl+'/api/materials?'+new URLSearchParams({kind:'mote.ui-page-object',query:'Generated original paragraph two'}),{headers});assert.equal(search.status,200);assert.ok((await search.json() as {items:{id:string}[]}).items.some(item=>item.id===material.id));
    const anchors=node.materials.evidenceIds(material.ref),evidence=await node.featureServices.archiveReader.evidence({ids:anchors});assert.ok(evidence.some(record=>record.ocrText.includes(marker)),'actual read-only query reader must expose the generated Android evidence');
    assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n,0);assert.equal(node.materials.list({kind:'mote.activity'}).items.length,0);
    assert.equal(node.store.db.prepare('SELECT reason FROM activity_intake_receipts WHERE capture_id=?').get(capture.id)!.reason,'activity_disabled');
    const page=capture.metadata!.uiPage!;assert.equal(page.version,3);if(page.version!==3)throw Error('Expected current Android named fields');
    writeFileSync(resultPath,JSON.stringify({ok:true,provenance:'actual_android_http_upload',captureId:capture.id,materialId:material.id,version:page.version,fieldCount:page.objects[0]!.fields.length,memberCount:material.memberCount,queryEvidenceIds:evidence.map(record=>record.id),rawRead:true,materialRead:true,searchable:true,noMemoryJobs:true}),{mode:0o600});succeeded=true;break;
  }
  if(!succeeded)throw Error('Timed out waiting for actual generated Android v3 HTTP intake');
}catch(error){writeFileSync(resultPath,JSON.stringify({ok:false,error:error instanceof Error?error.message:'android_central_journey_failed'}),{mode:0o600});throw error;}
finally{await node.app.close();rmSync(directory,{recursive:true,force:true});}
