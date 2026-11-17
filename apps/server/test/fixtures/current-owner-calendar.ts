import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {currentInstructionFixture,gate,until,type ModelRequest} from './current-owner-instruction.js';
import {GitHubPluginReleases} from '../../src/plugin-release.js';
import {sha256} from '../../src/store.js';

export const calendarEvent={title:'Generated owner calendar appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'Generated room',description:'Generated direct owner instruction only'};
export const calendarInstruction='Create Generated owner calendar appointment in Generated owner calendar on 18 September 2099 from 15:00 to 16:00 UTC, in Generated room, with description Generated direct owner instruction only. This is my explicit instruction to create it now, not a draft or a quoted message.';
export async function currentOwnerCalendarFixture(t:TestContext,respond?:(input:ModelRequest)=>unknown|Promise<unknown>){
 const effects=new Map<string,{id:string;event:unknown}>(),calls:any[]=[];let dropReceipt=false,effectGate:ReturnType<typeof gate>|undefined;
 const endpoint=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const request=JSON.parse(raw);calls.push(request);assert.equal(req.url,'/events');assert.equal(req.method,'POST');assert.equal(request.capability.id,'calendar.manage');assert.equal(request.input.kind,'calendar.create');
  await effectGate?.promise;let event=effects.get(request.operationId);if(!event){event={id:'generated-event-'+request.operationId,event:request.input.event};effects.set(request.operationId,event);}if(dropReceipt){res.destroy();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'succeeded',externalId:event.id}));
 });await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{effectGate?.release();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));});
 const actionProposal=(envelope:any)=>({answer:'Generated current owner calendar request accepted; the real Action receipt determines completion.',citationIds:[],draft:{goal:'Create the generated owner calendar appointment',input:'current-action',action:{kind:'calendar.create',event:calendarEvent,targetId:envelope.ownerActionTargets?.[0]?.id??'11111111-1111-4111-8111-111111111111'}}});
 const f=await currentInstructionFixture(t,respond??(({envelope})=>actionProposal(envelope)));
 const url='http://127.0.0.1:'+(endpoint.address() as {port:number}).port+'/events';
 const code=`export const sdkVersion='0.1.0';export default {apiVersion:1,id:'generated-owner-calendar',sourceKinds:[{kind:'generated.owner-calendar',capabilities:{lifecycle:'external-push',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'push-only',externalWrite:false}}],create(){return{status:()=>({ready:true}),async executeAction(request){const response=await fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});if(!response.ok)throw Error('Generated calendar endpoint failed');return response.json();}};}};`;
 const archive=zipSync({'plugin.mjs':strToU8(code)}),base='https://github.com/generated-fixture/owner-calendar/releases/download/v1/';
 const capability={id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'central-connector',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,completionInMoteOnly:true}};
 const manifest={schemaVersion:1,id:'generated.owner-calendar',name:'Generated owner calendar',version:'1',runtime:'service',entry:'plugin.mjs',archive:{asset:'calendar.zip',sha256:sha256(archive)},contributions:[{id:'generated.owner-calendar.ingress',version:'1',surface:'ingress',runtime:'service',entry:'plugin.mjs',capabilities:['source.connector']}],capabilities:['source.connector','calendar.manage'],actionCapabilities:[capability],configuration:[],dependencies:[],access:['Generated local calendar endpoint only']};
 const releases=new GitHubPluginReleases(f.node.pluginCenter.releases.directory,async address=>{
  if(address.endsWith('/releases/tags/v1'))return{bytes:strToU8(JSON.stringify({tag_name:'v1',draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'calendar.zip',browser_download_url:base+'calendar.zip'}]}))};
  if(address.endsWith('/commits/v1'))return{bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
  if(address===base+'mote-plugin.json')return{bytes:strToU8(JSON.stringify(manifest))};if(address===base+'calendar.zip')return{bytes:archive};throw Error('Unexpected generated release URL');
 });f.node.pluginCenter.releases.resolve=releases.resolve.bind(releases);f.node.pluginCenter.releases.install=releases.install.bind(releases);
 const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
 const preview=await f.api('POST','/api/plugins/resolve',{repository:'generated-fixture/owner-calendar',tag:'v1'});assert.equal(preview.statusCode,200,preview.body);
 const install=await f.api('POST','/api/plugins/install',{...command(f.node.pluginCenter.view().revision),previewId:preview.json().id});assert.equal(install.statusCode,200,install.body);await until(()=>f.node.pluginCenter.view().packages[0]?.state==='installed'?true:undefined,'generated calendar package installed');
 const created=await f.api('POST','/api/plugin-instances',{...command(f.node.pluginCenter.view().revision),packageId:f.node.pluginCenter.view().packages[0].id,name:'Generated owner calendar',scope:'default',configuration:{}});assert.equal(created.statusCode,200,created.body);const instance=created.json();
 const check=await f.api('POST','/api/plugin-instances/'+instance.id+'/check',command(instance.revision));assert.equal(check.statusCode,200,check.body);await until(()=>f.node.pluginCenter.instanceView(instance.id).observed==='ready'?true:undefined,'generated calendar instance checked');
 const enabled=await f.api('POST','/api/plugin-instances/'+instance.id+'/enable',command(f.node.pluginCenter.instanceView(instance.id).revision));assert.equal(enabled.statusCode,200,enabled.body);await until(()=>f.node.pluginCenter.instanceView(instance.id).desired&&f.node.pluginCenter.instanceView(instance.id).observed==='ready'?true:undefined,'generated calendar active');
 const inventory=await f.api('GET','/api/action-capabilities');assert.equal(inventory.statusCode,200,inventory.body);assert.equal(inventory.json().centralConnectors.filter((choice:any)=>choice.capability.id==='calendar.manage').length,1);assert.equal(inventory.json().executionEnabled,false,'installation and enablement do not mint a standing write grant');assert.equal(calls.length,0);
 return{...f,get node(){return f.node;},effects,calls,instance,actionProposal,post:(question=calendarInstruction,clientRequestId=randomUUID(),extra:Record<string,unknown>={})=>f.post(question,clientRequestId,extra),dropReceipt:(value=true)=>{dropReceipt=value;},blockEffect(){effectGate=gate();return effectGate.release;}};
}
