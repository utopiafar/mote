import { z } from 'zod';

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
/** Legacy selected-node rules remain readable for desktop and already queued observations. */
export const uiLegacyRuleSchema = z.object({
  ...ruleBase, appVersion: short.optional(), select: uiSelectorSchema,
  ancestor: uiSelectorSchema.optional(), complete: z.boolean().default(false),
}).strict();
export const uiFieldRuleSchema = z.object({
  select: uiSelectorSchema, ancestor: uiSelectorSchema.optional(), required: z.boolean().default(false),
  childPath: z.array(z.number().int().min(0).max(4095)).min(1).max(24).optional(),
}).strict();
export const uiStructuredRuleSchema = z.object({
  ...ruleBase, formatVersion: z.literal(2), appVersion: nonblank(300),
  kind: z.enum(['article', 'product']), region: uiSelectorSchema.optional(), repeat: uiSelectorSchema.optional(), repeatParent: uiSelectorSchema.optional(),
  fields: z.object({
    title: uiFieldRuleSchema, author: uiFieldRuleSchema.optional(), url: uiFieldRuleSchema.optional(),
    itemId: uiFieldRuleSchema.optional(), body: uiFieldRuleSchema.optional(),
  }).strict(),
}).strict().superRefine((rule, ctx) => {
  if (rule.kind === 'article' && !rule.fields.body) ctx.addIssue({code: 'custom', path: ['fields', 'body'], message: 'Articles require an explicit body mapping'});
  if (!rule.fields.title.required) ctx.addIssue({code: 'custom', path: ['fields', 'title', 'required'], message: 'Title mappings must be required'});
  if (rule.kind === 'article' && !rule.fields.body?.required) ctx.addIssue({code: 'custom', path: ['fields', 'body', 'required'], message: 'Article body mappings must be required'});
  if (rule.repeatParent && !rule.repeat) ctx.addIssue({code: 'custom', path: ['repeatParent'], message: 'A repeat parent requires repeated containers'});
  if (!rule.region && !rule.repeat && Object.values(rule.fields).some(field => field?.childPath)) ctx.addIssue({code: 'custom', path: ['fields'], message: 'Child paths require an explicit region or repeat root'});
});
export const uiRuleSchema = z.union([uiStructuredRuleSchema, uiLegacyRuleSchema]);
export const uiRulesSchema = z.array(uiRuleSchema).max(32)
  .refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs')
  .refine(rules => new TextEncoder().encode(JSON.stringify(rules)).length <= 65536, 'Rule pack exceeds 64 KiB');
export const uiModeSchema = z.enum(['screen_only', 'hybrid', 'ui_preferred', 'page_only']);
export type UiMode = z.infer<typeof uiModeSchema>;
export type UiRule = z.infer<typeof uiRuleSchema>;
export type UiStructuredRule = z.infer<typeof uiStructuredRuleSchema>;
export type UiSelector = z.infer<typeof uiSelectorSchema>;
const boundsSchema = z.object({x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive()}).strict();
const nodeBase = {id: short, resourceId: z.string().max(300), role: z.string().max(300), bounds: boundsSchema};
export const uiNodeSchema = z.object({...nodeBase, parentId: short.optional(), childIndex: z.number().int().min(0).max(4095).optional(), text: z.string().max(32000)}).strict();
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
export const uiPageV1Schema = z.object({
  ...pageBase, version: z.literal(1),
  nodes: z.array(z.object({...nodeBase, text: z.string().max(2000)}).strict()).min(1).max(256),
}).strict().superRefine((page, ctx) => {
  if (new Set(page.nodes.map(node => node.id)).size !== page.nodes.length || page.nodes.reduce((sum, node) => sum + node.text.length, 0) > 32000 || page.truncated && page.status === 'ok') ctx.addIssue({code: 'custom', message: 'Invalid page evidence'});
});
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
export const uiPageV2Schema = z.object({
  ...pageBase, version: z.literal(2),
  observations: z.object({firstAt: observedAt, lastAt: observedAt, count: z.number().int().min(1).max(256)}).strict(),
  // One transport record belongs to one independently organized article or product.
  objects: z.array(uiContentObjectSchema).length(1),
}).strict().superRefine((page, ctx) => {
  if (Date.parse(page.observations.firstAt) > Date.parse(page.observations.lastAt)) ctx.addIssue({code: 'custom', path: ['observations'], message: 'Observation time range is reversed'});
  if (page.truncated && page.status === 'ok') ctx.addIssue({code: 'custom', message: 'Truncated observations cannot be marked ok'});
  const size = page.objects.reduce((sum, object) => sum + object.title.length + (object.author?.length ?? 0) + (object.url?.length ?? 0) + (object.itemId?.length ?? 0) + object.body.reduce((count, block) => count + block.text.length, 0), 0);
  if (size > 64000) ctx.addIssue({code: 'custom', message: 'Page fields exceed budget'});
});
export const uiPageSchema = z.union([uiPageV2Schema, uiPageV1Schema]);
export type UiPage = z.infer<typeof uiPageSchema>;
export type UiPageV2 = z.infer<typeof uiPageV2Schema>;
export function uiPageText(page: UiPage): string {
  if (page.version === 1) return page.nodes.map(node => node.text).join('\n');
  return page.objects.map(object => [object.title, object.author, object.url, object.itemId, ...object.body.map(block => block.text)].filter(value => value !== undefined).join('\n')).join('\n\n');
}
export function matchesUi(node: UiSnapshot['nodes'][number], selector: UiSelector): boolean {
  return (selector.resourceId === undefined || node.resourceId === selector.resourceId) &&
    (selector.role === undefined || node.role === selector.role) && (selector.textEquals === undefined || node.text === selector.textEquals);
}
/** Structural field mapping only. This function does not infer topics, intent, authors or attention. */
export function extractUiPages(snapshot: UiSnapshot, rules: UiRule[], platform: 'android' | 'macos', at = snapshot.observedAt): UiPage[] {
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
  const within = (node: UiSnapshot['nodes'][number], root: string | undefined): boolean => {
    if (!root) return true;
    if (node.id === root) return true;
    let parent = node.parentId;
    for (let depth = 0; parent && depth < 256; depth++) {
      if (parent === root) return true;
      parent = byId.get(parent)?.parentId;
    }
    return false;
  };
  const hasAncestor = (node: UiSnapshot['nodes'][number], selector?: UiSelector, rootId?: string, maxDepth = 256): boolean => {
    if (!selector) return true;
    let parent = node.parentId;
    for (let depth = 0; parent && depth < maxDepth; depth++) {
      const ancestor = byId.get(parent); if (!ancestor) break;
      if (matchesUi(ancestor, selector)) return true;
      if (parent === rootId) return false;
      parent = ancestor.parentId;
    }
    return false;
  };
  for (const rule of rules) {
    if (rule.platform !== platform || rule.appId !== snapshot.appId || rule.activity !== undefined && rule.activity !== snapshot.activity || rule.appVersion !== undefined && rule.appVersion !== snapshot.appVersion) continue;
    if (!rule.required.every(selector => snapshot.nodes.some(node => matchesUi(node, selector)))) continue;
    if (!('formatVersion' in rule)) {
      let truncated = snapshot.truncated;
      let budget = 32000;
      const nodes = snapshot.nodes.filter(node => node.text.trim() && matchesUi(node, rule.select) && hasAncestor(node, rule.ancestor, undefined, 32)).flatMap(({parentId: _, childIndex: _childIndex, ...node}) => {
        if (budget <= 0) { truncated = true; return []; }
        const text = node.text.slice(0, Math.min(2000, budget)); budget -= text.length;
        if (text.length !== node.text.length) truncated = true;
        return [{...node, text}];
      });
      if (nodes.length) return [uiPageV1Schema.parse({version: 1, ...pageBaseValues(snapshot, rule), status: rule.complete && !truncated ? 'ok' : 'partial', truncated, nodes})];
      continue;
    }
    if (!at || !observedAt.safeParse(at).success) continue;
    const regions = rule.region ? snapshot.nodes.filter(node => matchesUi(node, rule.region!)) : [];
    if (rule.region && regions.length !== 1) continue;
    const region = regions[0]?.id;
    const roots = rule.repeat ? snapshot.nodes.filter(node => within(node, region) && matchesUi(node, rule.repeat!) && (!rule.repeatParent || node.parentId && byId.get(node.parentId) && matchesUi(byId.get(node.parentId)!, rule.repeatParent))) : [regions[0]];
    const pages: UiPageV2[] = [];
    for (const root of roots.slice(0, 16)) {
      const fields: Record<string, string | {text: string}[]> = {};
      let invalid = false;
      let clipped = false;
      for (const [name, field] of Object.entries(rule.fields)) {
        if (!field) continue;
        let pathNode: UiSnapshot['nodes'][number] | undefined = root;
        if (field.childPath) for (const index of field.childPath) {
          const children: UiSnapshot['nodes'] = pathNode ? snapshot.nodes.filter(node => node.parentId === pathNode!.id && node.childIndex === index) : [];
          pathNode = children.length === 1 ? children[0] : undefined;
          if (!pathNode) break;
        }
        const values = snapshot.nodes.filter(node => (!field.childPath || pathNode?.id === node.id) && within(node, region) && within(node, root?.id) && node.text.trim() && matchesUi(node, field.select) && hasAncestor(node, field.ancestor, root?.id)).map(node => node.text);
        if (name !== 'body' && values.length > 1) { if (field.required || name === 'title') invalid = true; if (invalid) break; else continue; }
        if (!values.length && (field.required || name === 'title' || name === 'body' && rule.kind === 'article')) { invalid = true; break; }
        if (name === 'body') {
          fields.body = values.slice(0, 64).map(text => ({text}));
          if (values.length > 64) clipped = true;
        }
        else if (values[0] !== undefined) {
          const limit = name === 'title' || name === 'url' ? 2000 : 1000;
          if (values[0].length > limit || name === 'url' && !pageUrl.safeParse(values[0]).success) { if (field.required || name === 'title') invalid = true; }
          else fields[name] = values[0];
        }
      }
      if (invalid) continue;
      const parsedObject = uiContentObjectSchema.safeParse({kind: rule.kind, body: [], ...fields, ...(typeof fields.itemId === 'string' ? {identity: {type: 'source_id', value: fields.itemId}} : typeof fields.url === 'string' ? {identity: {type: 'url', value: fields.url}} : {})});
      if (!parsedObject.success) continue;
      const truncated = snapshot.truncated || clipped || roots.length > 16;
      const page = uiPageV2Schema.safeParse({version: 2, ...pageBaseValues(snapshot, rule), status: truncated ? 'partial' : 'ok', truncated, observations: {firstAt: at, lastAt: at, count: 1}, objects: [parsedObject.data]});
      if (page.success) pages.push(page.data);
    }
    if (pages.length) return pages;
  }
  return [];
}
function pageBaseValues(snapshot: UiSnapshot, rule: UiRule) {
  return {scope: 'visible_window' as const, adapterId: rule.id, adapterVersion: rule.version, appVersion: snapshot.appVersion, activity: snapshot.activity};
}
/** Compatibility entry point. New collectors use extractUiPages so product cards remain separate records. */
export function extractUiPage(snapshot: UiSnapshot, rules: UiRule[], platform: 'android' | 'macos', at = snapshot.observedAt): UiPage | undefined {
  return extractUiPages(snapshot, rules, platform, at)[0];
}
