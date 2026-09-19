import { z } from 'zod';

const short = z.string().min(1).max(300);
export const uiSelectorSchema = z.object({
  resourceId: short.optional(), role: short.optional(), textEquals: z.string().max(500).optional(),
}).strict().refine(s => Object.keys(s).length > 0, 'Empty selectors are not allowed');
export const uiRuleSchema = z.object({
  id: short, version: short, platform: z.enum(['android','macos']), appId: short,
  activity: short.optional(), appVersion: short.optional(),
  required: z.array(uiSelectorSchema).max(8).default([]),
  select: uiSelectorSchema, ancestor: uiSelectorSchema.optional(),
  complete: z.boolean().default(false),
}).strict();
export const uiRulesSchema = z.array(uiRuleSchema).max(32).refine(r => new Set(r.map(x=>x.id)).size === r.length, 'Duplicate rule IDs').refine(r=>new TextEncoder().encode(JSON.stringify(r)).length<=65536,'Rule pack exceeds 64 KiB');
export const uiModeSchema = z.enum(['screen_only','hybrid','ui_preferred','page_only']);
export type UiMode=z.infer<typeof uiModeSchema>;
export type UiRule = z.infer<typeof uiRuleSchema>;
export type UiSelector = z.infer<typeof uiSelectorSchema>;
const boundsSchema = z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().positive(),height:z.number().positive()}).strict();
export const uiNodeSchema = z.object({
  id:short, parentId:short.optional(), resourceId:z.string().max(300), role:z.string().max(300),
  text:z.string().max(2000), bounds:boundsSchema,
}).strict();
export const uiSnapshotSchema = z.object({
  appId:short, appVersion:z.string().max(300), activity:z.string().max(300),
  nodes:z.array(uiNodeSchema).max(256), truncated:z.boolean(),
}).strict().superRefine((s,ctx)=>{
  const ids=new Set<string>();
  for(const n of s.nodes){if(ids.has(n.id)||n.parentId&&!ids.has(n.parentId))ctx.addIssue({code:'custom',message:'Invalid node tree'});ids.add(n.id);}
  if(s.nodes.reduce((n,v)=>n+v.text.length,0)>32000)ctx.addIssue({code:'custom',message:'UI text exceeds budget'});
});
export type UiSnapshot=z.infer<typeof uiSnapshotSchema>;
export const uiPageSchema=z.object({
  version:z.literal(1), scope:z.literal('visible_window'), adapterId:short, adapterVersion:short,
  appVersion:z.string().max(300), activity:z.string().max(300), status:z.enum(['ok','partial']),
  truncated:z.boolean(), nodes:z.array(uiNodeSchema.omit({parentId:true})).min(1).max(256),
}).strict().superRefine((p,ctx)=>{
  if(new Set(p.nodes.map(n=>n.id)).size!==p.nodes.length || p.nodes.reduce((s,n)=>s+n.text.length,0)>32000 || p.truncated&&p.status==='ok')ctx.addIssue({code:'custom',message:'Invalid page evidence'});
});
export type UiPage=z.infer<typeof uiPageSchema>;
export function uiPageText(page:UiPage):string {return page.nodes.map(n=>n.text).join('\n');}
export function matchesUi(node:UiSnapshot['nodes'][number], selector:UiSelector):boolean {
  return (selector.resourceId===undefined||node.resourceId===selector.resourceId)&&
    (selector.role===undefined||node.role===selector.role)&&(selector.textEquals===undefined||node.text===selector.textEquals);
}
/** Structural extraction only. No inference of topics, authors, intent or user attention. */
export function extractUiPage(snapshot:UiSnapshot, rules:UiRule[], platform:'android'|'macos'):UiPage|undefined {
  const byId=new Map(snapshot.nodes.map(n=>[n.id,n]));
  for(const rule of rules){
    if(rule.platform!==platform||rule.appId!==snapshot.appId||rule.activity!==undefined&&rule.activity!==snapshot.activity||rule.appVersion!==undefined&&rule.appVersion!==snapshot.appVersion)continue;
    if(!rule.required.every(s=>snapshot.nodes.some(n=>matchesUi(n,s))))continue;
    const nodes=snapshot.nodes.filter(n=>{
      if(!n.text.trim()||!matchesUi(n,rule.select))return false;
      if(!rule.ancestor)return true;
      let parent=n.parentId; for(let depth=0;parent&&depth<32;depth++){const p=byId.get(parent);if(!p)break;if(matchesUi(p,rule.ancestor))return true;parent=p.parentId;}return false;
    }).map(({parentId:_,...node})=>node);
    if(nodes.length)return uiPageSchema.parse({version:1,scope:'visible_window',adapterId:rule.id,adapterVersion:rule.version,appVersion:snapshot.appVersion,activity:snapshot.activity,status:rule.complete&&!snapshot.truncated?'ok':'partial',truncated:snapshot.truncated,nodes});
  }
  return undefined;
}
