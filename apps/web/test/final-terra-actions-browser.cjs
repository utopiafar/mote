require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
/** Manually selected real Actions missing-time information leg. This runner never installs a plugin,
 * seeds an action, claims an action, supplies a receipt, or retries a mutation.
 *
 * MOTE_UI_FINAL_LIVE=1, MOTE_FINAL_CONNECTION=<0600 root connection JSON>,
 * MOTE_FINAL_ACTION_SCENARIO=<0600 JSON>, MOTE_FINAL_ACTION_OUTPUT=<new directory>.
 * Connection: {generatedOnly:true,origin|serverUrl,token|ownerToken,runId?}.
 * Scenario common: {generatedOnly:true,sessionId,phase,target:{deviceId,
 * calendarId,declarationRevision},source:{sourceId,kind,deviceId,platform},
 * providerInstanceId}. phase=authorize saves enabled discovery while preserving
 * timezone/review devices, then grants only this source, futureInputs=true,
 * existingArchived=false. Root must separately authorize the prospective model
 * source device:<actual input device> before saving a genuine calendar note.
 *
 * Other phases require actionId,kind,expectedEvidenceIds[],hostReportPath,
 * producerRunId. phase=inspect only reads. phase=information additionally requires
 * endWallTime (date/datetime-local) and expectedInformation:{start,end,timeZone};
 * it saves a previously null end exactly once, then observes the existing grant.
 * expectManaged defaults true; semantic uncertainty is never cleared here.
 * phase=receipt requires nativeResultPath from the real Android
 * FinalCalendarJourneyInstrumentedTest.executeSelected and optional
 * priorInformationReportPath for the proposal/model comparison before missing-time completion.
 *
 * Each phase starts a clean hidden browser and preserves Central for other legs.
 * Native CalendarProvider execution is exclusively performed by root's Android
 * leg. complete is Mote-only; a successful HTTP receipt alone is not OS proof.
 */
const {app,BrowserWindow}=require('electron');
const {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,lstatSync,existsSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {isDeepStrictEqual}=require('node:util');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function privateJson(path){assert.equal(typeof path,'string');const info=lstatSync(path);assert.ok(info.isFile()&&!info.isSymbolicLink());assert.equal(info.mode&0o077,0,'Acceptance input must be private');assert.ok(info.size>0&&info.size<20_000_000);return JSON.parse(readFileSync(path,'utf8'));}
const repo=resolve(__dirname,'../../..');
let window,profile,out,base,token,scenario;
const report={schema:1,generatedOnly:true,actualCentralHttp:true,fixtureProposals:false,fixtureAnswers:false,expectedModel:'gpt-6.1-terra',screenshots:[],checks:[],mutations:[],passed:false};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function get(path){const url=new URL(path,base);assert.equal(url.origin,base.origin);const response=await fetch(url,{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200,'Actual read '+path+' returned '+response.status);return response.json();}
function identity(value){return {sourceId:value.sourceId,kind:value.kind,deviceId:value.deviceId,platform:value.platform};}
function same(a,b){return isDeepStrictEqual(a,b);}
function checkSources(action){assert.equal(action.id,scenario.actionId);assert.equal(action.kind,scenario.kind);assert.ok(action.evidence.length);for(const item of action.evidence)assert.ok(scenario.expectedEvidenceIds.includes(item.id),'Action evidence must be one of root-selected generated originals');}
function producer(action){
 const host=privateJson(scenario.hostReportPath);assert.equal(host.generatedOnly,true);assert.equal(host.model,'gpt-6.1-terra');
 const call=host.calls.find(value=>value.runId===scenario.producerRunId);assert.ok(call,'Root must supply the exact genuine producer run');assert.equal(call.status,'completed');assert.equal(call.modelSelection?.provider,'codex');assert.equal(call.modelSelection?.model,'gpt-6.1-terra');if(call.configuration)assert.equal(call.configuration.model,'gpt-6.1-terra');assert.ok(call.nativeModelReceipts?.length);assert.ok(call.nativeModelReceipts.every(value=>value.model==='gpt-6.1-terra'&&value.threadModel==='gpt-6.1-terra'));
 const output=JSON.parse(call.answer);assert.ok(Array.isArray(output.actions),'The real producer answer is calendar-extraction actions JSON');
 const proposed=output.actions.filter(item=>item.kind===action.kind&&item.uncertainty===action.uncertainty&&item.evidence?.length&&item.evidence.every(e=>action.evidence.some(actual=>actual.id===e.id&&actual.quote===e.quote))&&(['calendar.create','calendar.update'].includes(item.kind)?same(item.event,action.event):item.sameAs===action.related?.actionId));
 assert.equal(proposed.length,1,'The supplied persisted proposal must match one exact real model output, not a generated fixture');
 report.producer={agentRunId:call.runId,nativeModelReceipts:call.nativeModelReceipts,model:'gpt-6.1-terra',matchedModelAction:true};
}
async function inventory(){
 const data=await get('/api/action-capabilities');
 const provider=data.providers.find(value=>value.identity.instanceId===scenario.providerInstanceId);assert.ok(provider,'A real installed, checked and enabled provider is required');assert.equal(provider.capability.id,'calendar.manage');assert.equal(provider.capability.version,1);
 const declaration=data.declarations.find(value=>value.deviceId===scenario.target.deviceId&&value.revision===scenario.target.declarationRevision);assert.ok(declaration?.connectionActive&&declaration.permission==='granted');assert.equal(declaration.capability.id,'calendar.manage');assert.equal(declaration.capability.version,1);assert.equal(declaration.calendars.length,1,'Use only the generated LOCAL calendar prepared by the native leg');assert.equal(declaration.calendars[0].id,scenario.target.calendarId);
 const source=data.sources.find(value=>same(identity(value),scenario.source));assert.ok(source,'Root must first create the exact real source catalog identity');
 return {data,provider,declaration,source};
}
function exactGrant(grant,provider){return grant.state==='active'&&grant.available&&same(grant.target,scenario.target)&&same(grant.plugin,provider.identity)&&grant.inputs.sources.length===1&&same(identity(grant.inputs.sources[0]),scenario.source)&&grant.inputs.existingArchived===false&&grant.inputs.futureInputs===true;}
async function run(){
 assert.equal(process.env.MOTE_UI_FINAL_LIVE,'1');
 const connection=privateJson(process.env.MOTE_FINAL_CONNECTION);scenario=privateJson(process.env.MOTE_FINAL_ACTION_SCENARIO);assert.equal(connection.generatedOnly,true);assert.equal(scenario.generatedOnly,true);assert.match(scenario.sessionId,uuid);assert.ok(['authorize','inspect','information','receipt'].includes(scenario.phase));assert.ok(scenario.providerInstanceId);
 base=new URL(connection.origin??connection.serverUrl);assert.equal(base.protocol,'http:');assert.ok(['127.0.0.1','localhost','[::1]'].includes(base.hostname));assert.equal(base.username+base.password+base.search+base.hash,'');assert.ok(base.pathname==='/'&&base.port);token=connection.token??connection.ownerToken;assert.ok(typeof token==='string'&&token.length>=32);
 assert.deepEqual(Object.keys(scenario.source).sort(),['deviceId','kind','platform','sourceId']);assert.ok(Object.values(scenario.source).every(value=>typeof value==='string'&&value.length));assert.deepEqual(Object.keys(scenario.target).sort(),['calendarId','declarationRevision','deviceId']);assert.ok(scenario.target.deviceId&&scenario.target.calendarId&&Number.isSafeInteger(scenario.target.declarationRevision)&&scenario.target.declarationRevision>0);scenario.target={deviceId:scenario.target.deviceId,calendarId:scenario.target.calendarId,declarationRevision:scenario.target.declarationRevision};
 if(scenario.phase!=='authorize'){assert.match(scenario.actionId,uuid);assert.match(scenario.producerRunId,uuid);assert.ok(Array.isArray(scenario.expectedEvidenceIds)&&scenario.expectedEvidenceIds.length);scenario.expectedEvidenceIds.forEach(value=>assert.match(value,uuid));}
 out=resolve(process.env.MOTE_FINAL_ACTION_OUTPUT);mkdirSync(out,{mode:0o700});profile=mkdtempSync(join(tmpdir(),'mote-final-actions-'));app.setPath('userData',profile);app.on('window-all-closed',()=>{});
 Object.assign(report,{revision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sessionId:scenario.sessionId,phase:scenario.phase,actionId:scenario.actionId,target:scenario.target,source:scenario.source});
 const status=await get('/api/status');assert.equal(status.agent.configured,true);assert.equal(status.agent.model,'gpt-6.1-terra');
 const prepared=await inventory();report.provider=prepared.provider.identity;
 await app.whenReady();window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=window.webContents,js=code=>wc.executeJavaScript(code);wc.debugger.attach('1.3');const network=new Map();
 wc.debugger.on('message',(_event,method,params)=>{
  if(method==='Network.requestWillBeSent'&&['POST','PUT','PATCH','DELETE'].includes(params.request.method)){
   const url=new URL(params.request.url);if(url.origin!==base.origin||!/^\/api\/(actions|managed-calendar|action-capability)/.test(url.pathname))return;
   let body;try{body=JSON.parse(params.request.postData);}catch{body=null;}
   const item={method:params.request.method,path:url.pathname,body};network.set(params.requestId,item);report.mutations.push(item);
  }else if(method==='Network.responseReceived'&&network.has(params.requestId))network.get(params.requestId).status=params.response.status;
  else if(method==='Network.loadingFinished'&&network.has(params.requestId)){
   const item=network.get(params.requestId);void wc.debugger.sendCommand('Network.getResponseBody',{requestId:params.requestId}).then(value=>{item.response=JSON.parse(value.base64Encoded?Buffer.from(value.body,'base64').toString('utf8'):value.body);}).catch(error=>{item.responseReadError=String(error);});
  }else if(method==='Network.loadingFailed'&&network.has(params.requestId))network.get(params.requestId).transportError=params.errorText;
 });
 const until=async(check,label,timeout=30000)=>{for(const end=Date.now()+timeout;Date.now()<end;){if(await check())return;await delay(100);}throw Error('Timed out '+label+'; do not resubmit unknown operations');};
 const visible='el.getClientRects().length&&!el.disabled';
 const click=async(label,selector='button')=>{assert.equal(await js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>${visible}&&el.textContent.trim()===${JSON.stringify(label)});if(!el)return false;el.click();return true;})()`),true,'Visible action '+label);await delay(80);};
 const input=async(selector,value)=>{await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||!el.getClientRects().length||el.disabled||el.readOnly)throw Error('Missing editable field');Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(80);};
 const select=async(selector,value,index=0)=>{await js(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!el||!el.getClientRects().length||el.disabled||![...el.options].some(option=>option.value===${JSON.stringify(value)}))throw Error('Missing exact current option');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);await delay(80);};
 const checkLabel=async(selector,label,wanted)=>{await js(`(()=>{const labels=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(el=>el.getClientRects().length&&el.textContent.trim()===${JSON.stringify(label)});if(labels.length!==1)throw Error('Expected one exact label');const box=labels[0].querySelector('input[type=checkbox]');if(!box||box.disabled)throw Error('Missing enabled checkbox');if(box.checked!==${Boolean(wanted)})box.click();})()`);await delay(80);};
 const details=async(selector)=>{await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||!el.getClientRects().length)throw Error('Missing disclosure');if(!el.open)el.querySelector('summary').click();})()`);await delay(80);};
 const route=async hash=>{await js(`location.hash=${JSON.stringify(hash)}`);await until(()=>js(`document.querySelector('.content')?.dataset.session==='ready'&&!document.querySelector('[data-page-loading]')`),'route '+hash);await delay(150);};
 const snap=async name=>{await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false,'Horizontal overflow '+name);writeFileSync(join(out,name+'.png'),(await wc.capturePage()).toPNG(),{mode:0o600});report.screenshots.push({name,route:await js('location.hash')});};
 const receipt=async(path,method)=>{let item;await until(()=>{const entries=report.mutations.filter(value=>value.path===path&&value.method===method);assert.ok(entries.length<=1,'One UI submission only: '+path);item=entries[0];if(item?.transportError||item?.status>=400)throw Error('Actual mutation failed/unknown: '+path+'; retained request is in private report; do not retry');return !!item?.response;},'exact '+method+' receipt '+path);assert.ok(item.status>=200&&item.status<300);return item;};
 await window.loadURL(new URL('/#/today',base).href);await wc.debugger.sendCommand('Network.enable');await until(()=>js(`!!document.querySelector('.content button')`),'owner entry');await click('登录 Mote','.content button');await until(()=>js(`!!document.querySelector('.connect-modal input[type=password]')`),'owner form');await input('.connect-modal input[type=password]',token);await click('登录并继续');await until(()=>js(`document.querySelector('.content')?.dataset.session==='ready'`),'actual owner session');
 if(await js(`!!document.querySelector('.home-action-entry')`)){await js(`document.querySelector('.home-action-entry').click()`);report.entry='actual Home action';}
 else{await route('#/guide');await input('[aria-label="查找功能"]','日程');await until(()=>js(`!!document.querySelector('.guide-unit a[href="#/actions"]')`),'registered Actions entry');await js(`document.querySelector('.guide-unit a[href="#/actions"]').click()`);report.entry='actual registered guide link';}
 await until(()=>js(`!!document.querySelector('.actions-primary-tabs')`),'actual Actions workspace');await click('待办','.actions-primary-tabs button');await snap('todos-entry');await click('日程','.actions-primary-tabs button');await snap('calendar-entry');
 if(scenario.phase==='authorize'){
  assert.equal(prepared.data.grants.filter(value=>value.state==='active').length,0,'Fresh test scope only; never revoke or overlap another grant automatically');
  const before=await get('/api/actions');report.settingsBefore=before.settings;assert.equal(typeof before.settings.timeZone,'string');assert.ok(before.settings.timeZone);
  await click('日程设置');await until(()=>js(`!!document.querySelector('.action-discovery-settings')`),'actual settings');await snap('settings-default');
  if(!before.settings.enabled)await js(`document.querySelector('.action-discovery-settings input[type=checkbox]').click()`);
  await details('.action-discovery-settings details');
  const devices=await get('/api/devices');const device=(devices.items??devices).find(value=>value.deviceId===scenario.target.deviceId);assert.ok(device?.deviceName);
  await checkLabel('.action-discovery-settings label.action-final-check',device.deviceName,true);
  if(!before.settings.enabled||!before.settings.reviewDeviceIds.includes(scenario.target.deviceId)){
   await click('保存设置','.action-discovery-settings button');const saved=await receipt('/api/actions/settings','PUT');assert.equal(saved.body.settings.timeZone,before.settings.timeZone);assert.deepEqual([...saved.body.settings.reviewDeviceIds].sort(),[...new Set([...before.settings.reviewDeviceIds,scenario.target.deviceId])].sort());assert.equal(saved.body.settings.enabled,true);
  }
  const configured=await get('/api/actions');assert.equal(configured.settings.timeZone,before.settings.timeZone);assert.equal(configured.settings.enabled,true);assert.deepEqual([...configured.settings.reviewDeviceIds].sort(),[...new Set([...before.settings.reviewDeviceIds,scenario.target.deviceId])].sort());report.settingsAfter=configured.settings;
  await details('.action-settings-final-dialog details.action-settings');
  const box='.action-settings-final-dialog details.action-settings';
  await select(box+' fieldset select',JSON.stringify(scenario.target));
  await checkLabel(box+' fieldset label',prepared.source.name+' · '+prepared.source.deviceId,true);
  await checkLabel(box+' fieldset label','包括已归档资料',false);await checkLabel(box+' fieldset label','包括授权后新增资料',true);
  await snap('only-generated-future-scope');await click('保存范围草稿',box+' button');const saved=await receipt('/api/action-capability-drafts','PUT');assert.equal(saved.response.id,saved.body.id);assert.deepEqual(saved.body.inputs,{sources:[scenario.source],existingArchived:false,futureInputs:true});assert.deepEqual(saved.body.target,scenario.target);report.draftId=saved.response.id;
  await until(()=>js(`document.querySelectorAll(${JSON.stringify(box+' fieldset select')}).length===2`),'saved current draft provider choice');await select(box+' fieldset select',JSON.stringify(prepared.provider.identity),1);
  const requiredDisclosure=['以上资料范围','指定设备和日历','创建日程','更新或取消原事件','在 Mote 标记完成'];
  const consent=await js(`Array.from(document.querySelectorAll(${JSON.stringify(box+' fieldset label')}))
    .filter(label=>label.getClientRects().length&&label.querySelector('input[type="checkbox"]'))
    .map(label=>label.textContent.trim())
    .find(text=>${JSON.stringify(requiredDisclosure)}.every(term=>text.includes(term)))`);
  assert.ok(consent,'Calendar write acknowledgement discloses its scope, target and effects');
  await checkLabel(box+' fieldset label',consent,true);await snap('explicit-scope-authorization');await click('确认范围授权',box+' button');const granted=await receipt('/api/action-capability-grants','PUT');assert.equal(granted.response.id,granted.body.id);assert.equal(granted.body.draftId,report.draftId);assert.deepEqual(granted.body.plugin,prepared.provider.identity);
  const after=await inventory();const matches=after.data.grants.filter(value=>exactGrant(value,prepared.provider));assert.equal(matches.length,1);report.grant=matches[0];await snap('real-grant-confirmed');report.checks.push('Actual owner UI enabled discovery without changing timezone or removing prior review devices, then explicitly granted one real generated source and LOCAL target for future input only');
 }else{
  const grants=prepared.data.grants.filter(value=>exactGrant(value,prepared.provider));assert.equal(grants.length,1,'The one exact prospective grant must already exist');report.grant=grants[0];
  let action=await get('/api/actions/'+scenario.actionId);checkSources(action);let modelProposal=action;
  if(scenario.priorInformationReportPath){const prior=privateJson(scenario.priorInformationReportPath);assert.equal(prior.sessionId,scenario.sessionId);assert.equal(prior.actionId,action.id);assert.ok(prior.passed&&prior.beforeAction);modelProposal=prior.beforeAction;}
  producer(modelProposal);report.beforeAction=action;
  await route('#/actions?tab=calendar&action='+encodeURIComponent(action.id));await until(()=>js(`!!document.querySelector('.calendar-final-detail')`),'exact proposal detail');assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('action')`),action.id);await snap('exact-real-proposal');
  await details('.action-final-proof');for(const item of action.evidence){const original=await get('/api/capture-browser/'+encodeURIComponent(item.id));assert.ok(original.ocrText.includes(item.quote),'Each stored action quote must match its real original bytes');}
  await js(`document.querySelector('.action-final-proof button').click()`);await until(()=>js(`!!document.querySelector('.evidence-modal')`),'exact original reader');const original=await get('/api/capture-browser/'+action.evidence[0].id);await until(()=>js(`document.querySelector('.evidence-text pre')?.textContent===${JSON.stringify(original.ocrText)}`),'exact complete original bytes');await snap('action-original');await js(`document.querySelector('[aria-label="关闭证据详情"]').click()`);assert.equal(await js(`new URLSearchParams(location.hash.split('?')[1]).get('action')`),action.id);
  if(scenario.phase==='information'){
   assert.ok(['calendar.create','calendar.update'].includes(action.kind));assert.equal(action.status,'proposed');assert.equal(action.event.end,null);assert.ok(action.event.start&&action.event.timeZone&&!action.managed&&!action.operationId&&!action.resolution);assert.ok(scenario.endWallTime&&scenario.expectedInformation);
   assert.equal(scenario.expectedInformation.start,action.event.start);assert.equal(scenario.expectedInformation.timeZone,action.event.timeZone);
   await click('补充时间','.calendar-time-information button');assert.equal(await js(`document.querySelector('.calendar-information-start').readOnly`),true);await input('.calendar-information-end',scenario.endWallTime);await snap('missing-end-draft');await click('保存信息','.calendar-information-form button');const saved=await receipt('/api/actions/'+action.id+'/information','POST');assert.deepEqual(saved.body,{version:action.version,...scenario.expectedInformation});assert.equal(saved.response.id,action.id);assert.equal(saved.response.version,action.version+1);assert.equal(saved.response.status,'proposed');
   for(const key of ['title','allDay','location','description'])assert.deepEqual(saved.response.event[key],action.event[key]);for(const key of ['evidence','related','uncertainty'])assert.deepEqual(saved.response[key],action[key]);report.savedInformation=saved.response;await snap('information-actual-ack');
   if(scenario.expectManaged!==false){assert.equal(action.uncertainty,'','Semantic uncertainty is not cleared by H11');await until(async()=>{action=await get('/api/actions/'+scenario.actionId);if(['stale','uncertain'].includes(action.status))throw Error('Dispatch requires actual recovery; do not confirm/retry');return action.managed?.grantId===report.grant.id&&['approved','executing','succeeded'].includes(action.status);},'existing grant automatic reevaluation',Number(scenario.observeTimeoutMs??60000));assert.deepEqual(action.target,{deviceId:scenario.target.deviceId,calendarId:scenario.target.calendarId});report.checks.push('One actual information POST preserved known and non-time facts; existing owner grant automatically reevaluated without manual confirmation');}
   else{assert.ok(action.uncertainty,'The negative leg must retain an actual semantic uncertainty');const originalUncertainty=action.uncertainty;const observeUntil=Date.now()+3000;do{action=await get('/api/actions/'+scenario.actionId);assert.equal(action.uncertainty,originalUncertainty);assert.equal(action.status,'proposed');assert.ok(!action.managed&&!action.operationId&&!action.resolution,'Saving missing time must not authorize an uncertain arrangement');await delay(150);}while(Date.now()<observeUntil);report.checks.push('During a bounded post-save observation, the original uncertainty remained unchanged and the action stayed proposed with no managed dispatch, operation or resolution');}
   report.afterAction=action;await click('刷新状态','.calendar-final-detail button');await snap('information-result-authoritative');
  }else if(scenario.phase==='receipt'){
   const native=privateJson(scenario.nativeResultPath);assert.equal(native.generatedOnly,true);assert.equal(native.sessionId,scenario.sessionId);assert.equal(native.deviceId,scenario.target.deviceId);assert.equal(native.onlySelectedIds,true);assert.equal(native.realModelInvokedByTest,false);
   const found=native.results.filter(value=>value.id===action.id&&value.kind===action.kind);assert.equal(found.length,1);const actual=found[0];assert.equal(actual.calendarId,scenario.target.calendarId);assert.equal(actual.receipt.operationId,action.operationId);assert.equal(actual.receipt.status,'succeeded');assert.equal(action.status,'succeeded');assert.equal(action.managed.grantId,report.grant.id);
   if(action.kind==='calendar.complete'){assert.equal(action.related?.externalId,actual.nativeExternalId);assert.equal(actual.osMutationClaimed,false);assert.ok(actual.nativeEventPresent);report.checks.push('Actual native observer reports Mote-only completion, retaining the original related calendar event, with no claimed OS mutation');}
   else{assert.equal(action.externalId,actual.nativeExternalId);assert.equal(actual.osMutationClaimed,true);assert.equal(actual.nativeEventPresent,action.kind!=='calendar.cancel');report.checks.push('Real Android selected executor and CalendarProvider evidence match this exact action/operation/calendar receipt');}
   report.nativeResult=actual;report.afterAction=action;await snap('actual-native-receipt');
  }else report.checks.push('Read-only exact root-selected proposal, genuine model output and its original/return inspected; no action mutation performed');
 }
 const allowed=new Set(scenario.phase==='authorize'?['PUT /api/actions/settings','PUT /api/action-capability-drafts','PUT /api/action-capability-grants']:scenario.phase==='information'?['POST /api/actions/'+scenario.actionId+'/information']:[]);for(const mutation of report.mutations)assert.ok(allowed.has(mutation.method+' '+mutation.path),'No manual confirm, claim, receipt, replay or unexpected action write');
 report.passed=true;
}
async function finish(code){
 if(window&&!window.isDestroyed())window.destroy();if(profile)rmSync(profile,{recursive:true,force:true});report.cleanup={windowDestroyed:!window||window.isDestroyed(),temporaryProfileRemoved:!profile||!existsSync(profile),centralRetainedForNativeLeg:true};
 if(out)writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:report.passed,phase:report.phase,actionId:report.actionId,screenshots:report.screenshots.length,output:out,error:report.error}));app.exit(code);
}
run().then(()=>finish(0)).catch(async error=>{report.error=String(error);if(window&&!window.isDestroyed()&&out){try{writeFileSync(join(out,'failure.png'),(await window.webContents.capturePage()).toPNG(),{mode:0o600});}catch{}}await finish(1);});
