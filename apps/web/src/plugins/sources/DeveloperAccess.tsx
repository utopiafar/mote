import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {Copy, RefreshCw, ShieldCheck, X} from 'lucide-react';
import {dateTime, errorMessage, type Api} from '../../api';
import {useResource} from '../../useResource';

type DeveloperCredential = {
    id: string;
    label: string;
    scope: 'developer';
    createdAt: string;
    revokedAt?: string;
    eventSourceIds: string[];
    eventKinds: string[];
    rateLimitPerMinute: number;
    tokenHint: string;
};
type WebhookEndpoint = {
    id: string;
    label: string;
    url: string;
    sourceIds: string[];
    eventKinds: string[];
    enabled: boolean;
    maxAttempts: number;
    createdAt: string;
    updatedAt: string;
};
type Delivery = {
    id: string;
    endpointId: string;
    endpointLabel: string;
    eventId: string;
    eventType: string;
    materialId?: string;
    sourceId?: string;
    status: 'pending' | 'success' | 'failed';
    attempts: number;
    nextAttemptAt: string;
    httpStatus?: number;
    lastError?: string;
    createdAt: string;
};
type Inventory = { credentials: DeveloperCredential[]; endpoints: WebhookEndpoint[]; deliveries: Delivery[] };
type Revealed = { kind: 'token' | 'secret'; label: string; value: string };
type CreatedCredential = { token: string; credential: DeveloperCredential };
type CreatedEndpoint = { endpoint: WebhookEndpoint; secret: string };

const splitSources = (value: string) => [...new Set(value.split(/[,;\n]/).map(item => item.trim()).filter(Boolean))];
const active = (credential: DeveloperCredential) => !credential.revokedAt;
const deliveryState = (delivery: Delivery) => delivery.status === 'success' ? moteText('成功') : delivery.status === 'failed' ? moteText('失败') : delivery.attempts > 0 ? moteText('待重试') : moteText('待投递');

export function DeveloperAccess({ api }: { api: Api }) {
    const inventory = useResource<Inventory>(api, '/api/developer');
    const [credentialLabel, setCredentialLabel] = useState('');
    const [credentialSources, setCredentialSources] = useState('');
    const [webhookLabel, setWebhookLabel] = useState('');
    const [webhookUrl, setWebhookUrl] = useState('');
    const [webhookSources, setWebhookSources] = useState('');
    const [webhookEnabled, setWebhookEnabled] = useState(true);
    const [editing, setEditing] = useState('');
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [revealed, setRevealed] = useState<Revealed>();
    const data = inventory.data;
    async function action(name: string, operation: () => Promise<void>) {
        if (busy) return;
        setBusy(name); setError(''); setMessage('');
        try { await operation(); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(''); }
    }
    async function refresh() {
        await inventory.refresh();
    }
    async function copy(value: string) {
        try { await navigator.clipboard.writeText(value); setMessage(moteText('已复制，请只粘贴到你信任的客户端。')); }
        catch { setError(moteText('当前环境无法访问剪贴板，请手动选择文本复制。')); }
    }
    function createCredential() {
        void action('credential', async () => {
            const result = await api.request<CreatedCredential>('/api/developer/credentials', { method: 'POST', body: JSON.stringify({ label: credentialLabel.trim(), sourceIds: splitSources(credentialSources) }) });
            setRevealed({ kind: 'token', label: result.credential.label, value: result.token });
            setCredentialLabel(''); setCredentialSources('');
            setMessage(moteText('开发者凭据已创建。完整令牌只在这次显示。'));
            await refresh();
        });
    }
    function saveWebhook() {
        void action('webhook', async () => {
            const body = { label: webhookLabel.trim(), url: webhookUrl.trim(), sourceIds: splitSources(webhookSources), eventKinds: ['material.archived'], enabled: webhookEnabled };
            const result = await api.request<CreatedEndpoint | { endpoint: WebhookEndpoint; secret?: string }>(editing ? `/api/developer/webhooks/${encodeURIComponent(editing)}` : '/api/developer/webhooks', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) });
            if (!editing && 'secret' in result && result.secret) setRevealed({ kind: 'secret', label: result.endpoint.label, value: result.secret });
            setEditing(''); setWebhookLabel(''); setWebhookUrl(''); setWebhookSources(''); setWebhookEnabled(true);
            setMessage(editing ? moteText('Webhook 已更新。') : moteText('Webhook 已创建。签名密钥只在这次显示。'));
            await refresh();
        });
    }
    function editEndpoint(endpoint: WebhookEndpoint) {
        setEditing(endpoint.id); setWebhookLabel(endpoint.label); setWebhookUrl(endpoint.url); setWebhookSources(endpoint.sourceIds.join(', ')); setWebhookEnabled(endpoint.enabled);
    }
    function toggleEndpoint(endpoint: WebhookEndpoint) {
        void action('toggle-' + endpoint.id, async () => {
            await api.request(`/api/developer/webhooks/${encodeURIComponent(endpoint.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !endpoint.enabled }) });
            setMessage(endpoint.enabled ? moteText('Webhook 已停用。') : moteText('Webhook 已启用。'));
            await refresh();
        });
    }
    function rotateEndpoint(endpoint: WebhookEndpoint) {
        void action('rotate-' + endpoint.id, async () => {
            const result = await api.request<{ endpoint: WebhookEndpoint; secret?: string }>(`/api/developer/webhooks/${encodeURIComponent(endpoint.id)}`, { method: 'PATCH', body: JSON.stringify({ rotateSecret: true }) });
            if (result.secret) setRevealed({ kind: 'secret', label: endpoint.label, value: result.secret });
            setMessage(moteText('签名密钥已轮换，旧密钥立即失效。'));
            await refresh();
        });
    }
    function disableEndpoint(endpoint: WebhookEndpoint) {
        void action('disable-' + endpoint.id, async () => {
            await api.request(`/api/developer/webhooks/${encodeURIComponent(endpoint.id)}`, { method: 'DELETE' });
            setMessage(moteText('Webhook 已停用，后续不会创建新投递。'));
            await refresh();
        });
    }
    function revokeCredential(credential: DeveloperCredential) {
        void action('revoke-' + credential.id, async () => {
            await api.request(`/api/developer/credentials/${encodeURIComponent(credential.id)}`, { method: 'DELETE' });
            setMessage(moteText('开发者凭据已撤销，后续 Developer API 访问立即失效。'));
            await refresh();
        });
    }
    return <section id="developer-access" className="panel developer-access" aria-labelledby="developer-access-title">
        <div className="section-heading"><div><h2 id="developer-access-title">{moteText('Webhook 与 Developer API')}</h2><p>{moteText('宿主能力，不是安装包。资料归档后按声明的来源推送；Developer API 读取同一事件流。')}</p></div><button className="button subtle" disabled={!!busy} onClick={() => void action('refresh', refresh)}><RefreshCw size={15}/>{moteText('刷新')}</button></div>
        {Boolean(error || inventory.error) && <div className="notice error" role="alert">{error || errorMessage(inventory.error)}</div>}
        {message && <div className="notice" role="status"><ShieldCheck size={16}/>{message}</div>}
        {revealed && <div className="connection-mcp" aria-label={moteText('一次性密钥')}><h3>{revealed.kind === 'token' ? moteText('开发者令牌') : moteText('Webhook 签名密钥')} · {revealed.label}</h3><p>{moteText('完整值只显示一次。关闭后只能撤销或轮换，不能再次查看。')}</p><code>{revealed.value}</code><div className="connection-actions"><button className="button" onClick={() => void copy(revealed.value)}><Copy size={15}/>{moteText('复制完整值')}</button><button className="button subtle" onClick={() => setRevealed(undefined)}>{moteText('已保存，隐藏')}</button></div></div>}
        <details className="connection-help"><summary>{moteText('新建开发者凭据')}</summary><form className="access-create-form" onSubmit={event => { event.preventDefault(); createCredential(); }}>
            <label>{moteText('凭据名称')}<input aria-label={moteText('开发者凭据名称')} value={credentialLabel} maxLength={120} required onChange={event => setCredentialLabel(event.target.value)} /></label>
            <label>{moteText('来源范围')}<input aria-label={moteText('开发者来源范围')} value={credentialSources} placeholder="source-a, source-b" required onChange={event => setCredentialSources(event.target.value)} /><small>{moteText('必须列出明确来源 ID；空范围或 * 会被拒绝。默认每分钟 60 次。')}</small></label>
            <div className="access-form-actions"><button className="button primary" disabled={!!busy || !credentialLabel.trim() || !splitSources(credentialSources).length}>{busy === 'credential' ? moteText('正在创建…') : moteText('创建开发者凭据')}</button></div>
        </form></details>
        <details className="connection-help" open={editing ? true : undefined}><summary>{editing ? moteText('更新 Webhook') : moteText('新建 Webhook')}</summary><form className="access-create-form" onSubmit={event => { event.preventDefault(); saveWebhook(); }}>
            <label>{moteText('端点名称')}<input aria-label={moteText('Webhook 端点名称')} value={webhookLabel} maxLength={120} required onChange={event => setWebhookLabel(event.target.value)} /></label>
            <label>{moteText('目标 URL')}<input aria-label={moteText('Webhook 目标 URL')} type="url" value={webhookUrl} placeholder="http://127.0.0.1:5678/webhook/mote" maxLength={2048} required onChange={event => setWebhookUrl(event.target.value)} /><small>{moteText('只允许 http(s)。本机或局域网目标可以填写；云元数据地址、账号密码和重定向会被拒绝。')}</small></label>
            <label>{moteText('来源范围')}<input aria-label={moteText('Webhook 来源范围')} value={webhookSources} placeholder="source-a, source-b" required onChange={event => setWebhookSources(event.target.value)} /><small>{moteText('必须列出明确来源 ID；空范围或 * 不会投递。')}</small></label>
            <label className="plugin-confirm"><input type="checkbox" checked={webhookEnabled} onChange={event => setWebhookEnabled(event.target.checked)} /><span>{moteText('启用此端点')}</span></label>
            <div className="access-form-actions">{editing && <button type="button" className="button subtle" disabled={!!busy} onClick={() => { setEditing(''); setWebhookLabel(''); setWebhookUrl(''); setWebhookSources(''); setWebhookEnabled(true); }}>{moteText('取消编辑')}</button>}<button className="button primary" disabled={!!busy || !webhookLabel.trim() || !webhookUrl.trim() || !splitSources(webhookSources).length}>{busy === 'webhook' ? moteText('正在保存…') : editing ? moteText('保存 Webhook') : moteText('创建 Webhook')}</button></div>
        </form></details>
        <div className="access-list-heading"><h3>{moteText('开发者凭据')}</h3><span>{moteText('{0} 个有效凭据', data?.credentials.filter(active).length ?? 0)}</span></div>
        {!data ? inventory.loading && <p role="status">{moteText('正在读取…')}</p> : <>{data.credentials.length ? <ul className="connection-list access-list">{data.credentials.map(credential => <li key={credential.id}><div><strong>{credential.label}</strong><p>{moteText('只读事件 · 来源：{0}', credential.eventSourceIds.join('、'))} · {moteText('每分钟 {0} 次', credential.rateLimitPerMinute)}</p><small><code>{credential.tokenHint}</code> · {credential.revokedAt ? moteText('已撤销') : credential.eventKinds.join(', ')}</small></div>{active(credential) ? <button className="text-button danger" disabled={!!busy} onClick={() => revokeCredential(credential)}><X size={14}/>{moteText('撤销')}</button> : <span className="badge muted">{moteText('已撤销')}</span>}</li>)}</ul> : <p className="fine-print">{moteText('还没有开发者凭据。新建后可用于 n8n 或社区脚本拉取事件。')}</p>}</>}
        <div className="access-list-heading"><h3>{moteText('Webhook 端点')}</h3><span>{moteText('{0} 个端点', data?.endpoints.length ?? 0)}</span></div>
        {!data ? null : <>{data.endpoints.length ? <ul className="connection-list access-list">{data.endpoints.map(endpoint => <li key={endpoint.id}><div><strong>{endpoint.label}</strong><p><code>{endpoint.url}</code></p><small>{endpoint.enabled ? moteText('已启用') : moteText('已停用')} · {moteText('来源：{0}', endpoint.sourceIds.join('、'))} · {moteText('最多尝试 {0} 次', endpoint.maxAttempts)}</small></div><div className="connection-actions"><button className="button subtle" disabled={!!busy} onClick={() => editEndpoint(endpoint)}>{moteText('编辑')}</button><button className="button subtle" disabled={!!busy} onClick={() => toggleEndpoint(endpoint)}>{endpoint.enabled ? moteText('停用') : moteText('启用')}</button><button className="button subtle" disabled={!!busy} onClick={() => rotateEndpoint(endpoint)}>{moteText('轮换密钥')}</button>{endpoint.enabled && <button className="text-button danger" disabled={!!busy} onClick={() => disableEndpoint(endpoint)}>{moteText('撤销')}</button>}</div></li>)}</ul> : <p className="fine-print">{moteText('还没有 Webhook。空目标、空范围或未启用的端点都不会投递。')}</p>}</>}
        <div className="access-list-heading"><h3>{moteText('最近投递')}</h3></div>
        {!data ? null : data.deliveries.length ? <ul className="connection-list access-list">{data.deliveries.map(delivery => <li key={delivery.id}><div><strong>{delivery.endpointLabel}</strong><p>{delivery.eventType} · {delivery.materialId ?? delivery.eventId}</p><small>{moteText('尝试 {0} 次', delivery.attempts)}{delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ''} · {dateTime(delivery.createdAt)}{delivery.lastError ? ` · ${delivery.lastError}` : ''}</small></div><span className={'badge ' + (delivery.status === 'success' ? 'green' : delivery.status === 'failed' ? 'muted' : '')}>{deliveryState(delivery)}</span></li>)}</ul> : <p className="fine-print">{moteText('还没有投递记录。')}</p>}
        <details className="connection-help"><summary>{moteText('接收方验真与 Developer API')}</summary><p>{moteText('请求头包含 X-Mote-Delivery-Id、X-Mote-Event、X-Mote-Timestamp 与 X-Mote-Signature。签名值为 sha256=HMAC(secret, timestamp.deliveryId.body)。')}</p><p>{moteText('Developer API 使用独立开发者令牌读取 GET /api/developer/v1/events?after=游标&limit=50，只返回凭据声明来源的 material.archived 事件。')}</p><p>{moteText('事件只含身份、修订、来源与时间，不含正文、屏幕记录或 Coding Agent 原件。')}</p></details>
    </section>;
}
