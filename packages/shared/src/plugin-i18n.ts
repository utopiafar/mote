/** Plugin-authored message catalogs are namespaced and resolved at call time.
 * Keys are opaque authored identifiers, never captured content; the English
 * catalog is the canonical key set and every other locale may only translate
 * those keys. Resolution reports an explicit fallback reason instead of
 * throwing, so a missing translation never changes authorization, drafts or
 * the stable route identity of a contribution. */
import {getLocale, locales, type Locale} from './i18n.js';
import {
  isToken,
  type UiContributionDescriptor,
  type UiContributionPresentation,
} from './plugin-ui.js';

/** Why a plugin message did not use an exact translation for the active locale. */
export type PluginTextFallback = 'namespace_missing' | 'locale_missing' | 'key_missing';
export interface PluginText {
  readonly text: string;
  readonly fallback?: PluginTextFallback;
}

/** A contribution presentation resolved for one locale. `routeId` is the
 * descriptor's opaque contribution id and never changes with translation. */
export interface ResolvedUiPresentation {
  readonly routeId: string;
  readonly label: PluginText;
  readonly glyph?: PluginText;
  /** Falls back to the visible label, so the accessible name is never empty. */
  readonly a11y: PluginText;
  readonly fallbackReasons: readonly PluginTextFallback[];
}

type Catalog = Readonly<Record<string, string>>;
const MAX_MESSAGE_LENGTH = 2000;

/** One registry per host. Catalogs are immutable snapshots: a caller mutating
 * its input object after registration cannot change an active translation. */
export class PluginI18nRegistry {
  private readonly namespaces = new Map<string, Map<Locale, Catalog>>();

  /** Registers one locale catalog and returns a disposer. English defines the
   * namespace key set; a later locale may only translate keys English already
   * declared. Registration order is free, but an English catalog arriving
   * later must cover every key already declared by another locale. */
  register(namespace: string, locale: Locale, catalog: Catalog): () => void {
    if (!isToken(namespace)) throw new TypeError('Invalid plugin i18n namespace');
    if (!(locales as readonly string[]).includes(locale)) throw new TypeError('Unsupported plugin locale: ' + locale);
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new TypeError('Invalid plugin catalog');
    const entries = Object.entries(catalog);
    if (entries.length === 0) throw new TypeError('Empty plugin catalog');
    for (const [key, value] of entries) {
      if (!isToken(key)) throw new TypeError('Invalid plugin message key: ' + key);
      if (typeof value !== 'string' || !value.trim() || value.length > MAX_MESSAGE_LENGTH)
        throw new TypeError('Invalid plugin translation: ' + key);
    }
    let byLocale = this.namespaces.get(namespace);
    if (!byLocale) {
      byLocale = new Map<Locale, Catalog>();
      this.namespaces.set(namespace, byLocale);
    }
    if (byLocale.has(locale)) throw new Error('Plugin catalog already registered: ' + namespace + '@' + locale);
    const english = byLocale.get('en');
    if (locale === 'en') {
      for (const [other, otherCatalog] of byLocale)
        if (other !== 'en' && !Object.keys(otherCatalog).every(key => Object.hasOwn(catalog, key)))
          throw new Error('English catalog is missing plugin keys for ' + other);
    } else if (english && !Object.keys(catalog).every(key => Object.hasOwn(english, key))) {
      throw new Error('English catalog is missing plugin keys for ' + locale);
    }
    const frozen = Object.freeze({...catalog});
    byLocale.set(locale, frozen);
    return () => {
      const current = this.namespaces.get(namespace);
      if (current?.get(locale) !== frozen) return;
      current.delete(locale);
      if (current.size === 0) this.namespaces.delete(namespace);
    };
  }

  /** Resolves one key against the active locale, then English, then the key
   * itself. `locale` defaults to the runtime locale at call time, never a
   * value captured when a provider was initialized. */
  resolve(namespace: string, key: string, locale: Locale = getLocale()): PluginText {
    const byLocale = this.namespaces.get(namespace);
    if (!byLocale) return {text: key, fallback: 'namespace_missing'};
    const english = byLocale.get('en');
    if (!english) return {text: key, fallback: 'key_missing'};
    const translated = byLocale.get(locale);
    if (translated && Object.hasOwn(translated, key)) return {text: translated[key]!};
    if (Object.hasOwn(english, key)) return {text: english[key]!, fallback: 'locale_missing'};
    return {text: key, fallback: 'key_missing'};
  }
}

/** Resolves the declared label/glyph/accessibility roles of one contribution.
 * The accessible name falls back to the visible label; nothing here reads or
 * changes data, commands, authorization or drafts. */
export function resolveContributionPresentation(
  descriptor: UiContributionDescriptor,
  registry: PluginI18nRegistry,
  locale: Locale = getLocale(),
): ResolvedUiPresentation {
  const presentation: UiContributionPresentation = descriptor.presentation;
  const label = registry.resolve(presentation.i18nNamespace, presentation.labelKey, locale);
  const glyph = presentation.glyphKey
    ? registry.resolve(presentation.i18nNamespace, presentation.glyphKey, locale)
    : undefined;
  const a11y = presentation.a11yKey
    ? registry.resolve(presentation.i18nNamespace, presentation.a11yKey, locale)
    : label;
  const fallbackReasons = [...new Set(
    [label, glyph, a11y].flatMap(item => (item?.fallback ? [item.fallback] : [])),
  )];
  return {
    routeId: descriptor.id,
    label,
    ...(glyph ? {glyph} : {}),
    a11y,
    fallbackReasons,
  };
}
