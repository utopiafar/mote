import { AsyncLocalStorage } from 'node:async_hooks';
import { configureLocale, translate, type Locale } from '@mote/shared/i18n';
export const requestLocale = new AsyncLocalStorage<Locale>();
configureLocale(() => requestLocale.getStore() ?? 'zh-CN');
export function moteText(source: string, ...values: unknown[]): string {
  return translate(requestLocale.getStore() ?? 'zh-CN', source, ...values);
}
