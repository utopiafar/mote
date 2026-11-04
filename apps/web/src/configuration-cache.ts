import type {Api} from './api';
import {resources} from './resource-cache';

/** Every settings editor shares the YAML revision; clean editors reload after a successful save. */
export function invalidateConfiguration(api:Api):void {
  resources(api).invalidate(key=>['/api/configuration','/api/agent-runtime-settings','/api/execution-settings','/api/diagnostics-settings','/api/memory-settings','/api/content-storage','/api/file-processing','/api/perception'].includes(key)||key.startsWith('/api/model-settings')||/^\/api\/(processing|actions)(\?|$)/.test(key));
}
