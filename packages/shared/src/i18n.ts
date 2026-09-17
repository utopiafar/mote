import { english } from './i18n-en.js';

export type Locale = 'zh-CN' | 'en';
export type LanguagePreference = 'system' | Locale;
export const languageStorageKey = 'mote.language';
export function languagePreference(value: unknown): LanguagePreference {
  return value === 'zh-CN' || value === 'en' ? value : 'system';
}
/** Only supported BCP 47 language ranges participate; unsupported locales fall back to English. */
export function negotiateLocale(header?: string | readonly string[], fallback: Locale = 'en'): Locale {
  const values = (typeof header === 'string' ? header.split(',') : header ?? []).map((entry, index) => {
    const [tag, ...parameters] = entry.trim().split(';');
    const quality = parameters.find(p => p.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return { tag: tag.toLowerCase().replaceAll('_', '-'), q, index };
  }).filter(v => Number.isFinite(v.q) && v.q > 0 && v.q <= 1).sort((a,b) => b.q-a.q || a.index-b.index);
  for (const {tag} of values) {
    if (/^zh(?:-|$)/.test(tag)) return 'zh-CN';
    if (/^en(?:-|$)/.test(tag)) return 'en';
  }
  return fallback;
}
let localeReader: (() => Locale) | undefined;
export function configureLocale(reader: () => Locale): void { localeReader = reader; }
export function getLanguagePreference(): LanguagePreference {
  try { return languagePreference(globalThis.localStorage?.getItem(languageStorageKey)); } catch { return 'system'; }
}
export function getLocale(): Locale {
  if (localeReader) return localeReader();
  if (typeof window !== 'undefined') {
    const preference = getLanguagePreference();
    return preference === 'system' ? negotiateLocale(navigator.languages) : preference;
  }
  // Preserve the protocol's historical default for headless clients and fixture tests.
  return 'zh-CN';
}
export function translate(locale: Locale, source: string, ...values: unknown[]): string {
  const template = locale === 'en' && Object.hasOwn(english, source) ? english[source] : source;
  // A replacement callback does not interpret $, braces, HTML, or instructions in values.
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : match);
}
/** Call only on authored presentation strings, never on collected/user-authored content. */
export function moteText(source: string, ...values: unknown[]): string { return translate(getLocale(), source, ...values); }
export function saveLanguagePreference(preference: LanguagePreference): void {
  globalThis.localStorage.setItem(languageStorageKey, languagePreference(preference));
}

const messageSources = new Map(Object.entries(english).map(([source,value]) => [value,source]));
/** Re-render only app-authored status fields retained across a language change. Never use for evidence or logs. */
export function statusMessage(message: string): string { return translate(getLocale(), messageSources.get(message) ?? message); }
