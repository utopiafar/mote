import {useSyncExternalStore} from 'react';
import type {FeatureInventory as Inventory} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {webFeatures} from './features/runtime';
export function FeatureInventory({api}:{api:Api}){
  const server=useResource<Inventory>(api,'/api/features');
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const browser=webFeatures.registry.inventory(),ids=[...new Set([...(server.data?.features??[]),...browser.features].map(f=>f.id))];
  return <section className="feature-inventory"><div className="page-heading"><h1>{moteText('功能插件')}</h1><p>{moteText('以下能力来自当前宿主的实际注册。关闭展示不删除资料，也不改变模型权限。')}</p></div>{server.error!==undefined&&<p role="alert">{errorMessage(server.error)}</p>}{ids.map(id=><details className="panel panel-pad" key={id}><summary>{id}</summary>{[['server',server.data],['web',browser]].map(([host,inventory])=><div key={String(host)}><h3>{host as string}</h3>{(inventory as Inventory|undefined)?.capabilities.filter(c=>c.featureId===id).map(c=><p key={c.id}><span className="badge">{c.surface}</span> <code>{c.id}</code> · {c.version} · {c.state}</p>)}</div>)}</details>)}</section>;
}
