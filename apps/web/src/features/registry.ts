import {WebFeatureHost} from './host';
import {InstalledWebPlugins} from '../plugin-host/installed-plugins';
import {webPresentation} from '../presentation';
export const webFeatures=new WebFeatureHost();
export const installedWebPlugins=new InstalledWebPlugins(webFeatures,webPresentation);
