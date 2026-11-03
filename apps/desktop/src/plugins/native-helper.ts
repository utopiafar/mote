/** The Mac helper ships inside the client build; its provider descriptor is
 * registered at startup with the running app version. */
import type {BuiltinDesktopPlugin} from './index';

export const nativeHelperPlugin: BuiltinDesktopPlugin = {
  id: 'mote.native-helper',
  register({host, appVersion}) {
    host.native.register({
      capability: 'mote.native-helper',
      apiVersion: '1',
      platform: 'mac',
      buildId: appVersion,
      osGrants: ['screen', 'accessibility', 'calendar'],
    });
  },
};
