import type {QueryInput} from '../query-contracts.js';
import {defaultTaskRegistry, type PreparedTask, type TaskRegistry} from './registry.js';

/** One Host-local preparation snapshot shared by instructions, context and
 * runtime output-schema assembly for both DSH and Codex. */
export function prepareTaskContext(input: QueryInput): PreparedTask {
  return (input.taskRegistry ?? defaultTaskRegistry).prepare(input);
}

export type {PreparedTask, TaskRegistry};
