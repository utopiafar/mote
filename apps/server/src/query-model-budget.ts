import {resolveModelCapabilities} from '@mote/agent';
import type {ConversationSettings,ModelBudget} from '@mote/shared';

/** Share the product's capacity choice with every query entry. The provider
 * still checks each complete serialized request, including tool continuations. */
export function queryModelBudget(maxTokens:number,preferences:ConversationSettings['context']):ModelBudget{
 const capabilities=resolveModelCapabilities({maxTokens,...(preferences.contextWindow===null?{}:{contextWindow:preferences.contextWindow})});
 return {contextWindow:capabilities.contextWindow,maxTokens:capabilities.maxOutputTokens,historyRatio:preferences.historyRatio,
  lowWatermarkRatio:preferences.lowWatermarkRatio,tokenCounting:'estimated',contextWindowSource:capabilities.contextWindowSource==='configured'?'configured':'conservative'};
}
