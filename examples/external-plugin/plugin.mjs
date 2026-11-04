/** Package entry for the external source example. The connector manifest is
 * the same object the optional `source.mjs` adapter exposes to a direct
 * connector host; the package Manifest declares this entry as its ingress
 * contribution. */
export {default as connector, default, sdkVersion} from './source.mjs';
