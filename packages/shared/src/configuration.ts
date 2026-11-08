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
export type ConfigurationValue = string | number | boolean | string[] | null;
export interface ConfigurationField {
  key: string;
  label: string;
  value: ConfigurationValue;
  description: string;
  envVar?: string;
  source: ConfigurationSource;
  unit?: string;
  visibility?: 'owner-path' | 'secret-status';
  restartRequired: boolean;
  domain?: string;
  path?: string;
  savedValue?: ConfigurationValue;
  effect?: ConfigurationEffect;
}
export interface ConfigurationGroup {
  id: string;
  title: string;
  description: string;
  fields: ConfigurationField[];
}
export interface ServerConfiguration {
  version: 1;
  profile: string;
  runtime: 'native' | 'docker' | 'unknown';
  /** Host edit location when supplied; the deployment group also exposes the effective loaded file. */
  envFile: string | null;
  baseDir: string;
  readOnly: boolean;
  restartRequired: boolean;
  revision?: number;
  configFile?: string;
  domains?: ConfigDomainView[];
  lastError?: ConfigServiceView['lastError'];
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
  groups: ConfigurationGroup[];
}
