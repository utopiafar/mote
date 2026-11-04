import type {ConcurrencyGate} from '../concurrency.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {ProviderAdmission} from '../provider-admission.js';

/** C05 execution members. */
export interface ExecutionFeatureServices {
  executor:ExecutionEngine;
  providerAdmission:ProviderAdmission;
  agentGate:ConcurrencyGate;
  interactiveGate:ConcurrencyGate;
  interactiveModelGate:ConcurrencyGate;
  llmGate:ConcurrencyGate;
}

export const executionFeatureServiceMembers = ['executor','providerAdmission','agentGate','interactiveGate','interactiveModelGate','llmGate'] as const satisfies readonly (keyof ExecutionFeatureServices)[];
