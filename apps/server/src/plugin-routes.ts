/** Compatibility entry for the existing app assembly. The control HTTP factory
 * lives in plugins/plugin-control-http.ts; app.ts keeps importing this name so
 * the shared composition hotspot is not edited by C08. */
export {registerPluginControlHttp as registerPluginRoutes} from './plugins/plugin-control-http.js';
