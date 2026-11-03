import {createContext} from 'react';
import type {MaintenanceController} from './controller';

/** The maintenance package creates one controller per authenticated Api. */
export interface MaintenancePluginContextValue {
  readonly controller:MaintenanceController;
}

export const MaintenanceContext = createContext<MaintenancePluginContextValue | null>(null);
