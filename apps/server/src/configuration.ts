import {moteText} from './i18n.js';
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
    description:moteText('页面与手改文件使用同一份配置；保存后按各项生效方式应用。'),
    storage:{
      dataDir,sqlitePath:join(dataDir,'mote.sqlite'),assetDir:join(dataDir,'files','objects'),
      logDir:diagnostics.directory?resolve(baseDir,diagnostics.directory):join(dataDir,'logs'),
      kind:storage.kind==='unknown'&&runtime==='native'?'local-directory':storage.kind,
      source:storage.source||(runtime==='native'?dataDir:null),mountPath:storage.mount||null,
      description:runtime==='docker'
        ?moteText('路径属于中央容器；存储来源与挂载点由部署工具提供。命名卷是 Docker 卷标识，不是宿主机目录；未提供的宿主位置不会被猜测。')
        :moteText('SQLite、图片与日志路径属于运行中央进程的机器。存储来源是部署声明，未扫描磁盘或推断 NAS 挂载。'),
    },
  };
}
