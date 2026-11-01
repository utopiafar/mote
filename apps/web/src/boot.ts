import { configureLocale, getLanguagePreference, negotiateLocale, loadLocale } from '@mote/shared/i18n';

const preference = getLanguagePreference();
const locale = preference === 'system' ? negotiateLocale(navigator.languages) : preference;
configureLocale(() => locale);

// Module-level presentation strings in main's imports must see the loaded catalogs.
void loadLocale(locale).catch(() => undefined).then(() => import('./main'));
