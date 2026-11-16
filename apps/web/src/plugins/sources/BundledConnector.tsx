import type {ReactNode} from 'react';
import type {PluginCenterView} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {useResource} from '../../useResource';
import {connectorFailure} from '../../source-connectors-ui';
import {Loading} from '../../Loading';

/** A stopped connector keeps its authorization and archived source. Explain
 * the plugin selection before asking the owner to authorize the account again. */
export function BundledConnector({api,id,children}:{api:Api;id:string;children:ReactNode}){
  const status=useResource<{pluginStates?:Record<string,{enabled:boolean}>}>(api,'/api/connectors/status',3000);
  if(status.data?.pluginStates?.[id]?.enabled===false)return <section className="connector-section"><p role="status">{moteText('插件已停用。可在插件中心重新开启。')}</p><a className="text-button" href="#/system/plugins?tab=installed">{moteText('前往插件中心')}</a></section>;
  return children;
}

/** Installed service packages use their actual instance lifecycle, separate
 * from bundled connector switches. Unmounting withdraws every account form. */
export function InstalledConnector({api,packageId,contributionId,children}:{api:Api;packageId:string;contributionId:string;children:(instanceId:string)=>ReactNode}){
 const page=useResource<PluginCenterView>(api,'/api/plugins',3000);
 if(page.error)return <section className="connector-section"><p role="alert">{connectorFailure(page.error)}</p></section>;
 if(!page.data)return <Loading/>;
 const entry=page.data.catalog.find(item=>item.packageId===packageId);
 const packages=page.data.packages.filter(item=>item.state==='installed'&&item.source.repository===entry?.repository);
 const contributions=page.data.sourceContributions?.filter(item=>item.contributionId===contributionId&&packages.some(pkg=>pkg.id===item.packageId))??[];
 const active=contributions.flatMap(item=>page.data!.instances.filter(instance=>instance.id===item.instanceId&&instance.packageId===item.packageId&&instance.desired&&instance.observed==='ready'));
 if(active.length!==1)return <section className="connector-section"><p role="status">{moteText(!packages.length?'尚未安装':contributions.some(item=>item.state==='installed'||item.state==='configured')?'已安装，待配置':'插件已停用。可在插件中心重新开启。')}</p><a className="text-button" href={'#/system/plugins?tab='+(packages.length?'installed':'discover')}>{moteText('前往插件中心')}</a></section>;
 return children(active[0].id);
}
