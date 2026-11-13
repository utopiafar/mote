import type {FeatureRequirement} from '@mote/shared';
import {resolveDiscoveryTarget,type DiscoveryAvailability,type DiscoveryState,type DiscoveryTarget} from './discovery-availability';

/** Authored navigation positions for this cycle's assistant pages. A page
 * owner registers the same page id and route when its implementation lands;
 * until then the directory keeps the entry non-executable. This is a local
 * navigation catalog, not a second package manifest or wire schema. */
export interface AssistantEntrypoint {
  readonly pageId:string;
  readonly href:string;
  readonly title:string;
  readonly purpose:string;
  readonly requires?:readonly FeatureRequirement[];
}

export const assistantEntrypoints:readonly AssistantEntrypoint[]=Object.freeze([
  {
    pageId:'assistantMatters',
    href:'#/assistant/matters',
    title:'事项与规则',
    purpose:'跟踪事项、承诺、期限和定期规则。',
    requires:[{id:'http:GET:/api/assistant/matters',version:'1',host:'server'}],
  },
  {
    pageId:'assistantMemory',
    href:'#/assistant/memory',
    title:'记忆与人物',
    purpose:'查看、纠正和遗忘助理对你的理解。',
    requires:['http:GET:/api/memories','http:GET:/api/context-trees','http:GET:/api/assistant/commitments'],
  },
  {
    pageId:'assistantWorkbench',
    href:'#/assistant/workbench',
    title:'工作台',
    purpose:'项目、人物、旅行和阅读的固定视图。',
    requires:[{id:'http:GET:/api/assistant/workbench',version:'1',host:'server'}],
  },
]);

/** The same page/collection/capability resolver every directory link uses. */
export function assistantDiscoveryTarget(entry:AssistantEntrypoint):DiscoveryTarget {
  return {pageId:entry.pageId,href:entry.href,...(entry.requires?.length?{requires:entry.requires}:{})};
}

/** Availability is exact registry identity, never inferred from content. */
export function resolveAssistantEntrypoint(entry:AssistantEntrypoint,state:DiscoveryState):DiscoveryAvailability {
  return resolveDiscoveryTarget(assistantDiscoveryTarget(entry),state);
}
