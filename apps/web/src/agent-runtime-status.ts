import {agentRuntimeStatusReceiptSchema, type AgentRuntimeStatusReceipt} from '@mote/shared/agent-runtime-status';
import {moteText} from '@mote/shared/i18n';
import {ApiError} from './api';

/** Parse the shared agent-runtime status receipt. A malformed or secret-shaped
 * body surfaces as invalid_response instead of a false configured state. */
export function parseAgentRuntimeStatus(value: unknown): AgentRuntimeStatusReceipt {
  try {
    return agentRuntimeStatusReceiptSchema.parse(value);
  } catch {
    throw new ApiError(moteText('中央响应格式无效，请刷新后重试。'), 200, undefined, 'invalid_response');
  }
}
