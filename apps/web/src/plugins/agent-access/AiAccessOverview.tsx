import {useEffect, useRef, useState} from 'react';
import {Bot, Plus} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {ServiceItem} from '@mote/shared';
import {dateTime, type Api} from '../../api';
import {useResource} from '../../useResource';
import {AccessRevocation, revokeAccess} from './AccessRevocation';
import {agentInspectorHref, aiAccessHref} from './routes';

const scopes = {
  'mcp-read': () => moteText('只读'),
  'mcp-write': () => moteText('仅写入指定来源'),
  'mcp-calendar': () => moteText('创建日程'),
};
type AccessDetails = {id: string; scope: keyof typeof scopes; expiresAt?: string; revokedAt?: string};

export function AiAccessOverview({api, items, onRevoked}: {
  api: Api; items: readonly ServiceItem[]; onRevoked: () => void;
}) {
  const inventory = useResource<{items: AccessDetails[]}>(api, items.length ? '/api/connections' : null);
  const [choice, setChoice] = useState<{api: Api; id: string}>();
  const [removed, setRemoved] = useState<{api: Api; ids: string[]}>();
  const [feedback, setFeedback] = useState<{api: Api; failed: boolean}>();
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {request.current?.abort(); request.current = null;}, [api]);
  const details = new Map(inventory.error ? [] : inventory.data?.items.map(item => [item.id, item]));
  const visibleItems = items.filter(item => !(removed?.api === api && removed.ids.includes(item.id)) && !details.get(item.id)?.revokedAt);
  const selected = choice?.api === api ? visibleItems.find(item => item.id === choice.id && item.actions.includes('remove') && details.has(item.id)) : undefined;

  async function revoke(id: string) {
    if (selected?.id !== id || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFeedback(undefined);
    try {
      await revokeAccess(api, id, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
      if (controller.signal.aborted) return;
      setRemoved(current => ({api, ids: [...(current?.api === api ? current.ids : []), id]}));
      setChoice(undefined);
      setFeedback({api, failed: false});
      onRevoked();
    } catch {
      if (!controller.signal.aborted) setFeedback({api, failed: true});
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  const failed = feedback?.api === api && feedback.failed;
  const revokeError = failed && <p role="alert">{moteText('撤销失败')}</p>;
  return <section className="connection-ai" aria-labelledby="connection-ai-title">
    <header className="connection-line">
      <h2 id="connection-ai-title"><a href={aiAccessHref()}>{moteText('AI 接入')}</a></h2>
      <div className="connection-actions-inline">
        <a className="text-button" href={agentInspectorHref()}>{moteText('Agent 视角')}</a>
        <a className="text-button" href={aiAccessHref('new')}><Plus size={15} aria-hidden="true"/>{moteText('新增')}</a>
      </div>
    </header>
    {feedback?.api === api && !feedback.failed && <p role="status">{moteText('连接凭据已撤销，归档资料保留。')}</p>}
    {!selected && revokeError}
    {Boolean(inventory.error) && <p className="connection-feedback" role="alert">{moteText('部分内容读取失败')} <button className="text-button" onClick={inventory.refresh}>{moteText('重试')}</button></p>}
    {visibleItems.length > 0 && <ul className="connection-ai-list">
      {visibleItems.map(item => {
        const detail = details.get(item.id);
        const scope = detail && Object.hasOwn(scopes, detail.scope) ? scopes[detail.scope]() : undefined;
        const expires = detail?.expiresAt ? moteText('{0} 到期', dateTime(detail.expiresAt)) : undefined;
        const state = item.state === 'reauth' ? moteText('已到期') : expires;
        return <li key={item.id} data-access-id={item.id} data-state={item.state}>
          <Bot size={18} aria-hidden="true"/>
          <div><a href={aiAccessHref(item.id)}>{item.name}</a>{(scope || state) && <small>{[scope, state].filter(Boolean).join(' · ')}</small>}</div>
          {item.actions.includes('remove') && <button className="text-button connection-ai-revoke" disabled={!detail || busy} onClick={() => {setChoice({api, id: item.id}); setFeedback(undefined);}}>{moteText('撤销')}</button>}
        </li>;
      })}
    </ul>}
    {selected && <AccessRevocation key={selected.id} label={selected.name} calendar={details.get(selected.id)?.scope === 'mcp-calendar'} busy={busy}
      error={revokeError} cancel={() => {setChoice(undefined); setFeedback(undefined);}} confirm={() => void revoke(selected.id)}/>}
  </section>;
}
