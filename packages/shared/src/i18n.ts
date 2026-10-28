import { english } from './i18n-en.js';
import { japanese } from './i18n-ja.js';
import { french } from './i18n-fr.js';
import { german } from './i18n-de.js';
import { spanish } from './i18n-es.js';
import { russian } from './i18n-ru.js';

export const locales = ['zh-CN', 'en', 'ja', 'fr', 'de', 'es', 'ru'] as const;
export type Locale = typeof locales[number];
export type LanguagePreference = 'system' | Locale;
export const languageStorageKey = 'mote.language';
export function languagePreference(value: unknown): LanguagePreference {
  return typeof value === 'string' && (locales as readonly string[]).includes(value) ? value as Locale : 'system';
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
    if (/^ja(?:-|$)/.test(tag)) return 'ja';
    if (/^fr(?:-|$)/.test(tag)) return 'fr';
    if (/^de(?:-|$)/.test(tag)) return 'de';
    if (/^es(?:-|$)/.test(tag)) return 'es';
    if (/^ru(?:-|$)/.test(tag)) return 'ru';
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
const catalogs: Record<Exclude<Locale, 'zh-CN'>, Readonly<Record<string, string>>> = {
  en: english, ja: japanese, fr: french, de: german, es: spanish, ru: russian,
};
/** Ideographic locales join adjacent translated fragments without a word space or Western quote marks. */
export function cjkLocale(locale: Locale = getLocale()): boolean { return locale === 'zh-CN' || locale === 'ja'; }
export function translate(locale: Locale, source: string, ...values: unknown[]): string {
  const catalog = locale === 'zh-CN' ? undefined : catalogs[locale];
  // Missing target-locale entries fall back to English, then to the authored source.
  const template = catalog && Object.hasOwn(catalog, source) ? catalog[source]!
    : locale !== 'zh-CN' && locale !== 'en' && Object.hasOwn(english, source) ? english[source]!
    : source;
  // A replacement callback does not interpret $, braces, HTML, or instructions in values.
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : match);
}
/** Call only on authored presentation strings, never on collected/user-authored content. */
export function moteText(source: string, ...values: unknown[]): string { return translate(getLocale(), source, ...values); }
export function saveLanguagePreference(preference: LanguagePreference): void {
  globalThis.localStorage.setItem(languageStorageKey, languagePreference(preference));
}

const messageSources = new Map(Object.values(catalogs).flatMap(catalog => Object.entries(catalog).map(([source, value]) => [value, source] as const)));
/** Re-render only app-authored status fields retained across a language change. Never use for evidence or logs. */
export function statusMessage(message: string): string { return translate(getLocale(), messageSources.get(message) ?? message); }
