/** The Mac helper ships inside the client build; its provider descriptor is
 * projected from the same default inventory a packaged manifest enters. */
import {defaultDesktopPluginInventory, registerDesktopNativeProviders} from '../plugin-inventory';
import type {BuiltinDesktopPlugin} from './index';

export const nativeHelperPlugin: BuiltinDesktopPlugin = {
  id: 'mote.native-helper',
  register({host, appVersion}) {
    registerDesktopNativeProviders(host.native, defaultDesktopPluginInventory, appVersion);
  },
};
