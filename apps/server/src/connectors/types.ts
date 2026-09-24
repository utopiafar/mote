import type {SourceStore} from '../sources.js';
import type {Store} from '../store.js';

export interface ConnectorConfig {
  directory: string;
  /** Trusted installed modules exporting a versioned ConnectorManifest. */
  modules?: string[];
  mcpEnabled?: boolean;
  mcpReadToken?: string;
  mcpWriteEnabled?: boolean;
  mcpWriteToken?: string;
  mcpWriteSourceIds?: string[];
  allowLocalMcp?: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
  syncIntervalMs?: number;
}
export interface ConnectorContext {
  evidenceReader?: import('../evidence-reader.js').EvidenceReader;
  contextQuery?: import('../context-query.js').ContextQuery;
  materials?: import('../materials.js').MaterialStore;
  materialOrganizers?: import('../material-organizers.js').MaterialOrganizerRuntime;
  processing?: import('../processing-runtime.js').ProcessingRuntime;
  files?: import('../files.js').FileStore;
  sources: SourceStore;
  store: Store;
  config: {dataDir: string;token: string;allowedOrigins: string[];connectors?: ConnectorConfig};
  mcpAuthorization?:(header:string|undefined)=>{write:boolean;sourceIds?:string[];authorize:()=>void}|undefined;
}
export class ConnectorError extends Error {
  constructor(readonly code: string, readonly statusCode=400) {super(code);this.name='ConnectorError';}
}
