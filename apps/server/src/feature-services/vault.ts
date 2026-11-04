import type {ArchivedFileStore} from '../archived-files.js';
import type {MaintenanceWorker} from '../maintenance.js';
import type {Store} from '../store.js';

/** C02 vault members still borrowed by the feature bridge. */
export interface VaultFeatureServices {
  store:Store;
  archivedFiles:ArchivedFileStore;
  maintenanceWorker:MaintenanceWorker|undefined;
}

export const vaultFeatureServiceMembers = ['store','archivedFiles','maintenanceWorker'] as const satisfies readonly (keyof VaultFeatureServices)[];
