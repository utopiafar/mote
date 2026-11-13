import {z} from 'zod';

/** Model limits/configuration only. The consumer computes the history
 * target against the complete request, including output and tool reserves. */
export const modelBudgetSchema=z.object({
  contextWindow:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // Existing provider meaning: output limit, not the input/context window.
  maxTokens:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  historyRatio:z.number().min(0).max(1).default(0.5),
  lowWatermarkRatio:z.number().min(0).lt(1),
  tokenCounting:z.enum(['exact','estimated']),
  contextWindowSource:z.enum(['known','configured','conservative']),
}).strict();
export type ModelBudget=z.infer<typeof modelBudgetSchema>;

/** Product preferences for Ask. A null window explicitly selects the labeled
 * conservative fallback; an override is an owner-supplied chat window, not an
 * output-token limit. Request-time budgeting remains the consumer's job. */
export const conversationContextSettingsSchema=z.object({
  historyRatio:modelBudgetSchema.shape.historyRatio,
  lowWatermarkRatio:modelBudgetSchema.shape.lowWatermarkRatio.default(0.5),
  contextWindow:modelBudgetSchema.shape.contextWindow.nullable().default(null),
  contextWindowSource:z.enum(['configured','conservative']).default('conservative'),
}).strict().refine(value=>value.contextWindowSource==='configured'?value.contextWindow!==null:value.contextWindow===null,
  {message:'Configured windows require an explicit size; conservative windows do not accept an override.'});
export const conversationSettingsSchema=z.object({
  multipleConversations:z.boolean().default(false),
  context:conversationContextSettingsSchema.default({}),
}).strict();
export type ConversationSettings=z.infer<typeof conversationSettingsSchema>;
