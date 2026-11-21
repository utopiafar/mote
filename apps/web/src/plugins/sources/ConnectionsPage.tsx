import {useContext, useEffect, useRef, useState} from 'react';
import {Plus} from 'lucide-react';
import {pageRoutes, servicesViewSchema, type ConnectionJob, type ServiceItem, type SourceConnection} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ago, type Api} from '../../api';
import {Loading} from '../../Loading';
import {NavStateContext} from '../../use-nav-state';
import {useResource} from '../../useResource';
import {AiAccessOverview} from '../agent-access/AiAccessOverview';
import {
  connectionReadState, connectionTarget, refreshConnections, servicesPath, setConnectionEnabled, sourcesPath, type ConnectionTarget,
} from './connection-services';
import {OnboardingScan} from './OnboardingScan';

export const connectionCatalogRoute = pageRoutes.connections + '/add';

const stateLabels = {
  connected: () => moteText('已连接'), reauth: () => moteText('需要重新授权'),
  error: () => moteText('需要处理'), paused: () => moteText('已暂停'),
};
const jobLabels = new Map([
  ['lark-docs', () => moteText('文档')], ['mote.official.notion', () => moteText('页面')],
  ['lark-calendar', () => moteText('日程')], ['google-calendar', () => moteText('日程')],
  ['gmail', () => moteText('邮件')], ['mote.official.slack', () => moteText('消息')], ['mote.official.feishu-session', () => moteText('消息')],
  ['dingtalk.recordings', () => moteText('录音')], ['feishu.recordings', () => moteText('录音')],
]);

function Job({job}: {job: ConnectionJob}) {
  const interval = /^(\d+)(m|s)$/.exec(job.every ?? '');
  const every = interval ? (interval[2] === 'm' ? moteText('每 {0} 分钟', interval[1]) : moteText('每 {0} 秒', interval[1])) : job.every;
  const kind = jobLabels.get(job.kind)?.() ?? job.kind;
  return <li className="connection-job" data-job-kind={job.kind}>
    {kind}{every && <> · {every}</>}{job.lastAt && <> · <time dateTime={job.lastAt}>{ago(job.lastAt)}</time></>}
    {job.lastCount !== undefined && <> {moteText('{0} 条', job.lastCount)}</>}
  </li>;
}

function ServiceCard({api, item, target}: {api: Api; item: ServiceItem; target: ConnectionTarget}) {
  type Status = {api: Api; busy?: true; failed?: true; count?: number; synced?: true};
  const [status, setStatus] = useState<Status>();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {request.current?.abort(); request.current = null;}, [api]);
  const current = status?.api === api ? status : undefined;
  const {settings, sync, control} = target;
  const canSync = Boolean(sync && item.actions.includes('sync'));
  const canDryRun = item.actions.includes('dry-run');
  const canReauthorize = Boolean(settings && item.actions.includes('reauth'));
  const pause = item.actions.includes('pause');
  const toggle = Boolean(control && (pause || item.actions.includes('resume')));

  async function run(action: 'sync' | 'dry-run' | 'toggle') {
    if (request.current) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    request.current = controller;
    setStatus({api, busy: true});
    try {
      let next: Status = {api};
      if (action === 'dry-run') {
        const result = await api.request<{count: number}>(`${servicesPath}/${encodeURIComponent(item.id)}/dry-run`, {method: 'POST', body: '{}', signal});
        if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error('Invalid dry-run count');
        next = {api, count: result.count};
      } else if (action === 'sync' && sync) {
        await api.request(sync, {method: 'POST', body: '{}', signal});
        next = {api, synced: true};
      } else if (action === 'toggle' && control) {
        await setConnectionEnabled(api, control, !pause, signal);
      }
      if (!controller.signal.aborted) setStatus(next);
    } catch {
      if (!controller.signal.aborted) setStatus({api, failed: true});
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (action !== 'dry-run') refreshConnections(api, action === 'toggle' && control?.packageId ? '/api/plugins' : sourcesPath);
      }
    }
  }

  return <article className="connection-card" data-service-id={item.id} data-state={item.state}>
    <header className="connection-line">
      <div className="connection-service-name"><h2>{item.name}</h2> <code>{item.id}</code></div>
      <div className="connection-service-state">
        <span className="connection-status" data-state={item.state}>{stateLabels[item.state]()}</span>
        {toggle && <button className="connection-switch" type="button" role="switch" aria-checked={pause} aria-label={item.name}
          disabled={current?.busy} onClick={() => void run('toggle')}/>}
      </div>
    </header>
    {(item.jobs.length > 0 || item.tools.length > 0) && <div className="connection-facts">
      {item.jobs.length > 0 && <ul aria-label={moteText('取数任务')}>{item.jobs.map((job, index) => <Job key={`${job.kind}:${index}`} job={job}/>)}</ul>}
      {item.tools.length > 0 && <ul aria-label={moteText('助理工具')}>{item.tools.map(tool => <li key={tool} className="connection-tool"><code>{tool}</code></li>)}</ul>}
    </div>}
    {(canSync || canDryRun || canReauthorize || settings) && <div className="connection-actions-inline connection-service-actions">
      {canSync && <button data-action="sync" className="text-button" disabled={current?.busy} onClick={() => void run('sync')}>{moteText('立即同步')}</button>}
      {canDryRun && <button data-action="dry-run" className="text-button" disabled={current?.busy} onClick={() => void run('dry-run')}>{moteText('试运行')}</button>}
      {canReauthorize && <a className="text-button" data-action="reauth" href={settings}>{moteText('重新授权')}</a>}
      {settings && <a className="text-button" data-action="settings" href={settings}>{moteText('设置')}</a>}
    </div>}
    {current?.failed ? <p role="alert">{moteText('操作失败')}</p> : current?.count !== undefined
      ? <p role="status">{moteText('试运行 · {0} 条', current.count)}</p> : current?.synced && <p role="status">{moteText('已发起同步')}</p>}
  </article>;
}

export function ConnectionsPage({api}: {api: Api}) {
  const revisions = useContext(NavStateContext)?.revisions;
  const services = useResource<unknown>(api, servicesPath, undefined, revisions?.plugins);
  const sources = useResource<{items: SourceConnection[]}>(api, sourcesPath);
  const parsed = services.data !== undefined && servicesViewSchema.safeParse(services.data);
  const view = !services.error && parsed && parsed.success ? parsed.data : undefined;
  const sourceItems = sources.error ? [] : sources.data?.items ?? [];
  const cards = view?.services.flatMap(item => {
    if (item.kind !== 'service') return [];
    const target = connectionTarget(item, sourceItems);
    return target ? [{item, target}] : [];
  }) ?? [];
  const access = view?.services.filter(item => item.kind === 'ai-access') ?? [];
  const failure = services.error ? connectionReadState(services.error) : parsed && !parsed.success ? 'failed' : undefined;
  const loading = !failure && (!view || !cards.length && !access.length && sources.loading);

  useEffect(() => {
    if (document.head.querySelector('link[data-mote-connections]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./connections-page.css?no-inline', import.meta.url).href;
    link.dataset.moteConnections = '';
    document.head.append(link);
  }, []);

  return <section className="connections-overview" aria-labelledby="connections-heading" data-state={failure ?? (loading ? 'loading' : sources.error ? 'partial' : 'ready')}>
    <header className="connection-line connections-heading">
      <h1 id="connections-heading">{moteText('连接')}</h1>
      <a className="button" href={'#/' + connectionCatalogRoute}><Plus size={16} aria-hidden="true"/>{moteText('新建')}</a>
    </header>
    {loading && <Loading/>}
    {failure && <p className="connection-feedback" role="alert">{failure === 'expired' ? moteText('已失效') : failure === 'offline' ? moteText('没连上') : moteText('读取失败')}
      {' '}<button className="text-button" onClick={services.refresh}>{moteText('重试')}</button>
    </p>}
    {view && Boolean(sources.error) && <p className="connection-feedback" role="alert">{moteText('部分内容读取失败')}
      {' '}<button className="text-button" onClick={sources.refresh}>{moteText('重试')}</button>
    </p>}
    {view && (cards.length || access.length ? <>
      {cards.length > 0 && <div className="connection-service-list">
        {cards.map(({item, target}) => <ServiceCard key={item.id} api={api} item={item} target={target}/>)}
      </div>}
      <AiAccessOverview api={api} items={access} onRevoked={() => refreshConnections(api, '/api/connections')}/>
      <OnboardingScan api={api} sources={sourceItems} disabled={sources.loading || Boolean(sources.error)}/>
    </> : !loading && !sources.error && <p className="connection-empty" role="status">{moteText('还没有连接')}</p>)}
  </section>;
}
