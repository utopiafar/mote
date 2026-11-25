import {randomUUID} from 'node:crypto';
import {createParser} from 'eventsource-parser';
import {normalizeOpenCodeRequestUsage,safeUpstreamRequestId,type OpenCodeRequestUsage} from '@mote/shared';

export type ObserveOpenCodeUsage = (usage: OpenCodeRequestUsage) => void | Promise<void>;
const maxUsageFrame = 512 * 1024;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function openCodeRequestMeasurement(report: ObserveOpenCodeUsage) {
  const modelRequestId = randomUUID();
  let startedAt = performance.now(), startReport: Promise<void> | undefined;
  const decoder = new TextDecoder();
  let responseId: string | undefined, headerId: string | undefined, httpStatus: number | undefined;
  let mode: 'sse' | 'json' | undefined, json = '', jsonTooLarge = false, finished = false;
  let counts: Record<string, unknown> = {};
  const sample = (data: string) => {
    if (data.length > maxUsageFrame || data === '[DONE]') return;
    try {
      const payload = record(JSON.parse(data));
      responseId ??= safeUpstreamRequestId(payload.id);
      if (!Object.keys(record(payload.usage)).length) return;
      const usage = record(payload.usage), extension = record(usage.opencode), tokens = record(extension.tokens);
      counts = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        cachedPromptTokens: record(usage.prompt_tokens_details).cached_tokens,
        completionReasoningTokens: record(usage.completion_tokens_details).reasoning_tokens,
        billedInputTokens: tokens.input,
        billedCacheReadTokens: tokens.cache_read,
        billedCacheWrite5mTokens: tokens.cache_write_5m,
        billedCacheWrite1hTokens: tokens.cache_write_1h,
        billedOutputTokens: tokens.output,
        billedReasoningTokens: tokens.reasoning,
        billingSource: extension.billing_source,
        allowanceUsd: extension.allowance,
      };
    } catch { /* Malformed frames are left to the model SDK. */ }
  };
  const parser = createParser({maxBufferSize: maxUsageFrame, onEvent: event => sample(event.data)});
  const feed = (text: string) => {
    if (mode === 'sse') {
      try { parser.feed(text); } catch { /* A diagnostic parser cannot interrupt the model stream. */ }
    } else if (mode === 'json' && !jsonTooLarge) {
      if (json.length + text.length <= maxUsageFrame) json += text;
      else { jsonTooLarge = true; json = ''; }
    }
  };
  const publish=async (fields: Record<string, unknown>)=>{
    const usage=normalizeOpenCodeRequestUsage({...fields,modelRequestId});
    if(usage)try{await report(usage);}catch{/* Accounting does not govern execution. */}
  };
  return {
    begin() {
      startedAt=performance.now();
      startReport=publish({requestState:'started',durationMs:0});
    },
    headers(response: Response) {
      httpStatus = response.status;
      headerId = ['x-request-id', 'request-id', 'apim-request-id']
        .map(header => safeUpstreamRequestId(response.headers.get(header))).find(Boolean);
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType === 'text/event-stream') mode = 'sse';
      else if (contentType === 'application/json') mode = 'json';
    },
    read(bytes: Uint8Array) {
      if (mode) feed(decoder.decode(bytes, {stream: true}));
    },
    async finish() {
      if (finished) return;
      finished = true;
      if (mode) feed(decoder.decode());
      if (mode === 'json') sample(json);
      const durationMs=performance.now()-startedAt;
      await startReport;
      await publish({...counts,requestState:'finished',httpStatus,upstreamRequestId:headerId??responseId,durationMs});
    },
  };
}
