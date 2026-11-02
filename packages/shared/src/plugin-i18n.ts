/** Plugin-authored message catalogs are namespaced and resolved at call time.
 * Keys are opaque authored identifiers, never captured content; the English
 * catalog is the canonical key set and every other locale may only translate
 * those keys. Resolution reports an explicit fallback reason instead of
 * throwing, so a missing translation never changes authorization, drafts or
 * the stable route identity of a contribution. */
import {getLocale, locales, type Locale} from './i18n.js';
import {
  isToken,
  uiContributionAvailability,
  type PluginPlatform,
  type ScopedContribution,
  type UiAvailability,
  type UiAvailabilityFacts,
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
  /** Falls back to the visible label when the declared key has no readable
   * message, so the accessible name is never an internal identifier. */
  readonly a11y: PluginText;
  readonly fallbackReasons: readonly PluginTextFallback[];
}

type Catalog = Readonly<Record<string, string>>;
const MAX_MESSAGE_LENGTH = 2000;

/** Reads one plain data snapshot and rejects accessors before any value is
 * read, following the adjacent strictDataObject convention. Registration
 * therefore validates and stores exactly the same values and never executes
 * caller getters. */
function catalogSnapshot(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid plugin catalog');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid plugin catalog');
  const properties = Object.getOwnPropertyDescriptors(input);
  // A null prototype keeps every accepted own key, including "__proto__",
  // which an ordinary object's inherited setter would swallow.
  const snapshot: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Reflect.ownKeys(properties)) {
    const descriptor = properties[key as string];
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
      throw new TypeError('Invalid plugin catalog fields');
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

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
    const snapshot = catalogSnapshot(catalog);
    const entries = Object.entries(snapshot);
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
        if (other !== 'en' && !Object.keys(otherCatalog).every(key => Object.hasOwn(snapshot, key)))
          throw new Error('English catalog is missing plugin keys for ' + other);
    } else if (english && !Object.keys(snapshot).every(key => Object.hasOwn(english, key))) {
      throw new Error('English catalog is missing plugin keys for ' + locale);
    }
    const frozen = Object.freeze(snapshot);
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
  const declaredA11y = presentation.a11yKey
    ? registry.resolve(presentation.i18nNamespace, presentation.a11yKey, locale)
    : undefined;
  // A declared key that resolves to itself carries no readable message (the
  // namespace or key is missing). Use the visible label and keep the reason;
  // an English translation for a missing target locale stays readable.
  const a11y = !declaredA11y ? label
    : declaredA11y.fallback === 'key_missing' || declaredA11y.fallback === 'namespace_missing'
      ? {text: label.text, fallback: declaredA11y.fallback}
      : declaredA11y;
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

/** A theme/layout contribution paired with one exact presentation reference.
 * The presentation host still owns registration, activation and the safe
 * builtin fallback; this only binds the descriptor's availability and
 * runtime-resolved label roles to the pack identity it names. */
export interface PresentationContributionBinding {
  readonly kind: 'theme' | 'layout';
  readonly reference: {readonly id: string; readonly version: string};
  readonly availability: UiAvailability;
  readonly presentation: ResolvedUiPresentation;
}

const presentationId = /^[a-z][a-z0-9.-]*$/;
const presentationVersion = /^\d+(?:\.\d+)*$/;

function contributionKey(contribution: ScopedContribution): string {
  return contribution.packageId + '/' + contribution.descriptor.id + '@' + contribution.descriptor.apiVersion;
}

/** Host-owned, explicit mapping from one scoped contribution to the exact
 * presentation pack it provides. The frozen descriptor has no pack-reference
 * field, so a binding only exists after this mapping is registered; a pack
 * cannot be claimed by two contributions and an unmapped contribution never
 * yields an active binding. */
export class PresentationContributionRegistry {
  private readonly mappings = new Map<string, {kind: 'theme' | 'layout'; reference: {id: string; version: string}}>();

  register(contribution: ScopedContribution, reference: {readonly id: string; readonly version: string}): () => void {
    const {descriptor} = contribution;
    const kind = descriptor.kind;
    if (kind !== 'theme' && kind !== 'layout')
      throw new TypeError('Not a theme or layout contribution');
    if (!presentationId.test(reference.id) || !presentationVersion.test(reference.version))
      throw new TypeError('Invalid presentation reference');
    const key = contributionKey(contribution);
    if (this.mappings.has(key)) throw new Error('Presentation contribution already mapped');
    const pack = reference.id + '@' + reference.version;
    for (const existing of this.mappings.values())
      if (existing.reference.id + '@' + existing.reference.version === pack)
        throw new Error('Presentation pack already mapped to another contribution');
    const mapping = {kind, reference: {id: reference.id, version: reference.version}};
    this.mappings.set(key, mapping);
    return () => {
      if (this.mappings.get(key) === mapping) this.mappings.delete(key);
    };
  }

  bind(
    contribution: ScopedContribution,
    catalogs: PluginI18nRegistry,
    platform: PluginPlatform,
    facts: UiAvailabilityFacts,
    locale: Locale = getLocale(),
  ): PresentationContributionBinding {
    const mapping = this.mappings.get(contributionKey(contribution));
    if (!mapping) throw new Error('Presentation contribution is not mapped');
    if (mapping.kind !== contribution.descriptor.kind) throw new Error('Presentation kind mismatch');
    return {
      kind: mapping.kind,
      reference: {id: mapping.reference.id, version: mapping.reference.version},
      availability: uiContributionAvailability(contribution.descriptor, platform, facts),
      presentation: resolveContributionPresentation(contribution.descriptor, catalogs, locale),
    };
  }
}
