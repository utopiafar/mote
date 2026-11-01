import { english } from './i18n-en.js';
import { japanese } from './i18n-ja.js';
import { french } from './i18n-fr.js';
import { german } from './i18n-de.js';
import { spanish } from './i18n-es.js';
import { russian } from './i18n-ru.js';
import { registerCatalog } from './i18n.js';

registerCatalog('en', english);
registerCatalog('ja', japanese);
registerCatalog('fr', french);
registerCatalog('de', german);
registerCatalog('es', spanish);
registerCatalog('ru', russian);
