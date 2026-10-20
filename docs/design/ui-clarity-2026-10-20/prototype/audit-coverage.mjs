#!/usr/bin/env node
// Open every authored feature through its visible guide button. This collects
// route evidence; it deliberately does not certify the feature's operations.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createOfflineDom,observe,visibility,visibleText,settle,version} from './capture-dom.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
const quote=value=>JSON.stringify(String(value));
const locationEvidence=observation=>({url:observation.url,hash:observation.hash,page_title:observation.page_title});

// Expectations come from the authored catalog file, not running-app variables.
function authoredUnits(source){
 const marker='export const guideSections:GuideSection[] =',offset=source.indexOf(marker);
 if(offset<0)throw Error('Authored feature catalog marker missing');
 const start=source.indexOf('[',offset+marker.length);let depth=0,string=false,escaped=false,end=start;
 for(;end<source.length;end++){
  const char=source[end];
  if(string){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')string=false;}
  else if(char==='"')string=true;
  else if(char==='[')depth++;
  else if(char===']'&&--depth===0)break;
 }
 return JSON.parse(source.slice(start,end+1)).flatMap(section=>section.groups.flatMap(group=>group.units.map(unit=>({...unit,section:section.title,group:group.title}))));
}

async function openUnit(source,url,expected){
 const errors=[],steps=[],dom=createOfflineDom(source,url,errors);
 const result={id:expected.id,expected:{title:expected.title,purpose:expected.purpose,actions:expected.actions,section:expected.section,group:expected.group},steps,route_reachability:{status:'not_attempted'},action_semantics:{status:'unverified',operation_performed:false,reason:'Only the directory entry is opened. Visible labels and a reachable page do not establish that its declared operations work.',exact_label_observations:[]},errors};
 try{
  await settle(dom.window);const document=dom.window.document;
  const rowSelector='[data-feature-id='+quote(expected.id)+']';
  let row=document.querySelector(rowSelector);
  const buttonSelector='button[data-action="open-feature"][data-id='+quote(expected.id)+']';
  let button=row?.querySelector(buttonSelector)??document.querySelector(buttonSelector);
  if(!button)throw Error('Directory open button missing for '+expected.id);
  const closed=[];for(let ancestor=button.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS'&&!ancestor.open)closed.unshift(ancestor);
  for(const details of closed){
   const summary=[...details.children].find(child=>child.tagName==='SUMMARY');
   if(!summary||!visibility(document)(summary))throw Error('The directory group summary is not visible for '+expected.id);
   const before=observe(document),label=visibleText(summary);summary.click();await settle(dom.window);
   const after=observe(document);steps.push({action:'click_summary',label,before:locationEvidence(before),after:locationEvidence(after),assertion:{type:'details_open',expected:true,actual:details.open,passed:details.open}});
   if(!details.open)throw Error('Directory disclosure did not open for '+expected.id);
  }
  row=document.querySelector(rowSelector);button=row?.querySelector(buttonSelector)??document.querySelector(buttonSelector);
  if(!button||!visibility(document)(button))throw Error('Directory button is hidden for '+expected.id);
  if(button.matches(':disabled')||button.getAttribute('aria-disabled')==='true')throw Error('Directory button is disabled for '+expected.id);
  result.entry={label:visibleText(button),visible_text:row?visibleText(row):visibleText(button),selector:buttonSelector};
  const before=observe(document);button.click();await settle(dom.window);
  const after=observe(document),visible=visibility(document),dialogs=[...document.querySelectorAll('[role="dialog"],dialog')].filter(visible).map(element=>({label:element.getAttribute('aria-label')??'',text:visibleText(element,visible)}));
  result.target={...after,main_text:visibleText(document.querySelector('main,#main')??document.body,visible),dialogs};
  const changed=after.hash!==before.hash||after.page_title!==before.page_title||dialogs.length>0;
  const reached=Boolean(after.page_title)&&changed&&errors.length===0;
  result.route_reachability={status:reached?'reachable':'no_observed_destination',before:locationEvidence(before),after:locationEvidence(after),location_changed:after.hash!==before.hash,title_changed:after.page_title!==before.page_title,visible_dialog_opened:dialogs.length>0};
  steps.push({action:'click_open',selector:buttonSelector,label:result.entry.label,before:locationEvidence(before),after:locationEvidence(after),feedback:after.feedback,assertion:{type:'visible_destination_observed',expected:true,actual:reached,passed:reached}});
  result.action_semantics.exact_label_observations=(expected.actions??[]).map(action=>({declared_action:action,controls:after.controls.filter(control=>normalize(control.label)===normalize(action)).map(control=>({tag:control.tag,type:control.type,label:control.label,disabled:control.disabled,action:control.action}))}));
 }catch(error){
  result.route_reachability={...result.route_reachability,status:'entry_or_click_error',error:error.message};
  result.target=observe(dom.window.document);result.failure=error.message;
 }finally{dom.window.close();}
 return result;
}

export async function auditCoverage(options){
 if(!options.input||!options.output)throw Error('Usage: node audit-coverage.mjs --input dist/rounds/r00.html --output evidence/r00/coverage.dom.json [--url "https://mote-prototype.invalid/?state=populated&surface=web&theme=light#/guide"] [--units C12,A32]');
 const input=resolve(options.input),output=resolve(options.output),source=await readFile(input,'utf8');
 const manifestPath=resolve(options.manifest??resolve(root,'../feature-manifest.json'));
 const catalogPath=resolve(options['guide-source']??resolve(root,'../../../../apps/web/src/feature-guide-catalog.ts'));
 const manifest=JSON.parse(await readFile(manifestPath,'utf8')),authored=authoredUnits(await readFile(catalogPath,'utf8'));
 const ids=manifest.guide_groups.flatMap(group=>group.units.map(unit=>unit.id));
 if(ids.length!==78||new Set(ids).size!==78)throw Error('Expected 78 unique authored directory units');
 const byId=new Map(authored.map(unit=>[unit.id,unit]));
 if(ids.some(id=>!byId.has(id)))throw Error('Manifest and authored catalog do not contain the same units');
 const selected=options.units?options.units.split(',').filter(Boolean):ids;
 if(selected.some(id=>!ids.includes(id))||new Set(selected).size!==selected.length)throw Error('Unknown or repeated requested unit ID');
 const startUrl=new URL(options.url??'https://mote-prototype.invalid/?reset=1');startUrl.hash='/guide';
 const report={executor:'jsdom',version,browser_used:false,network_resources_enabled:false,internal_state_read:false,layout_not_computed:true,input,candidate_sha256:createHash('sha256').update(source).digest('hex'),manifest:manifestPath,expected_actions_source:catalogPath,url:startUrl.href,status:'running',coverage_pass:null,scope:'Actual clicks of visible guide summaries and unit open buttons; route reachability only. Action semantics remain unverified until the declared operations are exercised and their visible outcomes assessed.',expected_unit_count:ids.length,selected_unit_count:selected.length,units:[]};
 await mkdir(dirname(output),{recursive:true});
 const save=async()=>{
  report.summary={attempted:report.units.length,route_reachable:report.units.filter(unit=>unit.route_reachability.status==='reachable').length,route_not_reached:report.units.filter(unit=>unit.route_reachability.status!=='reachable').length,semantic_verified:0,semantic_unverified:report.units.length,coverage_pass:null};
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
 };
 for(const id of selected){
  report.units.push(await openUnit(source,startUrl.href,byId.get(id)));
  if(report.units.length%10===0){await save();console.log(JSON.stringify({attempted:report.units.length,selected:selected.length,route_reachable:report.summary.route_reachable,semantic_verified:0}));}
 }
 report.status='completed';await save();return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={};for(let index=0;index<args.length;index+=2)options[args[index].replace(/^--/,'')]=args[index+1];
 const report=await auditCoverage(options);
 console.log(JSON.stringify({status:report.status,candidate_sha256:report.candidate_sha256,output:resolve(options.output),...report.summary}));
 if(report.summary.route_not_reached)process.exitCode=1;
}
