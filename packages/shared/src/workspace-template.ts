import {z} from 'zod';
import {queryScopeSchema} from './query-scope.js';
import type {DeclarativeViewSpec,UiContributionDescriptor} from './plugin-ui.js';

/** Fixed declarative-view compositions; this is not a layout DSL. */
export const workspaceTemplateSchema=z.enum(['project','person','travel','reading']);
export type WorkspaceTemplate=z.infer<typeof workspaceTemplateSchema>;

/** Explicit identity selection only. Templates do not infer people or topics
 * from names, and a selected identity never widens the caller's scope. */
export const workspaceRequestSchema=z.object({
  template:workspaceTemplateSchema,scope:queryScopeSchema,
  matterId:z.string().uuid().optional(),personMemoryId:z.string().uuid().optional(),
}).strict().refine(value=>value.template==='person'?value.matterId===undefined:value.personMemoryId===undefined,
  {message:'Use a Memory identity for a person and a matter identity for other templates'});
export type WorkspaceRequest=z.infer<typeof workspaceRequestSchema>;

/** References to actual owner product operations. No URL, script or model
 * supplied handler is accepted. The target versions are checked again by the
 * product command adapter, then by the existing domain writer. */
export const workspaceCommandReferenceSchema=z.discriminatedUnion('id',[
  z.object({id:z.literal('refresh'),apiVersion:z.literal('1')}).strict(),
  z.object({id:z.literal('matter.edit'),apiVersion:z.literal('1'),matterId:z.string().uuid(),expectedRevision:z.number().int().positive().safe()}).strict(),
  z.object({id:z.literal('matter.pause'),apiVersion:z.literal('1'),matterId:z.string().uuid(),expectedRevision:z.number().int().positive().safe()}).strict(),
  z.object({id:z.literal('matter.resume'),apiVersion:z.literal('1'),matterId:z.string().uuid(),expectedRevision:z.number().int().positive().safe()}).strict(),
  z.object({id:z.literal('matter.archive'),apiVersion:z.literal('1'),matterId:z.string().uuid(),expectedRevision:z.number().int().positive().safe()}).strict(),
  z.object({id:z.literal('memory.correct'),apiVersion:z.literal('1'),memoryId:z.string().uuid(),version:z.number().int().positive().safe()}).strict(),
]);
export type WorkspaceCommandReference=z.infer<typeof workspaceCommandReferenceSchema>;
export const workspaceCommandSchema=z.object({
  request:workspaceRequestSchema,command:workspaceCommandReferenceSchema,input:z.unknown().optional(),
}).strict();

/** A transport envelope around the existing descriptor/spec/data. Consumers
 * pass spec directly to their declarative-view decoder; there is no second
 * block or query-reference protocol. Workbenches store no evidence bodies. */
export interface WorkspaceView {
  request:WorkspaceRequest;
  descriptor:UiContributionDescriptor;
  spec:DeclarativeViewSpec;
  data:Record<string,unknown>;
  commands:WorkspaceCommandReference[];
}

/** Token keys in the existing declarative-view format. Clients localize only
 * authored labels; captured titles, statements and coverage reasons stay data. */
export const workspaceLabels:Readonly<Record<string,string>>={
  project:'项目',person:'人物',travel:'旅行',reading:'阅读',
  title:'标题',goal:'目标',statement:'内容',state:'状态',deadline:'期限',
  summary:'内容',observedAt:'观察时间',occurredAt:'发生时间',recordedAt:'记录时间',
  memory:'记忆',commitments:'承诺',files:'文件',source:'来源',
  extraction:'提取',semantic:'语义理解',embedding:'向量索引',original:'原件',
  reason:'原因',
  pause:'暂停',resume:'恢复',archive:'归档事项',refresh:'刷新',submit:'保存',
  empty:'当前范围内没有可用资料。',unavailable:'资料已撤回或超出当前范围。',
  pending:'待处理',error:'部分资料读取失败，请刷新后重试。',
  failed:'部分资料读取失败，请刷新后重试。',limited:'每个列表最多显示当前范围内的 20 项。',
  changed:'操作已失效，请刷新后重试。',
};
