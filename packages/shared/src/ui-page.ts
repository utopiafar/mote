import { z } from 'zod';
import {uiStructureHash} from './ui-structure-hash.js';

const short = z.string().min(1).max(300);
const nonblank = (max: number) => z.string().max(max).refine(value => value.trim().length > 0, 'Blank fields are not allowed');
const observedAt = z.string().max(64).datetime({offset: true});
const pageUrl = nonblank(2000).refine(value => {
  try { const url = new URL(value); return /^https?:\/\/[A-Za-z0-9.\[\]:-]+(?:[/?#]|$)/.test(value) && !/\s/.test(value) && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; }
}, 'Only observed HTTP(S) page links are allowed');
export const uiSelectorSchema = z.object({
  resourceId: short.optional(), role: short.optional(), textEquals: z.string().max(500).optional(),
}).strict().refine(selector => Object.keys(selector).length > 0, 'Empty selectors are not allowed');
const ruleBase = {
  id: short, version: short, platform: z.enum(['android', 'macos']), appId: short,
  activity: short.optional(), required: z.array(uiSelectorSchema).max(8).default([]),
};
export const uiFieldRuleSchema = z.object({
  select: uiSelectorSchema, ancestor: uiSelectorSchema.optional(), required: z.boolean().default(false),
  childPath: z.array(z.number().int().min(0).max(4095)).min(1).max(24).optional(),
}).strict();
export const uiNamedFieldRuleSchema = uiFieldRuleSchema.extend({
  childPath:z.array(z.number().int().min(0).max(4095)).max(24).optional(),
  source: z.enum(['text', 'description', 'state']).default('text'),
  cardinality: z.enum(['one', 'many']).default('one'),
});
export const uiNamedRuleSchema = z.object({
  ...ruleBase, formatVersion: z.literal(3), appVersion: nonblank(300), kind: nonblank(100),
  region: uiSelectorSchema.optional(), repeat: uiSelectorSchema.optional(), repeatParent: uiSelectorSchema.optional(),
  repeatSubtreeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  fields: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/), uiNamedFieldRuleSchema),
}).strict().superRefine((r, ctx) => {
  if (Object.keys(r.fields).length < 1 || Object.keys(r.fields).length > 32) ctx.addIssue({code:'custom',message:'Expected 1..32 named fields'});
  if (r.repeatParent && !r.repeat || r.repeatSubtreeHash && !r.repeat) ctx.addIssue({code:'custom',message:'Repeated guards require a repeat selector'});
  if (!r.region && !r.repeat && Object.values(r.fields).some(f=>f.childPath)) ctx.addIssue({code:'custom',message:'Paths require a scoped region or repeat'});
});
export type UiNamedRule = z.infer<typeof uiNamedRuleSchema>;
export const uiRuleSchema = uiNamedRuleSchema;
export const uiRulesSchema = z.array(uiRuleSchema).max(512)
  .refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs')
  .refine(rules => new TextEncoder().encode(JSON.stringify(rules)).length <= 1048576, 'Rule pack exceeds 1 MiB');
export const uiModeSchema = z.enum(['screen_only', 'hybrid', 'ui_preferred', 'page_only']);
export type UiMode = z.infer<typeof uiModeSchema>;
export type UiRule = z.infer<typeof uiRuleSchema>;
export type UiSelector = z.infer<typeof uiSelectorSchema>;
const boundsSchema = z.object({x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive()}).strict();
const nodeBase = {id: short, resourceId: z.string().max(300), role: z.string().max(300), bounds: boundsSchema};
export const uiNodeSchema = z.object({...nodeBase, parentId: short.optional(), childIndex: z.number().int().min(0).max(4095).optional(), text: z.string().max(32000), description: z.string().max(32000).optional(), state: z.string().max(1000).optional()}).strict();
export const uiSnapshotSchema = z.object({
  appId: short, appVersion: z.string().max(300), activity: z.string().max(300), observedAt: observedAt.optional(),
  nodes: z.array(uiNodeSchema).max(256), truncated: z.boolean(),
}).strict().superRefine((snapshot, ctx) => {
  const ids = new Set<string>();
  for (const node of snapshot.nodes) {
    if (ids.has(node.id) || node.parentId && !ids.has(node.parentId)) ctx.addIssue({code: 'custom', message: 'Invalid node tree'});
    ids.add(node.id);
  }
  if (snapshot.nodes.reduce((sum, node) => sum + node.text.length, 0) > 32000) ctx.addIssue({code: 'custom', message: 'UI text exceeds budget'});
});
export type UiSnapshot = z.infer<typeof uiSnapshotSchema>;
const pageBase = {
  scope: z.literal('visible_window'), adapterId: short, adapterVersion: short,
  appVersion: z.string().max(300), activity: z.string().max(300), status: z.enum(['ok', 'partial']), truncated: z.boolean(),
};
export const uiContentObjectSchema = z.object({
  kind: z.enum(['article', 'product']), title: nonblank(2000), author: nonblank(1000).optional(),
  url: pageUrl.optional(), itemId: nonblank(1000).optional(),
  body: z.array(z.object({text: nonblank(32000)}).strict()).max(64),
  identity: z.object({type: z.enum(['url', 'source_id']), value: nonblank(2000)}).strict().optional(),
}).strict().superRefine((object, ctx) => {
  if (object.kind === 'article' && object.body.length === 0) ctx.addIssue({code: 'custom', path: ['body'], message: 'Articles require observed body text'});
  if (object.identity && (object.identity.type === 'source_id' ? object.identity.value !== object.itemId : object.identity.value !== object.url)) ctx.addIssue({code: 'custom', path: ['identity'], message: 'Object identity must come from its observed source ID or URL'});
});
export type UiContentObject = z.infer<typeof uiContentObjectSchema>;
export const uiNamedValueSchema = z.object({text: nonblank(32000), source:z.enum(['text','description','ocr','state'])}).strict();
export const uiNamedObjectSchema = z.object({
  kind: nonblank(100), fields: z.array(z.object({name:z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),values:z.array(uiNamedValueSchema).min(1).max(64)}).strict()).min(1).max(32),
}).strict().superRefine((o,ctx)=>{
  if(new Set(o.fields.map(f=>f.name)).size!==o.fields.length)ctx.addIssue({code:'custom',message:'Duplicate named fields'});
  if(o.fields.reduce((n,f)=>n+f.values.length,0)>128 || o.fields.reduce((n,f)=>n+f.values.reduce((m,v)=>m+v.text.length,0),0)>64000)ctx.addIssue({code:'custom',message:'Named fields exceed budget'});
});
export const uiPageV3Schema=z.object({
 ...pageBase,version:z.literal(3),observations:z.object({firstAt:observedAt,lastAt:observedAt,count:z.number().int().min(1).max(256)}).strict(),objects:z.array(uiNamedObjectSchema).length(1),
}).strict().superRefine((p,ctx)=>{if(Date.parse(p.observations.firstAt)>Date.parse(p.observations.lastAt)||p.truncated&&p.status==='ok')ctx.addIssue({code:'custom',message:'Invalid structured observation'});});
export const uiPageSchema = uiPageV3Schema;
export type UiPage = z.infer<typeof uiPageSchema>;
export type UiPageV3 = z.infer<typeof uiPageV3Schema>;
export function uiPageText(page: UiPage): string {
  return page.objects.flatMap(o=>o.fields.flatMap(f=>f.values.map(v=>v.text))).join('\n');
}
export function namedPage(snapshot:UiSnapshot,rule:{id:string;version:string;kind:string},fields:z.infer<typeof uiNamedObjectSchema>['fields'],at:string,truncated=snapshot.truncated):UiPageV3 {
 return uiPageV3Schema.parse({version:3,scope:'visible_window',adapterId:rule.id,adapterVersion:rule.version,appVersion:snapshot.appVersion,activity:snapshot.activity,status:truncated?'partial':'ok',truncated,observations:{firstAt:at,lastAt:at,count:1},objects:[{kind:rule.kind,fields:[...fields].sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)}]});
}
export function matchesUi(node: UiSnapshot['nodes'][number], selector: UiSelector): boolean {
  return (selector.resourceId === undefined || node.resourceId === selector.resourceId) &&
    (selector.role === undefined || node.role === selector.role) && (selector.textEquals === undefined || node.text === selector.textEquals);
}
/** Structural field mapping only. This function does not infer topics, intent, authors or attention. */
export function extractUiPages(snapshot: UiSnapshot, rules: UiRule[], platform: 'android' | 'macos', at = snapshot.observedAt): UiPage[] {
  if (!at || !observedAt.safeParse(at).success) return [];
  const accumulated:UiPageV3[]=[];
  for (const rule of rules) {
    if (rule.platform !== platform || rule.appId !== snapshot.appId || rule.activity !== undefined && rule.activity !== snapshot.activity || rule.appVersion !== snapshot.appVersion) continue;
    if (!rule.required.every(selector => snapshot.nodes.some(node => matchesUi(node, selector)))) continue;
    accumulated.push(...extractNamedPages(snapshot,rule,at));
    if (accumulated.length>=64) break;
  }
  return accumulated.slice(0,64).map(p=>accumulated.length>=64?{...p,status:'partial' as const,truncated:true}:p);
}

function extractNamedPages(snapshot:UiSnapshot,rule:UiNamedRule,at:string):UiPageV3[]{
 const nodes=snapshot.nodes,byId=new Map(nodes.map(n=>[n.id,n]));
 const children=(id:string)=>nodes.filter(n=>n.parentId===id).sort((a,b)=>(a.childIndex??nodes.indexOf(a))-(b.childIndex??nodes.indexOf(b)));
 const hashes=new Map<string,string>();
 const hash=(id:string,depth=0):string=>{if(depth>32)return '';const found=hashes.get(id);if(found)return found;const n=byId.get(id)!;const h=uiStructureHash(JSON.stringify([n.resourceId,n.role,children(id).map(c=>hash(c.id,depth+1))]));hashes.set(id,h);return h;};
 const under=(node:UiSnapshot['nodes'][number],root?:string)=>{let n:typeof node|undefined=node;for(let i=0;n&&i<1024;i++){if(n.id===root||!root)return true;n=n.parentId?byId.get(n.parentId):undefined;}return false;};
 const regions=rule.region?nodes.filter(n=>matchesUi(n,rule.region!)):[];if(rule.region&&regions.length!==1)return [];
 const region=regions[0];
 const roots=rule.repeat?nodes.filter(n=>under(n,region?.id)&&matchesUi(n,rule.repeat!)&&(!rule.repeatParent||n.parentId&&byId.get(n.parentId)&&matchesUi(byId.get(n.parentId)!,rule.repeatParent))&&(!rule.repeatSubtreeHash||hash(n.id)===rule.repeatSubtreeHash)):[region];
 const result:UiPageV3[]=[];
 for(const root of roots.slice(0,16)){
  const fields:z.infer<typeof uiNamedObjectSchema>['fields']=[];let failed=false,clipped=false,count=0,budget=64000;
  for(const [name,field] of Object.entries(rule.fields).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0)){
   let target:UiSnapshot['nodes'][number]|undefined=root;for(const index of field.childPath??[]){target=target?children(target.id).find(c=>c.childIndex===index):undefined;}
   let selected=nodes.filter(n=>under(n,root?.id)&&under(n,region?.id)&&(!field.childPath||target?.id===n.id)&&matchesUi(n,field.select));
   if(field.ancestor)selected=selected.filter(n=>{let parent=n.parentId?byId.get(n.parentId):undefined;for(let i=0;parent&&i<32;i++){if(matchesUi(parent,field.ancestor!))return true;if(parent.id===root?.id)break;parent=parent.parentId?byId.get(parent.parentId):undefined;}return false;});
   const source=field.source;const values=selected.map(n=>source==='description'?n.description:source==='state'?n.state:n.text).filter((v):v is string=>Boolean(v?.trim()));
   if(field.cardinality==='one'&&values.length!==1){if(field.required)failed=true;continue;}
   const accepted: {text:string;source:typeof source}[]=[];
   for(const value of values){if(accepted.length>=64||count>=128||budget<=0){clipped=true;break;}let end=Math.min(value.length,32000,budget);if(end<value.length&&end>0&&/[\uD800-\uDBFF]/.test(value[end-1]))end--;const text=value.slice(0,end);if(text.length<value.length)clipped=true;if(!text.trim()){clipped=true;break;}accepted.push({text,source});count++;budget-=text.length;}
   if(!accepted.length){if(field.required)failed=true;}else fields.push({name,values:accepted});
  }
  if(!failed&&fields.length)result.push(namedPage(snapshot,rule,fields,at,snapshot.truncated||clipped||roots.length>16));
 }
 return result;
}
