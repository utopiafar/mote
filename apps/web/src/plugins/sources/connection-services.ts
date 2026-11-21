import {pageHash, type PluginBuildView, type PluginCenterView, type PluginSourceContribution, type ServiceItem, type SourceConnection} from '@mote/shared';
import {ApiError, type Api} from '../../api';
import {resources} from '../../resource-cache';
import {navStateReader} from '../../use-nav-state';
import {officialConnectorDefinitions} from './OfficialConnectorSettings';

export const servicesPath = '/api/connections/services';
export const sourcesPath = '/api/sources';

const bundled = new Map([
  ['gmail', {connector: 'gmail', settings: () => pageHash('connections', {setup: 'gmail'})}],
  ['google-calendar', {connector: 'google', settings: () => pageHash('connections', {setup: 'google'})}],
  ['lark', {connector: 'lark', settings: () => pageHash('lark')}],
  ...['feishu-recordings', 'dingtalk-recordings'].map(id => [id, {
    connector: id, settings: () => pageHash('library', {recordings: id}),
  }] as const),
]);
const installed = new Map<string, {connector: string; packageId: string}>(
  Object.entries(officialConnectorDefinitions).map(([connector, {id, packageId}]) => [id, {connector, packageId}]),
);
const libraryKinds = new Set(['local-calendar', 'local-files', 'local-meeting-recording', 'coding-agent', 'upload']);
const hashHref = (href: string | undefined) => href && href.startsWith('#/') && href.length <= 512 && !/[\r\n\0]/.test(href) ? href : undefined;

export type ConnectionControl = {buildId?: string; packageId?: string; contributionId?: string; sourceId?: string};
export type ConnectionTarget = {settings?: string; sync?: string; control?: ConnectionControl};

/** A manifest service is identified by `sourceCatalog.id`; its source kinds are
 * independent. Match a service to its sources by the job kinds Central already
 * projects, and to an installed contribution by its declared kinds when the
 * service is paused and has no fetch jobs. */
export function connectionTarget(service: ServiceItem, sources: readonly SourceConnection[], contributions: readonly PluginSourceContribution[] = []): ConnectionTarget | undefined {
  const builtin = bundled.get(service.id);
  if (builtin) return {settings: builtin.settings(), sync: `/api/connectors/${builtin.connector}/sync`, control: {buildId: `bundled:${service.id}`}};
  const plugin = installed.get(service.id);
  if (plugin) return {
    settings: pageHash('connections', {setup: service.id}), sync: `/api/connectors/${plugin.connector}/sync`,
    control: {packageId: plugin.packageId, contributionId: service.id},
  };
  if (service.id === 'mcp') return {settings: pageHash('connections', {setup: 'mcp'})};
  if (libraryKinds.has(service.id)) return;
  const serviceKinds = new Set([service.id, ...service.jobs.map(job => job.kind)]);
  const kindMatches = contributions.filter(item => item.kinds.some(kind => serviceKinds.has(kind)));
  const contribution = contributions.find(item => item.contributionId === service.id) ?? (kindMatches.length === 1 ? kindMatches[0] : undefined);
  const kinds = new Set([...serviceKinds, ...(contribution?.kinds ?? [])]);
  const matching = sources.filter(source => kinds.has(source.kind) && source.platform === 'import' && source.id !== 'manual-references');
  if (!matching.length && !contribution) return;
  const settings = contribution ? hashHref(contribution.target?.href) : matching.length === 1 ? pageHash('connections', {sourceId: matching[0].id}) : undefined;
  const control: ConnectionControl | undefined = contribution
    ? {packageId: contribution.packageId, contributionId: contribution.contributionId}
    : matching.length === 1 ? {sourceId: matching[0].id} : undefined;
  return {...(settings ? {settings} : {}), ...(control ? {control} : {})};
}

export function refreshConnections(api: Api, changedPath?: string) {
  resources(api).invalidate(path => path === servicesPath || path === changedPath);
  navStateReader(api).refresh();
}

export function connectionReadState(error: unknown) {
  if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) return 'expired';
  return error instanceof TypeError || typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'failed';
}

export async function setConnectionEnabled(api: Api, target: NonNullable<ConnectionTarget['control']>, enabled: boolean, signal: AbortSignal) {
  const action = enabled ? 'enable' : 'disable';
  if (target.buildId) {
    const path = '/api/plugin-builds/' + encodeURIComponent(target.buildId);
    const build = await api.request<PluginBuildView>(path, {signal});
    signal.throwIfAborted();
    if (Boolean(build.desired) === enabled) return;
    if (build.id !== target.buildId || !build.version || !build.allowedActions?.includes(action)) throw new Error('Unavailable connector build');
    const selection = enabled ? {packageId: build.packageId, version: build.version, configurationRevision: 0} : null;
    await api.request(path, {method: 'PATCH', signal, body: JSON.stringify({selection, expectedRevision: build.revision, operationId: crypto.randomUUID()})});
  } else if (target.packageId) {
    const view = await api.request<PluginCenterView>('/api/plugins', {signal});
    signal.throwIfAborted();
    const contribution = view.sourceContributions?.find(item => item.contributionId === target.contributionId && item.packageId === target.packageId);
    const instance = view.instances.find(item => item.id === contribution?.instanceId && item.packageId === target.packageId);
    if (!instance?.allowedActions.includes(action)) throw new Error('Unavailable connector instance');
    await api.request(`/api/plugin-instances/${encodeURIComponent(instance.id)}/${action}`, {
      method: 'POST', signal, body: JSON.stringify({expectedRevision: instance.revision, operationId: crypto.randomUUID()}),
    });
  } else if (target.sourceId) {
    await api.request(`${sourcesPath}/${encodeURIComponent(target.sourceId)}`, {method: 'PATCH', signal, body: JSON.stringify({enabled})});
  }
}
