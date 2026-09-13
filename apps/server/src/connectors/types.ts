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
export interface ConnectorContext {
  sources: SourceStore;
  store: Store;
  config: {dataDir: string;token: string;allowedOrigins: string[];connectors?: ConnectorConfig};
}
export class ConnectorError extends Error {
  constructor(readonly code: string, readonly statusCode=400) {super(code);this.name='ConnectorError';}
}
