import {useEffect, useRef, useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {ModelSettingsView} from '@mote/shared/models';
import {ApiError, type Api, errorMessage} from '../../api';
import {invalidateConfiguration} from '../../configuration-cache';
import {useResource} from '../../useResource';
import {useUnsavedChanges} from '../../unsaved';

type Settings = {enabled: boolean; modelProfileId: string | null};
type View = {revision: number; settings: Settings; configured: boolean; counts: Record<string, number>};
const path = '/api/processing/activity';

/** Activity generation has its own explicit model choice and is independent of Memory. */
export function AutomaticActivitySettings({api}: {api: Api}) {
  const activeApi = useRef(api); activeApi.current = api;
  const read = useResource<View>(api, path, 5000);
  const models = useResource<ModelSettingsView>(api, '/api/model-settings');
  const [draft, setDraft] = useState<Settings>(), [baseline, setBaseline] = useState<Settings>();
  const [revision, setRevision] = useState<number>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty);
  useEffect(() => {setDraft(undefined); setBaseline(undefined); setRevision(undefined); setBusy(false); setError(''); setSaved(false);}, [api]);
  useEffect(() => {
    if (read.data && !dirty && read.data.revision >= (revision ?? 0)) {
      setDraft({...read.data.settings}); setBaseline({...read.data.settings}); setRevision(read.data.revision);
    }
    if (read.error instanceof ApiError && [401, 403, 404, 410].includes(read.error.status)) {
      setDraft(undefined); setBaseline(undefined); setRevision(undefined);
    }
  }, [read.data, read.error, dirty, revision]);
  const change = (patch: Partial<Settings>) => {setDraft(value => value ? {...value, ...patch} : value); setSaved(false);};
  const save = async () => {
    if (!draft || revision === undefined) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const next = await api.request<View>(path, {method: 'PUT', body: JSON.stringify({revision, settings: draft})});
      if (activeApi.current !== api) return;
      setDraft({...next.settings}); setBaseline({...next.settings}); setRevision(next.revision); setSaved(true);
      invalidateConfiguration(api); read.refresh();
    } catch (failure) {
      if (activeApi.current === api) setError(errorMessage(failure));
    } finally {if (activeApi.current === api) setBusy(false);}
  };
  const profiles = models.data?.profiles ?? [];
  const missingProfile = Boolean(draft?.modelProfileId && !profiles.some(profile => profile.id === draft.modelProfileId));
  return <section className="panel runtime-settings automatic-activity-settings"><h2>{moteText('自动整理活动')}</h2>
    <p>{moteText('使用所选模型整理后续接纳的采集内容，生成可查看的活动资料。自动记忆可单独开启或暂停。')}</p>
    <p className="fine-print">{moteText('原文可能发送给所选模型服务。关闭后停止待处理任务，已保存的活动资料继续保留。')}</p>
    {read.loading && !draft && <p role="status">{moteText('正在读取…')}</p>}
    {(error || read.error !== undefined || models.error !== undefined) && <p role="alert">{error || errorMessage(read.error ?? models.error)}</p>}
    {draft && <form onSubmit={event => {event.preventDefault(); void save();}}><fieldset disabled={busy}>
      <label className="preference-toggle"><span>{moteText('自动整理新采集的活动')}</span><input type="checkbox" checked={draft.enabled} onChange={event => change({enabled: event.target.checked})}/></label>
      <label>{moteText('活动整理模型连接')}<select value={draft.modelProfileId ?? ''} onChange={event => change({modelProfileId: event.target.value || null})}>
        <option value="">{moteText('请选择模型连接')}</option>
        {missingProfile && <option value={draft.modelProfileId!}>{moteText('所选模型连接已不可用')}</option>}
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select></label>
      {draft.enabled && (!draft.modelProfileId || missingProfile) && <p role="status">{moteText('请选择可用的模型连接后启用活动整理。')}</p>}
      <button className="button primary" disabled={!dirty || busy || draft.enabled && (!draft.modelProfileId || missingProfile || models.error !== undefined)}>{busy ? moteText('保存中…') : moteText('保存并应用')}</button>
      <button className="button subtle" type="button" onClick={() => {setDraft(undefined); setBaseline(undefined); setRevision(undefined); setError(''); setSaved(false); read.refresh(); models.refresh();}}>{moteText('重新读取并还原草稿')}</button>
    </fieldset></form>}
    {saved && <p role="status">{moteText('已保存，立即生效。')}</p>}
    {read.data && <p className="fine-print">{moteText('活动整理：等待 {0}，处理中 {1}，受阻 {2}，失败 {3}，已完成 {4}', read.data.counts.waiting ?? 0, read.data.counts.running ?? 0, read.data.counts.blocked ?? 0, read.data.counts.failed ?? 0, read.data.counts.succeeded ?? 0)}</p>}
    {read.error !== undefined && <button className="button" onClick={read.refresh}>{moteText('重新读取')}</button>}
  </section>;
}
