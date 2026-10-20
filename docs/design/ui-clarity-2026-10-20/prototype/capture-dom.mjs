#!/usr/bin/env node
// Execute only our generated, self-contained HTML in jsdom. No browser or
// network resources are used. Serialize live form values before static layout.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {JSDOM,VirtualConsole}=require('jsdom');
export const version=require('jsdom/package.json').version;
const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
export const settle=window=>new Promise(resolve=>window.setTimeout(resolve,0));

// This is DOM/style visibility, not viewport layout or visual occlusion.
// In a closed details, only the first summary and its descendants are visible.
export function visibility(document){
 const cache=new WeakMap(),window=document.defaultView;
 return function visible(element){
  if(!element||element.nodeType!==1||!element.isConnected)return false;
  if(cache.has(element))return cache.get(element);
  for(let ancestor=element;ancestor;ancestor=ancestor.parentElement){
   const style=window.getComputedStyle(ancestor);
   if(ancestor.hidden||['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','HEAD'].includes(ancestor.tagName)||style.display==='none'||['hidden','collapse'].includes(style.visibility)||style.contentVisibility==='hidden'||(style.opacity!==''&&Number(style.opacity)===0)||(ancestor.tagName==='DIALOG'&&!ancestor.open)){cache.set(element,false);return false;}
   if(ancestor.tagName==='DETAILS'&&!ancestor.open&&ancestor!==element){
    const summary=[...ancestor.children].find(child=>child.tagName==='SUMMARY');
    if(!summary?.contains(element)){cache.set(element,false);return false;}
   }
  }
  cache.set(element,true);return true;
 };
}

export function visibleText(root,visible=visibility(root.ownerDocument??root)){
 const document=root.ownerDocument??root,walker=document.createTreeWalker(root,document.defaultView.NodeFilter.SHOW_TEXT),parts=[];
 for(let node=walker.nextNode();node;node=walker.nextNode())if(visible(node.parentElement))parts.push(node.nodeValue);
 return normalize(parts.join(' '));
}

export function observe(document){
 const visible=visibility(document),text=element=>element?visibleText(element,visible):'',shown=selector=>[...document.querySelectorAll(selector)].filter(visible);
 const controls=shown('button,a[href],input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[onclick],[tabindex]').map((element,index)=>{
  const labelled=(element.getAttribute('aria-labelledby')??'').split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean).map(text).join(' ');
  const label=normalize(element.getAttribute('aria-label')||labelled||[...(element.labels??[])].map(text).join(' ')||text(element)||element.getAttribute('title')||element.getAttribute('placeholder'));
  const value=['INPUT','TEXTAREA','SELECT'].includes(element.tagName)?(element.type==='password'?'[redacted]':element.value):undefined;
  return {index,tag:element.tagName.toLowerCase(),id:element.id||undefined,role:element.getAttribute('role')||undefined,type:element.type||undefined,label,text:text(element),disabled:element.matches(':disabled')||element.getAttribute('aria-disabled')==='true',href:element.getAttribute('href')||undefined,action:element.getAttribute('data-action')||undefined,page:element.getAttribute('data-page')||undefined,data_id:element.getAttribute('data-id')||undefined,value,checked:['checkbox','radio'].includes(element.type)?element.checked:undefined,expanded:element.tagName==='SUMMARY'?element.parentElement.open:undefined};
 });
 const headings=shown('h1,h2,h3').map(element=>({level:Number(element.tagName.slice(1)),text:text(element)}));
 const feedback=[...new Set(shown('[role="status"],[role="alert"],[aria-live]:not([aria-live="off"]),.toast,.notice').map(text).filter(Boolean))];
 return {active_element:{tag:document.activeElement.tagName.toLowerCase(),id:document.activeElement.id,action:document.activeElement.dataset?.action,label:normalize(document.activeElement.getAttribute('aria-label')||document.activeElement.textContent)},url:document.URL,hash:document.defaultView.location.hash,document_title:document.title,page_title:text(shown('main h1,#main h1')[0]??shown('h1')[0])||document.title,headings,visible_text:text(document.body),feedback,controls};
}

export function createOfflineDom(source,url='https://mote-prototype.invalid/',errors=[]){
 const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message));
 const noNetwork=()=>{throw Error('Network access is disabled in offline DOM evidence');};
 return new JSDOM(source,{url,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,beforeParse(window){const viewport=Number(new URL(url).searchParams.get('viewport')||0);if(viewport>=320&&viewport<=2560){Object.defineProperty(window,'innerWidth',{value:viewport,configurable:true});window.matchMedia=query=>({media:query,matches:(!query.match(/min-width:\s*(\d+)px/)||viewport>=Number(query.match(/min-width:\s*(\d+)px/)[1]))&&(!query.match(/max-width:\s*(\d+)px/)||viewport<=Number(query.match(/max-width:\s*(\d+)px/)[1]))&&(query.includes('width:')),addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});}window.fetch=async()=>noNetwork();window.XMLHttpRequest=class{constructor(){noNetwork();}};window.WebSocket=class{constructor(){noNetwork();}};window.EventSource=class{constructor(){noNetwork();}};window.open=noNetwork;}});
}

function snapshotHtml(document){
 const clone=document.documentElement.cloneNode(true),originalControls=[...document.querySelectorAll('input,textarea,select')],clonedControls=[...clone.querySelectorAll('input,textarea,select')];
 originalControls.forEach((element,index)=>{const snapshot=clonedControls[index];if(element.tagName==='INPUT'){snapshot.setAttribute('value',element.type==='password'?'':element.value);snapshot.toggleAttribute('checked',element.checked);}else if(element.tagName==='TEXTAREA')snapshot.textContent=element.value;else [...snapshot.options].forEach((option,i)=>option.toggleAttribute('selected',element.options[i].selected));});
 clone.querySelectorAll('script').forEach(element=>element.remove());
 const marker=document.createElement('meta');marker.name='mote-dom-snapshot';marker.content='jsdom '+version;clone.querySelector('head').append(marker);
 return '<!doctype html>\n'+clone.outerHTML+'\n';
}

export async function capture(options){
 if(!options.input||!options.output)throw Error('Usage: node capture-dom.mjs --input index.html --actions actions.json --url "https://mote-prototype.invalid/?state=empty&surface=android&theme=dark#/guide" --output snapshot.html');
 const input=resolve(options.input),output=resolve(options.output),source=await readFile(input,'utf8'),hash=createHash('sha256').update(source).digest('hex');
 const errors=[],steps=[],url=options.url??'https://mote-prototype.invalid/',dom=createOfflineDom(source,url,errors);
 let actions=[],failure=null,initial;
 try{
  await settle(dom.window);const document=dom.window.document;initial=observe(document);
  try{
   actions=options.actions?JSON.parse(await readFile(resolve(options.actions),'utf8')):[];
   if(!Array.isArray(actions))throw Error('Actions must be an array');
  }catch(error){failure={stage:'actions',message:error.message};}
  if(!failure)for(const [index,action] of actions.entries()){
   const step={index,action,before:observe(document),status:'passed',assertion:null};
   try{
    const visible=visibility(document),matches=action.selector?[...document.querySelectorAll(action.selector)].filter(visible):[],element=matches[Number(action.index??0)];
    step.visible_matches=matches.length;
    const required=()=>{if(!element)throw Error('Visible DOM selector missing: '+action.selector);return element;};
    const enabled=()=>{const target=required();if(target.matches(':disabled')||target.getAttribute('aria-disabled')==='true'||target.closest('[inert]'))throw Error('Control is disabled: '+action.selector);return target;};
    const assert=(expected,actual,passed)=>{step.assertion={type:action.type,expected,actual,passed};if(!passed)throw Error('Assertion failed: '+action.type+' '+(action.selector??'body'));};
    switch(action.type){
     case 'click':enabled().click();break;
     case 'focus':enabled().focus();break;
     case 'assertFocus':assert(action.selector,document.activeElement?.id||document.activeElement?.getAttribute('data-action'),document.activeElement===required());break;
     case 'fill':case 'select':enabled().value=String(action.value??'');element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));element.dispatchEvent(new dom.window.Event('change',{bubbles:true}));break;
     case 'check':if(!['checkbox','radio'].includes(enabled().type))throw Error('Check action needs a checkbox or radio');if(element.checked!==Boolean(action.checked))element.click();break;
     case 'submit':enabled().dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));break;
     case 'key':(action.selector?enabled():document.body).dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:action.key,shiftKey:!!action.shiftKey,ctrlKey:!!action.ctrlKey,metaKey:!!action.metaKey,bubbles:true,cancelable:true}));break;
     case 'wait':{const milliseconds=Number(action.ms??0);if(!Number.isFinite(milliseconds)||milliseconds<0||milliseconds>5000)throw Error('Offline wait must be 0–5000ms');await new Promise(resolve=>dom.window.setTimeout(resolve,milliseconds));break;}
     case 'assertText':{const actual=visibleText(action.selector?required():document.body,visible);assert(action.text,actual,actual.includes(String(action.text)));break;}
     case 'assertNotText':{const actual=action.selector?(element?visibleText(element,visible):''):visibleText(document.body,visible);assert(action.text,actual,!actual.includes(String(action.text)));break;}
     case 'assertVisible':assert(true,Boolean(element),Boolean(element));break;
     case 'assertCount':{const expected=Number(action.count??action.value);assert(expected,matches.length,matches.length===expected);break;}
     case 'assertValue':{const actual=required().value;assert(String(action.value??''),actual,actual===String(action.value??''));break;}
     default:throw Error('Unsupported offline DOM action: '+action.type);
    }
    await settle(dom.window);
   }catch(error){step.status='failed';step.error=error.message;failure={stage:'action',index,message:error.message};}
   step.after=observe(document);steps.push(step);if(failure)break;
  }
  const final=observe(document),metadata={executor:'jsdom',version,browser_used:false,network_resources_enabled:false,input,input_sha256:hash,candidate_sha256:hash,url,output,actions,steps,initial,final,failure,errors,title:document.title,layout_not_computed:true,viewport_fixture:Number(new URL(url).searchParams.get('viewport'))||null,viewport_note:'Optional width drives matchMedia branching only; jsdom still computes no layout.',visibility_scope:'DOM attributes, computed styles and details/summary; no layout, viewport clipping or occlusion; no internal application state read',status:failure||errors.length?'failed':'passed'};
  await mkdir(dirname(output),{recursive:true});await writeFile(output,snapshotHtml(document));
  await writeFile(output.replace(/\.html?$/i,'')+'.dom.json',JSON.stringify(metadata,null,2)+'\n');
  return metadata;
 }finally{dom.window.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={};
 for(let index=0;index<args.length;index+=2)options[args[index].replace(/^--/,'')]=args[index+1];
 const result=await capture(options);
 console.log(JSON.stringify({executor:'jsdom '+version,actions:result.actions.length,executed:result.steps.length,status:result.status,errors:result.errors.length,candidate_sha256:result.candidate_sha256,output:result.output,browser_used:false}));
 if(result.status==='failed')process.exitCode=1;
}
