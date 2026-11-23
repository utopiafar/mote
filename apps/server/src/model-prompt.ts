import {requestLocale} from './i18n.js';
import prompts from './model-prompts.json' with {type:'json'};

/** Model inputs keep their existing request language independently of interface copy. */
export function modelPrompt(name: keyof typeof prompts): string {
  return prompts[name][requestLocale.getStore() ?? 'zh-CN'];
}
