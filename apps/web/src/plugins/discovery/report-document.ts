import type {Answer} from '../../api';
import {moteText} from '@mote/shared/i18n';
import designTokens from '../../../../../packages/shared/design-tokens.json';
import lightTokens from '../../../../../packages/shared/design-tokens.light.json';
import {reportSizeScript} from './report-sizing';

// This document contains only the report. The authenticated application's state and
// controls stay outside the opaque-origin iframe.
function displayReportHtml(html:string,citations:Answer['citations'],token?:string):string {
  if (typeof document==='undefined') return html;
  const indexes=new Map(citations.map((citation,index)=>[citation.id,index+1]));
  // A template keeps generated markup inert while we change only visible text nodes.
  // Its serialization normalizes document wrappers, but retains the report's styles and body.
  const template=document.createElement('template');
  template.innerHTML=html;
  // Model-authored attributes never become host navigation markers.
  template.content.querySelectorAll('[data-mote-report-source],[data-mote-report-index]').forEach(element=>{element.removeAttribute('data-mote-report-source');element.removeAttribute('data-mote-report-index');});
  // Central's full-document artifact already contains framework policy metadata.
  // The display document supplies the effective policy before all report content.
  template.content.querySelectorAll('meta[http-equiv="content-security-policy" i]').forEach(meta=>meta.remove());
  const hidden=new Set(['SCRIPT','STYLE','CODE','PRE','TEXTAREA','TITLE','NOSCRIPT','TEMPLATE','SVG','MATH']);
  const walker=document.createTreeWalker(template.content,4);
  const nodes:Node[]=[];let next:Node|null;while((next=walker.nextNode()))nodes.push(next);
  for(const node of nodes) {
    if(!node.nodeValue?.includes('['))continue;
    let ancestor=node.parentElement,skip=false;
    while(ancestor){if(hidden.has(ancestor.tagName.toUpperCase())){skip=true;break;}ancestor=ancestor.parentElement;}
    if(skip)continue;
    if(!token){node.nodeValue=node.nodeValue.replace(/\[([^\]\n]{1,300})\]/g,(marker,id:string)=>{
      const index=indexes.get(id);
      return index===undefined?marker:`（${moteText('来源 {0}',index)}）`;
    });continue;}
    const value=node.nodeValue!,fragment=document.createDocumentFragment();let offset=0,changed=false;
    for(const match of value.matchAll(/\[([^\]\n]{1,300})\]/g)){
      const index=indexes.get(match[1]);if(index===undefined)continue;
      fragment.append(document.createTextNode(value.slice(offset,match.index)));
      const marker=document.createElement('span');marker.setAttribute('data-mote-report-source',token);marker.setAttribute('data-mote-report-index',String(index-1));marker.setAttribute('role','button');marker.setAttribute('aria-label',moteText('来源 {0}',index));marker.tabIndex=0;marker.textContent=String(index);fragment.append(marker);offset=match.index!+match[0].length;changed=true;
    }
    if(changed){fragment.append(document.createTextNode(value.slice(offset)));node.parentNode!.replaceChild(fragment,node);}
  }
  return template.innerHTML;
}

export function reportDocument(html:string,citations:Answer['citations']=[],scheme:'light'|'dark'='light',resize?:{token:string;parentOrigin:string}):string {
  const colors=scheme==='dark'?designTokens:lightTokens;
  const selector=resize?`span[data-mote-report-source="${resize.token}"][data-mote-report-index]`:'';
  // The host badge owns its presentation, including the original touch target.
  // The unpredictable selector and important declarations outrank report styles.
  const sourceStyle=resize?`<style>${selector}{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-width:22px!important;min-height:22px!important;margin-left:5px!important;padding:0 5px!important;border-radius:4px!important;background:${colors.tint}!important;color:${colors.accent}!important;font-size:10px!important;vertical-align:2px!important;line-height:1.5!important;pointer-events:auto!important;cursor:pointer!important}@media(pointer:coarse){${selector}{min-height:32px!important;min-width:30px!important}}</style>`:'';
  // Stored reports may declare a light-only body palette. Adapt their display
  // surface to the owner's dark theme while retaining text, layout and typography.
  // Keep this after authored styles and before the more-specific host badges.
  const themeStyle=scheme==='dark'?`<style>html,body{color:${colors.ink}!important;background-color:${colors.background}!important}body :where(h1,h2,h3,h4,h5,h6,p,li,dt,dd,div,section,article,header,footer,aside,main,span,strong,b,em,i,small,blockquote,pre,code,table,thead,tbody,tfoot,tr,th,td,caption,figcaption,ul,ol,dl,figure){color:inherit!important}body :where(div,section,article,header,footer,aside,main,table,tbody,tfoot,tr,td,ul,ol,dl,figure){background-color:transparent!important}body :where(blockquote,pre,code,thead,th){color:${colors.ink}!important;background-color:${colors.surface}!important;border-color:${colors.border}!important}body a{color:${colors.accent}!important}</style>`:'';
  const policy="default-src 'none'; script-src "+(resize?"'nonce-"+resize.token+"'":"'none'")+"; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><html lang="zh-CN"><head><meta http-equiv="Content-Security-Policy" content="'+policy+'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:'+scheme+'}body{margin:0;padding:0;display:flow-root;font-size:15px;font-family:'+designTokens.font+';color:'+colors.ink+';background:'+colors.background+';line-height:1.95;overflow-wrap:anywhere}p{margin:0 0 18px}h2{font-size:17px;line-height:1.5;margin:24px 0 12px}img,svg{max-width:100%;height:auto}*{box-sizing:border-box}table{max-width:100%}a{color:'+colors.accent+';pointer-events:none}</style></head><body>'+displayReportHtml(html,citations,resize?.token)+themeStyle+sourceStyle+(resize?reportSizeScript(resize.token,resize.parentOrigin):'')+'</body></html>';
}
