/** Package entry for the journal example. The connector and backend plugin are
 * separate contributions of one package Manifest; both are exported from this
 * entry so a development host can load them without a second code path. */
export {default as connector} from './connector.mjs';
export {default as backendPlugin} from './backend.mjs';
export {default} from './backend.mjs';
