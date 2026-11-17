/** Authenticated owner view. Contains private server paths; never embed in support bundles. */
export type ConfigurationSource = 'config-file' | 'default' | 'derived';
export type ConfigurationEffect = 'immediate' | 'next-request' | 'next-admission' | 'restart' | 'migration';
export interface ConfigFieldMetadata {
  path: string;
  label?: string;
  description?: string;
  sensitive?: boolean;
  effect?: ConfigurationEffect;
}
export interface ConfigDomainView {
  id: string;
  /** Secret fields are represented by configured-status booleans, never credentials. */
  saved: unknown;
  effective: unknown;
  fields: ConfigFieldMetadata[];
  status: 'applied' | 'restart-required' | 'invalid';
  error?: string;
}
export interface ConfigServiceView {
  version: 1;
  revision: number;
  configFile: string;
  domains: ConfigDomainView[];
  lastError: {code: string; domain?: string} | null;
}
export interface ServerConfiguration extends ConfigServiceView {
  profile: string;
  runtime: 'native' | 'docker' | 'unknown';
  /** Optional host edit location, distinct from the loaded configFile. */
  hostConfigFile: string | null;
  ownerCredential:{configured:boolean;source:'configured-value'|'private-token-file'|'programmatic'};
  baseDir: string;
  readOnly: boolean;
  restartRequired: boolean;
  description: string;
  storage: {
    dataDir: string;
    sqlitePath: string;
    assetDir: string;
    logDir: string;
    kind: 'local-directory' | 'docker-volume' | 'bind-mount' | 'unknown';
    source: string | null;
    mountPath: string | null;
    description: string;
  };
}
