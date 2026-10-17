import {moteText} from '@mote/shared/i18n';
import type {Api} from './api';
import {RuntimeSettings} from './RuntimeSettings';
import {IndexMaintenance} from './IndexMaintenance';

export function InstanceControls({api}:{api:Api}){
 if(api.connection?.mode!=='web'||!api.connection.administrator)return null;
 return <details className="panel panel-pad"><summary>{moteText('实例运行设置与索引维护')}</summary><p>{moteText('仅管理员可修改实例参数；此处不提供其他账号的资料或详细过程。')}</p><RuntimeSettings key={'execution:'+JSON.stringify(api.connection)} api={api} kind="execution"/><RuntimeSettings key={'diagnostics:'+JSON.stringify(api.connection)} api={api} kind="diagnostics"/><IndexMaintenance key={JSON.stringify(api.connection)} api={api}/></details>;
}
