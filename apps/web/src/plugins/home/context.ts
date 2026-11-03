import {createContext} from 'react';
import type {HomeController} from './controller';
import type {HomeMaterialCache} from './material-reads';

/** The plugin boundary creates these once per authenticated Api. Page
 * components only subscribe; they never construct reads or pollers. */
export interface HomePluginContextValue {
  readonly controller:HomeController;
  readonly materials:HomeMaterialCache;
}
export const HomePluginContext=createContext<HomePluginContextValue|null>(null);
