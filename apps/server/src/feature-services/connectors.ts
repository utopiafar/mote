import type {ConnectorHostAdapter} from '../plugins/connector-host-adapter.js';

/** C12-C16 connector member. */
export interface ConnectorsFeatureServices {
  connectors:ConnectorHostAdapter;
}

export const connectorsFeatureServiceMembers = ['connectors'] as const satisfies readonly (keyof ConnectorsFeatureServices)[];
