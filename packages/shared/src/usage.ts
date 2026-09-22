import { moteText } from './i18n.js';
/** Provider-reported quantities. Optional buckets are unknown, never assumed zero. */
export interface TokenUsage {
  /** Codex reports thread totals without underlying request counts. */
  measurement?: 'thread_cumulative';
  complete?: boolean;
  requests: number;
  reportedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
export function hasCompleteTokenUsage(value:TokenUsage|undefined):value is TokenUsage {
  return Boolean(value&&(value.measurement==='thread_cumulative'?value.complete===true:value.requests>0&&value.requests===value.reportedRequests));
}
export interface UsageReceipt {
  id: string;
  provider: string;
  model: string;
  operation: string;
  attribution?: UsageAttribution;
  createdAt: string;
  durationMs: number;
  status: 'running' | 'completed' | 'failed';
  tokens?: TokenUsage;
  estimatedCost: number | null;
  currency: string;
  price?: ModelPrice;
}
export interface ModelPrice {
  provider: string;
  model: string;
  currency: 'USD' | 'CNY';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Host-assigned execution identity, never inferred from question or evidence text. */
export interface UsageAttribution {
  operationId?: string;
  jobId?: string;
  requestId?: string;
  agentId: string;
  moduleId: string;
  /** null means no primary skill; absent attribution means historical/unknown. */
  skillId: string | null;
}
export type UsageGroupBy = 'agent' | 'module' | 'skill' | 'model' | 'provider';
export interface UsageFilters {
  agentId?: string;
  moduleId?: string;
  skillId?: string;
  provider?: string;
  model?: string;
  status?: UsageReceipt['status'];
}
export interface UsageTotals {
  runs: number;
  completed: number;
  failed: number;
  running: number;
  successRate: number | null;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  requests: number;
  reportedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number | null;
  unknownUsage: number;
  unknownRequestCounts?: number;
  unknownCache: number;
  unpriced: number;
  costs: Record<string, number | null>;
}
export interface UsageGroup extends UsageTotals {
  id: string;
  label: string;
  filter: UsageFilters;
}
export interface UsageSummary {
  from: string;
  to: string;
  timeZone: string;
  groupBy: UsageGroupBy;
  filters: UsageFilters;
  total: UsageTotals;
  days: (UsageTotals & {date:string})[];
  groups: UsageGroup[];
  facets: Record<'agentId'|'moduleId'|'skillId', {id:string;label:string}[]>;
  items: UsageReceipt[];
  itemsTotal: number;
  page?: number;
  pageSize?: number;
  prices: ModelPrice[];
}
export const USAGE_UNKNOWN = '__unknown__';
export const USAGE_NO_SKILL = '__none__';
const usageLabels: Record<'agent'|'module'|'skill', Record<string,string>> = {
  agent: {'context-query':'上下文查询 Agent','file-analysis':'文件分析 Agent','document-import':'文档导入 Agent'},
  module: {conversations:'问答',insights:'洞察',memories:'记忆',files:'文件分析',imports:'资料导入'},
  skill: {'personal-insight':'个人洞察','memory-extraction':'记忆提取','coding-memory':'编码经验提取','document-import':'文档导入'},
};
export function usageLabel(dimension:'agent'|'module'|'skill',id:string):string {
  if(id===USAGE_UNKNOWN)return moteText('历史未标记');
  if(dimension==='skill'&&id===USAGE_NO_SKILL)return moteText('未指定 Skill');
  const label=usageLabels[dimension][id];
  return label ? moteText(label) : id;
}
export function usageIdentity(receipt:UsageReceipt) {
  return {
    agentId:receipt.attribution?.agentId??USAGE_UNKNOWN,
    moduleId:receipt.attribution?.moduleId??USAGE_UNKNOWN,
    skillId:receipt.attribution?(receipt.attribution.skillId??USAGE_NO_SKILL):USAGE_UNKNOWN,
  };
}
