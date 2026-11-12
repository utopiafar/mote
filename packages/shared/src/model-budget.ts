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
