import type {ReactNode} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {useResource} from '../../useResource';

/** A stopped connector keeps its authorization and archived source. Explain
 * the plugin selection before asking the owner to authorize the account again. */
export function BundledConnector({api,id,children}:{api:Api;id:string;children:ReactNode}){
  const status=useResource<{pluginStates?:Record<string,{enabled:boolean}>}>(api,'/api/connectors/status',3000);
  if(status.data?.pluginStates?.[id]?.enabled===false)return <section className="connector-section"><p role="status">{moteText('插件已停用。可在插件中心重新开启。')}</p><a className="text-button" href="#/system/plugins?tab=installed">{moteText('前往插件中心')}</a></section>;
  return children;
}
