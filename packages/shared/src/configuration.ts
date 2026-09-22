/** Authenticated owner view. Contains private server paths; never embed in support bundles. */
export type ConfigurationSource = 'environment' | 'env-file' | 'default' | 'derived';
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
  readOnly: true;
  restartRequired: true;
  description: string;
  storage: {
    dataDir: string;
    sqlitePath: string;
    blobsDir: string;
    assetDir?: string;
    logDir: string;
    kind: 'local-directory' | 'docker-volume' | 'bind-mount' | 'unknown';
    source: string | null;
    mountPath: string | null;
    description: string;
  };
  groups: ConfigurationGroup[];
}
