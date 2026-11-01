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
type CatalogLocale = Exclude<Locale, 'zh-CN'>;
type Catalog = Readonly<Record<string, string>>;
const catalogs: Partial<Record<CatalogLocale, Catalog>> = {};
const loaders: Record<CatalogLocale, () => Promise<Catalog>> = {
  en: () => import('./i18n-en.js').then(m => m.english),
  ja: () => import('./i18n-ja.js').then(m => m.japanese),
  fr: () => import('./i18n-fr.js').then(m => m.french),
  de: () => import('./i18n-de.js').then(m => m.german),
  es: () => import('./i18n-es.js').then(m => m.spanish),
  ru: () => import('./i18n-ru.js').then(m => m.russian),
};
let messageSources: Map<string, string> | undefined;
export function registerCatalog(locale: CatalogLocale, catalog: Catalog): void {
  catalogs[locale] = catalog;
  messageSources = undefined;
}
const loading = new Map<CatalogLocale, Promise<void>>();
function loadCatalog(locale: CatalogLocale): Promise<void> {
  if (catalogs[locale]) return Promise.resolve();
  let pending = loading.get(locale);
  if (!pending) {
    pending = loaders[locale]().then(catalog => registerCatalog(locale, catalog)).finally(() => loading.delete(locale));
    loading.set(locale, pending);
  }
  return pending;
}
/** Complete both loads before reporting failure so callers can still use the English fallback. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (locale === 'zh-CN') return;
  const results = await Promise.allSettled((locale === 'en' ? ['en'] as const : [locale, 'en'] as const).map(loadCatalog));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
/** Ideographic locales join adjacent translated fragments without a word space or Western quote marks. */
export function cjkLocale(locale: Locale = getLocale()): boolean { return locale === 'zh-CN' || locale === 'ja'; }
export function translate(locale: Locale, source: string, ...values: unknown[]): string {
  const catalog = locale === 'zh-CN' ? undefined : catalogs[locale];
  // Missing target-locale entries fall back to English, then to the authored source.
  const template = catalog && Object.hasOwn(catalog, source) ? catalog[source]!
    : locale !== 'zh-CN' && catalogs.en && Object.hasOwn(catalogs.en, source) ? catalogs.en[source]!
    : source;
  // A replacement callback does not interpret $, braces, HTML, or instructions in values.
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : match);
}
/** Call only on authored presentation strings, never on collected/user-authored content. */
export function moteText(source: string, ...values: unknown[]): string { return translate(getLocale(), source, ...values); }
export function saveLanguagePreference(preference: LanguagePreference): void {
  globalThis.localStorage.setItem(languageStorageKey, languagePreference(preference));
}

/** Re-render only app-authored status fields retained across a language change. Never use for evidence or logs. */
export function statusMessage(message: string): string {
  messageSources ??= new Map(Object.values(catalogs).flatMap(catalog => Object.entries(catalog).map(([source, value]) => [value, source] as const)));
  return translate(getLocale(), messageSources.get(message) ?? message);
}
