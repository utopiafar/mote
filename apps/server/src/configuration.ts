import {join,resolve} from 'node:path';
import type {ServerConfiguration} from '@mote/shared';
import {serverConfigDomain,storageConfigDomain,diagnosticsConfigDomain,type ConfigurationBootstrap} from './config.js';
import type {ConfigService} from './config-service.js';

/** Strip credential-bearing URL components at owner presentation boundaries. */
export function configurationUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

/** The authenticated owner sees the same redacted saved/effective domains that accept updates. */
export function serverConfiguration(bootstrap:ConfigurationBootstrap,service:ConfigService):ServerConfiguration {
  const view=service.view(),server=service.current(serverConfigDomain),storage=service.current(storageConfigDomain),diagnostics=service.current(diagnosticsConfigDomain);
  const {dataDir,baseDir}=bootstrap,runtime=server.runtime;
  return {
    ...view,profile:server.profile,runtime,baseDir,hostConfigFile:server.hostConfigFile||null,
    ownerCredential:{configured:Boolean(bootstrap.owner.token),source:bootstrap.owner.source},
    readOnly:false,restartRequired:view.domains.some(domain=>domain.status==='restart-required'),
    description:'shared-configuration',
    storage:{
      dataDir,sqlitePath:join(dataDir,'mote.sqlite'),assetDir:join(dataDir,'files','objects'),
      logDir:diagnostics.directory?resolve(baseDir,diagnostics.directory):join(dataDir,'logs'),
      kind:storage.kind==='unknown'&&runtime==='native'?'local-directory':storage.kind,
      source:storage.source||(runtime==='native'?dataDir:null),mountPath:storage.mount||null,
      description:runtime==='docker'?'container-storage':'host-storage',
    },
  };
}
