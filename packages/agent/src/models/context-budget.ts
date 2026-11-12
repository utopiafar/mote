import {AgentConfigurationError} from '../types.js';

/** No tokenizer is bundled with every provider. This strategy therefore
 * returns a deliberately conservative upper estimate and always reports that
 * it is an estimate; it is never presented as a tokenizer-exact count. */
export const TOKEN_COUNTING_STRATEGIES = ['conservative-unicode-v1'] as const;
export type TokenCountingStrategy = typeof TOKEN_COUNTING_STRATEGIES[number];
export const DEFAULT_TOKEN_COUNTING_STRATEGY: TokenCountingStrategy = 'conservative-unicode-v1';

export interface TokenEstimate {
  /** Conservative upper estimate in tokens. */
  tokens: number;
  unit: 'estimated_tokens';
  strategy: TokenCountingStrategy;
  exact: false;
}

/**
 * Conservative Unicode estimate. ASCII/code/JSON are charged at two tokens per
 * five code units; other BMP text at three tokens per two code points; astral
 * code points (most emoji) at three tokens each. The factors intentionally
 * leave headroom instead of pretending a fixed CJK/Latin ratio is exact.
 */
export function estimateTextTokens(text: string): TokenEstimate {
  if (typeof text !== 'string') throw new TypeError('Token estimates require text.');
  let ascii = 0, bmp = 0, astral = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) ascii++;
    else if (codePoint <= 0xffff) bmp++;
    else astral++;
  }
  const tokens = Math.ceil(ascii * 2 / 5) + Math.ceil(bmp * 3 / 2) + astral * 3;
  return {tokens, unit: 'estimated_tokens', strategy: DEFAULT_TOKEN_COUNTING_STRATEGY, exact: false};
}

/** Estimate the exact JSON representation a provider receives. */
export function estimateSerializedTokens(value: unknown): TokenEstimate {
  const serialized = JSON.stringify(value);
  return estimateTextTokens(typeof serialized === 'string' ? serialized : '');
}

/** Model capacity is separate from the output limit. A missing window is not
 * silently treated as 128k; the resolver uses an explicitly named conservative
 * fallback that callers can surface as a configuration prompt. */
export const CONSERVATIVE_CONTEXT_WINDOW = 98_304;

export interface ContextBudgetConfiguration {
  /** Fraction of the context window targeted for dialogue history. */
  historyRatio: number;
  /** Fraction of the history target retained after compaction; always below 1. */
  lowWatermarkRatio: number;
  countingStrategy: TokenCountingStrategy;
}

export const DEFAULT_CONTEXT_BUDGET_CONFIGURATION: Readonly<ContextBudgetConfiguration> = Object.freeze({
  historyRatio: 0.5,
  lowWatermarkRatio: 0.5,
  countingStrategy: DEFAULT_TOKEN_COUNTING_STRATEGY,
});

export function normalizeContextBudgetConfiguration(configuration: Partial<ContextBudgetConfiguration> = {}): ContextBudgetConfiguration {
  const unknown = Object.keys(configuration).filter(key => !['historyRatio', 'lowWatermarkRatio', 'countingStrategy'].includes(key));
  if (unknown.length) throw new AgentConfigurationError('Unknown context budget settings.');
  const historyRatio = configuration.historyRatio ?? DEFAULT_CONTEXT_BUDGET_CONFIGURATION.historyRatio;
  const lowWatermarkRatio = configuration.lowWatermarkRatio ?? DEFAULT_CONTEXT_BUDGET_CONFIGURATION.lowWatermarkRatio;
  const countingStrategy = configuration.countingStrategy ?? DEFAULT_CONTEXT_BUDGET_CONFIGURATION.countingStrategy;
  if (typeof historyRatio !== 'number' || !Number.isFinite(historyRatio) || historyRatio < 0 || historyRatio > 1) throw new AgentConfigurationError('History ratio must be between 0 and 1.');
  if (typeof lowWatermarkRatio !== 'number' || !Number.isFinite(lowWatermarkRatio) || lowWatermarkRatio < 0 || lowWatermarkRatio >= 1) throw new AgentConfigurationError('History low watermark ratio must be at least 0 and below 1.');
  if (!TOKEN_COUNTING_STRATEGIES.includes(countingStrategy)) throw new AgentConfigurationError('Unsupported token counting strategy.');
  return Object.freeze({historyRatio, lowWatermarkRatio, countingStrategy});
}

export interface ContextBudgetUsage {
  systemTokens: number;
  toolSchemaTokens: number;
  currentInputTokens: number;
  toolReserveTokens: number;
  historyTokens: number;
}

export interface ContextBudgetInput {
  contextWindow: number;
  outputLimit: number;
  /** Vendor-specific completion/reasoning reserve. When present it replaces
   * outputLimit in the reserve; it is never added on top of it. */
  outputReserveTokens?: number;
  configuration?: Partial<ContextBudgetConfiguration>;
  usage: ContextBudgetUsage;
}

export interface ContextBudgetResult {
  contextWindow: number;
  outputLimit: number;
  outputReserve: number;
  configuration: ContextBudgetConfiguration;
  reserves: {
    system: number;
    tools: number;
    currentInput: number;
    output: number;
    toolReserve: number;
    total: number;
  };
  history: {
    /** H = max(0, min(historyRatio * W, W - R)). */
    target: number;
    /** L = floor(H * lowWatermarkRatio), always below a positive H. */
    lowWatermark: number;
    used: number;
    remaining: number;
    atOrOverTarget: boolean;
    overTarget: boolean;
    /** H=0 never enters a compaction loop. */
    compactionRequired: boolean;
  };
  request: {
    total: number;
    fitsWindow: boolean;
    overflow: number;
    inputBudget: number;
    currentInputExceedsBudget: boolean;
  };
  status: 'fits' | 'compaction_required' | 'over_window';
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new AgentConfigurationError(`Context budget ${name} must be a non-negative integer.`);
  return value;
}

export function calculateContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  if (!Number.isInteger(input.contextWindow) || input.contextWindow < 1) throw new AgentConfigurationError('Context window must be a positive integer.');
  if (!Number.isInteger(input.outputLimit) || input.outputLimit < 1) throw new AgentConfigurationError('Output limit must be a positive integer.');
  const configuration = normalizeContextBudgetConfiguration(input.configuration);
  const system = nonNegativeInteger('system tokens', input.usage.systemTokens);
  const tools = nonNegativeInteger('tool schema tokens', input.usage.toolSchemaTokens);
  const currentInput = nonNegativeInteger('current input tokens', input.usage.currentInputTokens);
  const toolReserve = nonNegativeInteger('tool reserve tokens', input.usage.toolReserveTokens);
  const historyUsed = nonNegativeInteger('history tokens', input.usage.historyTokens);
  const outputReserve = nonNegativeInteger('output reserve tokens', input.outputReserveTokens ?? input.outputLimit);
  const reserveTotal = system + tools + currentInput + outputReserve + toolReserve;
  const remainingWindow = input.contextWindow - reserveTotal;
  const historyTarget = Math.max(0, Math.floor(Math.min(configuration.historyRatio * input.contextWindow, remainingWindow)));
  const lowWatermark = historyTarget > 0 ? Math.min(historyTarget - 1, Math.floor(historyTarget * configuration.lowWatermarkRatio)) : 0;
  const total = reserveTotal + historyUsed;
  const overflow = Math.max(0, total - input.contextWindow);
  const overTarget = historyTarget > 0 && historyUsed > historyTarget;
  const atOrOverTarget = historyTarget > 0 && historyUsed >= historyTarget;
  const inputBudget = Math.max(0, input.contextWindow - (system + tools + outputReserve + toolReserve));
  const currentInputExceedsBudget = currentInput > inputBudget;
  const fitsWindow = overflow === 0;
  return {
    contextWindow: input.contextWindow,
    outputLimit: input.outputLimit,
    outputReserve,
    configuration,
    reserves: {system, tools, currentInput, output: outputReserve, toolReserve, total: reserveTotal},
    history: {
      target: historyTarget,
      lowWatermark,
      used: historyUsed,
      remaining: Math.max(0, historyTarget - historyUsed),
      atOrOverTarget,
      overTarget,
      compactionRequired: overTarget,
    },
    request: {total, fitsWindow, overflow, inputBudget, currentInputExceedsBudget},
    status: !fitsWindow ? 'over_window' : overTarget ? 'compaction_required' : 'fits',
  };
}
