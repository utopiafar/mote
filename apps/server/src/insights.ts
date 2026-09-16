import sanitizeHtml from 'sanitize-html';
import {z} from 'zod';
import {SKILL_VERSION,validateInlineCitations} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {StoreError} from './store.js';

export type InsightArtifact={id:string;title:string;html:string;createdAt:string;skillId:string;skillVersion:string};
export type InsightResult=QueryResult&{artifact?:InsightArtifact};
const reportSchema=z.object({title:z.string().trim().min(1).max(200),markdown:z.string().trim().min(1).max(60000),html:z.string().trim().min(1).max(120000)}).strict();
export const REPORT_CSP="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'";

/** Static presentation only; real references and controls are rendered by the host. */
export function staticReportHtml(html:string,evidenceIds:string[]):string {
  const targets=new Set(evidenceIds.map(id=>`#evidence-${id}`));
  const clean=sanitizeHtml(html,{
    allowedTags:[...sanitizeHtml.defaults.allowedTags,'html','head','body','style','title','main','section','article','header','footer','aside','figure','figcaption','time','span','div'],
    allowedAttributes:{'*':['class','style','role','aria-label'],a:['href','title'],time:['datetime'],td:['colspan','rowspan'],th:['colspan','rowspan','scope']},
    allowedSchemes:[],allowedSchemesAppliedToAttributes:['href','src'],allowProtocolRelative:false,
    allowVulnerableTags:true,
    transformTags:{a:(_tag,attrs)=>({tagName:'a',attribs:targets.has(attrs.href)?{href:attrs.href,...(attrs.title?{title:attrs.title}:{})}:{}})},
    // All CSS is local presentation. The iframe's CSP independently prevents resource loads.
    exclusiveFilter:frame=>frame.tag==='style'&&(/@import|url\s*\(|expression\s*\(/i.test(frame.text)),
  });
  // Validate what the report actually displays, including references split across
  // formatting tags or encoded as entities. Styles and code examples are not prose.
  const visible=sanitizeHtml(clean,{allowedTags:[],allowedAttributes:{},nonTextTags:['style','script','textarea','option','pre','code']});
  for(const match of visible.matchAll(/\[[^\[\]\n]{1,300}\]/g))validateInlineCitations(match[0],evidenceIds,evidenceIds);
  const policy=`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  return clean.includes('<head>')?clean.replace('<head>',`<head>${policy}`):`<!doctype html><html><head>${policy}</head><body>${clean}</body></html>`;
}

export function insightResult(result:QueryResult):InsightResult {
  let value:unknown;try{value=JSON.parse(result.answer);}catch{return result;}
  const parsed=reportSchema.safeParse(value);
  if(!parsed.success)throw new StoreError('Insight report has an invalid structure; retry generation',502);
  const ids=result.citations.map(c=>c.id);
  validateInlineCitations(parsed.data.markdown,ids,ids);
  return {...result,answer:parsed.data.markdown,artifact:{id:result.runId,title:parsed.data.title,html:staticReportHtml(parsed.data.html,ids),createdAt:new Date().toISOString(),skillId:'personal-insight',skillVersion:SKILL_VERSION}};
}
