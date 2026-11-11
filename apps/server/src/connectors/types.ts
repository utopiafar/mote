import type {StateStore} from '@mote/plugin-api';
import type {SourceStore} from '../sources.js';
import type {Store} from '../store.js';

export interface ConnectorConfig {
  directory: string;
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
/** Host-resolved configuration for one installed package instance. Secret
 * references are resolved by the host; plaintext credentials never enter a
 * package manifest or the persisted instance view. */
export interface ConnectorActivation {
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly secrets: Readonly<Record<string, string>>;
}
export interface ConnectorContext {
  memoryRecipeSettings?:import('../memory-recipe-settings.js').MemoryRecipeSettings;
  diagnostics?:import('../diagnostics.js').ServerDiagnostics;
  memoryStrategies?: import('../memory-strategies.js').MemoryStrategies;
  sourcePipelines?: import('../source-pipelines.js').SourcePipelineRuntime;
  /** The one EvidenceReader owned by roots; connectors never construct their own. */
  evidenceReader: import('../evidence-reader.js').EvidenceReader;
  contextQuery?: import('../context-query.js').ContextQuery;
  materials?: import('../materials.js').MaterialStore;
  materialOrganizers?: import('../material-organizers.js').MaterialOrganizerRuntime;
  processing?: import('../processing-runtime.js').ProcessingRuntime;
  files?: import('../files.js').FileStore;
  sources: SourceStore;
  store: Store;
  /** Host-bound per-connector-instance state. The registry supplies it and the
   * plugin never chooses a package, installation or instance identity. */
  state?: StateStore;
  /** Installed-package configuration and host-resolved secret values. Built-in
   * deployment connectors keep reading their existing deployment config. */
  activation?: ConnectorActivation;
  /** Trusted transport seam for packages. Production omitted; a deployment or
   * test may inject a bounded fetch implementation without giving plugins a
   * shell or arbitrary network API. */
  fetch?: typeof fetch;
  /** Host-owned account bindings. A new source kind attaches to an existing
   * account here instead of asking for a second OAuth application. */
  bindings?: {
    readonly lark?: import('./lark-binding.js').LarkBinding;
  };
  config: {dataDir: string;token: string;allowedOrigins: string[];publicUrl?: string;connectors?: ConnectorConfig};
  ownerAuthorization?:(header:string|undefined)=>boolean;
  mcpAuthorization?:(header:string|undefined,resource?:string)=>{write:boolean;sourceIds?:string[];authorize:()=>void}|undefined;
}
export class ConnectorError extends Error {
  constructor(readonly code: string, readonly statusCode=400) {super(code);this.name='ConnectorError';}
}
