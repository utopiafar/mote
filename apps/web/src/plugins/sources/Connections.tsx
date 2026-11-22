import { useResource } from '../../useResource';
import { readResource, resources } from '../../resource-cache';
import { moteText } from '@mote/shared/i18n';
import { connectionQrDataUrl } from '../../connection-qr';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Copy, Diamond, Download, Link2, Plus, QrCode, RefreshCw, ShieldCheck, Unplug, X ,Laptop,Smartphone} from 'lucide-react';
import { connectionServerUrl, pageHash, type ActionConnectorChoice, type ConnectionInvitation, type ServerConfiguration } from '@mote/shared';
import { ApiError, type Api, type Device, ago, dateTime, errorMessage } from '../../api';
import {useHashChoice} from '../../useHashChoice';
import {AccessRevocation, revokeAccess} from '../agent-access/AccessRevocation';
import {connectionsHref} from '../agent-access/routes';
import {servicesPath} from './connection-services';
import {DeveloperAccess} from './DeveloperAccess';
import { Loading } from '../../Loading';
const readAccess=(hash:string)=>new URLSearchParams(hash.split('?')[1]??'').get('connection');
type Credential = {
    id: string;
    label: string;
    scope: 'owner' | 'collector' | 'mcp-read' | 'mcp-write' | 'mcp-calendar' | 'developer';
    calendarName?: string;
    createdAt: string;
    revokedAt?: string;
    expiresAt?: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    serverUrl: string;
    tokenHint: string;
};
type Inventory = {
    items: Credential[];
    mcp: {
        enabled: boolean;
        writeEnabled: boolean;
        writeSourceIds: string[];
    };
};
type InvitationResponse = {
    scope: 'owner' | 'collector';
    invitation: ConnectionInvitation;
    uri: string;
};
type McpResponse = {
    credential: Credential;
    config: {
        mcpServers: Record<string, {
            type: string;
            url: string;
            headers: {
                Authorization: string;
            };
        }>;
    };
};
type OAuthRequest = {
    id: string;
    clientName: string;
    redirectUri: string;
    write: boolean;
    createdAt: string;
    expiresAt: string;
};
type McpAccess = 'read' | 'write' | 'calendar';
const calendarConnectionPath='/api/connections/mcp/calendar';
const scopes = { 'owner': "完整客户端权限", 'collector': "采集器 · 仅同步本设备", 'mcp-read': "MCP · 只读资料", 'mcp-write': "MCP · 指定来源写入", 'mcp-calendar': "MCP · 创建日程", 'developer': "开发者 · 只读事件" };
function codexCalendarConfig(config:McpResponse['config']){
    const {url,headers}=config.mcpServers.mote;
    return `[mcp_servers.mote_calendar]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(headers.Authorization)} }\ntool_timeout_sec = 120\n`;
}
function downloadFile(name: string, content: Blob) {
    const url = URL.createObjectURL(content), anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type ConnectionProps = {
    api: Api;
    serverUrl: string;
    devices: Device[];
};

export function DevicePairing({ embedded, ...props }: ConnectionProps & { embedded?: boolean }) {
    return <Connections {...props} mode="device" embedded={embedded}/>;
}

function pairingDeviceId(embedded: boolean) {
    return embedded ? '' : new URLSearchParams(window.location.hash.split('?')[1]).get('deviceId') ?? '';
}

export function Connections({ api, serverUrl, devices, mode = 'chatbot', embedded = false }: ConnectionProps & {
    mode?: 'device' | 'chatbot';
    embedded?: boolean;
}) {
    const [endpoint, setEndpoint] = useState(serverUrl);
    const [label, setLabel] = useState(moteText(mode === 'device' ? '我的新设备' : '我的 AI 助手'));
    const [deviceId, setDeviceId] = useState(() => mode === 'device' ? pairingDeviceId(embedded) : '');
    const [pairPlatform,setPairPlatform]=useState<'macos'|'android'>('macos'),[pairEditing,setPairEditing]=useState(false);
    const [deviceScope, setDeviceScope] = useState<'owner' | 'collector'>('owner');
    const inventoryResource = useResource<Inventory>(api, '/api/connections'), configuration = useResource<ServerConfiguration>(api, '/api/configuration');
    const inventory = inventoryResource.data;
    const [invite, setInvite] = useState<InvitationResponse>();
    const [qr, setQr] = useState('');
    const [mcp, setMcp] = useState<McpResponse>();
    const [mcpAccess, setMcpAccess] = useState<McpAccess>('read');
    const [calendarKey, setCalendarKey] = useState('');
    const [oauthRequests, setOauthRequests] = useState<OAuthRequest[]>([]);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [now, setNow] = useState(Date.now());
    const [revoking, setRevoking] = useState('');
    const [accessPage, chooseAccessPage] = useHashChoice('connection', readAccess);
    const calendarResource=useResource<{items:ActionConnectorChoice[]}>(api,
        mode==='chatbot'&&accessPage==='new'&&inventory?.mcp.enabled?calendarConnectionPath:null);
    const calendarChoices=calendarResource.data?.items??[];
    const selectedCalendar=calendarChoices.find(choice=>JSON.stringify(choice.target)===calendarKey);
    const [showAll, setShowAll] = useState(false);
    const accessOwner=useRef({api,page:accessPage,generation:0});
    if(accessOwner.current.api!==api||accessOwner.current.page!==accessPage)accessOwner.current={api,page:accessPage,generation:accessOwner.current.generation+1};
    useEffect(()=>{if(mode==='chatbot'&&accessPage!=='generated')setMcp(undefined);},[accessPage,mode]);
    useEffect(()=>{if(inventoryResource.error instanceof ApiError&&[401,403].includes(inventoryResource.error.status)){setMcp(undefined);setInvite(undefined);setQr('');setRevoking('');}},[inventoryResource.error]);
    const mounted = useRef(true), active = useRef<AbortController | null>(null), acting = useRef(false);
    useEffect(() => {
        mounted.current = true;
        setEndpoint(serverUrl);
        setPairEditing(false);setPairPlatform('macos');setDeviceScope('owner');setDeviceId(mode==='device'?pairingDeviceId(embedded):'');
        setLabel(moteText(mode === 'device' ? '我的新设备' : '我的 AI 助手'));
        setRevoking('');
        setShowAll(false);
        setInvite(undefined);
        setMcp(undefined);
        setMcpAccess('read');
        setCalendarKey('');
        setOauthRequests([]);
        setQr('');
        setError('');
        setMessage('');
        setBusy('');
        acting.current = false;
        return () => { mounted.current = false; active.current?.abort(); };
    }, [api, serverUrl, mode, embedded]);
    useEffect(()=>{
        if(mode!=='chatbot')return;
        let alive=true;const controller=new AbortController();
        const read=async()=>{
            try{const result=await api.request<{items:OAuthRequest[]}>('/api/connections/mcp/oauth/requests',{signal:controller.signal});if(alive)setOauthRequests(Array.isArray(result.items)?result.items.filter(item=>item&&typeof item.id==='string'&&typeof item.clientName==='string'&&typeof item.redirectUri==='string'&&typeof item.write==='boolean'&&typeof item.expiresAt==='string'):[]);}
            catch{if(alive)setOauthRequests([]);}
        };
        void read();
        const timer=setInterval(()=>{if(!document.hidden)void read();},5000);
        return ()=>{alive=false;controller.abort();clearInterval(timer);};
    },[api,mode]);
    useEffect(() => {
        const configured = (configuration.data?.domains?.find(domain=>domain.id==='server')?.effective as {publicUrl?:unknown}|undefined)?.publicUrl;
        if (typeof configured === 'string' && configured) {
            try {
                const url = connectionServerUrl(configured);
                setEndpoint(current => current === serverUrl ? url : current);
            }
            catch { /* Keep the visible address for manual correction. */ }
        }
    }, [configuration.data, serverUrl]);
    useEffect(() => { if (!invite && mode!=='chatbot')
        return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [invite,mode]);
    useEffect(() => {
        setQr('');
        if (!invite)
            return;
        let alive = true;
        void connectionQrDataUrl(invite.uri).then(value => { if (alive)
            setQr(value); }).catch(() => { if (alive)
            setError(moteText("二维码生成失败，可以复制或下载连接邀请 JSON。")); });
        return () => { alive = false; };
    }, [invite]);
    const expired = !!invite && Date.parse(invite.invitation.expiresAt) <= now;
    useEffect(() => { if (expired) {
        setInvite(undefined);
        setQr('');
        setMessage(moteText("连接邀请已到期，重新生成。已经连接的设备不受影响。"));
    } }, [expired]);
    async function refresh(signal: AbortSignal) {
        resources(api).invalidate(key => key === '/api/connections' || key === servicesPath);
        await readResource<Inventory>(api, '/api/connections', signal);
    }
    async function action(name: string, operation: (signal: AbortSignal) => Promise<void>) {
        if (acting.current)
            return;
        acting.current = true;
        const controller = new AbortController();
        active.current = controller;
        const timeout = setTimeout(() => controller.abort(), 20000);
        setBusy(name);
        setError('');
        setMessage('');
        try {
            await operation(controller.signal);
        }
        catch (e) {
            if (mounted.current && active.current === controller)
                setError(controller.signal.aborted ? moteText("连接请求超时。刷新列表核对结果。") : errorMessage(e));
        }
        finally {
            clearTimeout(timeout);
            if (active.current === controller) {
                acting.current = false;
                active.current = null;
                if (mounted.current)
                    setBusy('');
            }
        }
    }
    async function copy(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setMessage(moteText("已复制，只粘贴到你信任的客户端。"));
        }
        catch {
            setError(moteText("剪贴板不可用。下载 JSON 或手动复制。"));
        }
    }
    function createInvitation() {
        void action('invite', async (signal) => {
            const url = connectionServerUrl(endpoint.trim());
            if (invite)
                await api.request('/api/connections/invitations/revoke', { method: 'POST', signal, body: JSON.stringify({ code: invite.invitation.code }) });
            signal.throwIfAborted();
            setInvite(undefined);
            setQr('');
            const result = await api.request<InvitationResponse>(deviceScope === 'collector' ? '/api/connections/collector-invitations' : '/api/connections/invitations', { method: 'POST', signal, body: JSON.stringify({ serverUrl: url, label: label.trim(), ...(deviceId ? { deviceId } : {}) }) });
            if (!mounted.current || signal.aborted)
                return;
            setNow(Date.now());
            setInvite(result);setPairEditing(false);
            await refresh(signal);
        });
    }
    function cancelInvitation() {
        void action('cancel', async (signal) => {
            if (invite)
                await api.request('/api/connections/invitations/revoke', { method: 'POST', signal, body: JSON.stringify({ code: invite.invitation.code }) });
            if (mounted.current && !signal.aborted) {
                setInvite(undefined);
                setQr('');
                setMessage(moteText("邀请已取消，旧二维码和 JSON 不再有效。"));
            }
        });
    }
    function createMcp() {
        const owner=accessOwner.current;
        void action('mcp', async (signal) => {
            if(mcpAccess==='calendar'&&!selectedCalendar)return;
            const connection={serverUrl:connectionServerUrl(endpoint.trim()),label:label.trim()};
            const result = await api.request<McpResponse>(mcpAccess==='calendar'?calendarConnectionPath:'/api/connections/mcp',{
                method:'POST',signal,body:JSON.stringify(mcpAccess==='calendar'?{...connection,target:selectedCalendar?.target}:{...connection,access:mcpAccess}),
            });
            if (mounted.current && !signal.aborted && accessOwner.current===owner) {
                setMcp(result);
                chooseAccessPage('generated');
            }
            await refresh(signal);
        });
    }
    function decideOauth(id: string, decision: 'approve' | 'reject') {
        void action(`oauth-${decision}`, async (signal) => {
            await api.request(`/api/connections/mcp/oauth/requests/${encodeURIComponent(id)}/${decision}`, { method: 'POST', signal, body: '{}' });
            if (mounted.current && !signal.aborted) {
                setOauthRequests(current => current.filter(item => item.id !== id));
                setMessage(moteText(decision === 'approve' ? '已批准，在客户端继续完成连接。' : '已拒绝此连接请求。'));
            }
        });
    }
    function revoke(id: string) {
        void action('revoke', async (signal) => {
            await revokeAccess(api, id, signal);
            if (mounted.current && !signal.aborted) {
                setRevoking('');
                if (mcp?.credential.id === id)
                    setMcp(undefined);
                setMessage(moteText(mode==='chatbot'?"连接凭据已撤销，归档资料保留。":"连接凭据已撤销；归档资料保留，客户端队列不会被删除。"));
            }
            await refresh(signal);
        });
    }
    const loopback = (() => { try {
        return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname);
    }
    catch {
        return false;
    } })();
    const oauthServiceUrl = (() => { try {
        return connectionServerUrl((mcp?.credential.serverUrl ?? endpoint).trim()).replace(/\/$/, '') + '/mcp';
    }
    catch {
        return '';
    } })();
    const visibleCredentials = inventory?.items.filter(item => mode === 'device' ? ['owner', 'collector'].includes(item.scope) : ['mcp-read', 'mcp-write', 'mcp-calendar'].includes(item.scope)) ?? [];
    const activeCount = visibleCredentials.filter(item => !item.revokedAt && (!item.expiresAt || Date.parse(item.expiresAt) > now)).length;
    const knownDevices = [...new Map([
            ...(inventory?.items.filter(item => ['owner', 'collector'].includes(item.scope) && item.deviceId).map(item => [item.deviceId!, { deviceId: item.deviceId!, deviceName: item.deviceName || item.label }] as const) ?? []),
            ...devices.map(device => [device.deviceId, device] as const),
        ]).values()];
    const credentialActive=(item:Credential)=>!item.revokedAt&&(!item.expiresAt||Date.parse(item.expiresAt)>now);
    const credentialAccess=(item:Credential)=>item.scope==='mcp-read'?moteText('只读归档资料'):moteText(scopes[item.scope]);
    const credentialState=(item:Credential)=>item.revokedAt?moteText('已撤销'):item.expiresAt&&Date.parse(item.expiresAt)<=now?moteText('已到期'):moteText('授权有效');
    const selectedCredential=visibleCredentials.find(item=>item.id===accessPage);
    const revokingCredential=visibleCredentials.find(item=>item.id===revoking);
    function leaveAccess(){clearAccess(null);}
    function clearAccess(page:string|null){setMcp(undefined);setRevoking('');setError('');setMessage('');chooseAccessPage(page);}
    function hideAccessCredential(){clearAccess(mcp?.credential.id??null);}
    if(mode==='chatbot')return <section className="connections source-workspace access-workspace" aria-labelledby="connections-title">
      {!accessPage&&<a className="back-link" href={connectionsHref}><ArrowLeft size={14}/>{moteText('连接')}</a>}
      {(accessPage==='new'||selectedCredential||accessPage==='generated'&&mcp)&&<button className="back-link" disabled={!!busy} onClick={leaveAccess}><ArrowLeft size={14}/>{moteText('AI 接入')}</button>}
      {Boolean(error||inventoryResource.error||configuration.error)&&<div className="notice error" role="alert">{error||errorMessage(inventoryResource.error||configuration.error)}</div>}
      {message&&<div className="notice" role="status"><Check size={16}/>{message}</div>}
      {accessPage==='new'?<>
        <div className="page-heading"><h1 id="connections-title">{moteText('新建连接')}</h1></div>
        <form className="access-create-form" onSubmit={event=>{event.preventDefault();createMcp();}}>
          <label>{moteText('连接名称')}<input aria-label={moteText('连接名称')} value={label} disabled={!!busy} onChange={event=>setLabel(event.target.value)} maxLength={120} required/></label>
          <label>{moteText('中央地址')}<input aria-label={moteText('邀请节点地址')} type="url" value={endpoint} disabled={!!busy} onChange={event=>setEndpoint(event.target.value)} placeholder="https://mote.example.com" maxLength={2048} required/><small>{moteText('填写 Agent 可以访问的中央地址。')}</small></label>
          {loopback&&<p className="connection-warning">{moteText('本机地址只供同机访问。跨设备需可访问的 HTTPS。')}</p>}
          <label>{moteText('访问权限')}<select aria-label={moteText('MCP 访问权限')} value={mcpAccess} disabled={!!busy||!inventory?.mcp.enabled} onChange={event=>setMcpAccess(event.target.value as McpAccess)}>
            <option value="read">{moteText('只读归档资料')}</option>
            {inventory?.mcp.writeEnabled&&<option value="write">{moteText('仅写入指定来源')}</option>}
            {calendarResource.data&&<option value="calendar">{moteText('创建日程')}</option>}
          </select></label>
          {mcpAccess==='calendar'?<>
            <label>{moteText('授权目标日历')}<select value={calendarKey} disabled={!!busy||!calendarChoices.length} onChange={event=>setCalendarKey(event.target.value)} required>
              <option value="">{moteText('选择目标日历')}</option>
              {calendarChoices.map(({target,name})=><option key={JSON.stringify(target)} value={JSON.stringify(target)}>{name}</option>)}
            </select></label>
            <p>{moteText('此连接可根据你的当次指令，仅在所选日历创建日程。')}</p>
            {!calendarChoices.length&&<p role="status">{moteText('先在来源中选择日历并授权写入。')}</p>}
          </>:<p>{mcpAccess==='write'?moteText('仅可写入：{0}。',inventory?.mcp.writeSourceIds.join('、')||moteText('未配置')):moteText('检索和读取已获准访问的资料，不修改内容。')}</p>}
          {mcpAccess!=='calendar'&&inventory?.mcp.enabled&&<div className="connection-mcp oauth-access" aria-label={moteText('OAuth MCP 服务地址')}><h3>{moteText('OAuth 客户端')}</h3><p>{moteText('OAuth 客户端用此地址发现授权，无需 Bearer 头。')}</p><code>{oauthServiceUrl}</code><div className="connection-actions"><button type="button" className="button" disabled={!!busy||!oauthServiceUrl} onClick={()=>void copy(oauthServiceUrl)}><Copy size={15}/>{moteText('复制服务地址')}</button></div></div>}
          {mcpAccess!=='calendar'&&<details className="connection-help"><summary>{moteText('客户端兼容性')}</summary><p>{moteText('生成标准 HTTP MCP 连接 JSON，粘贴到支持 URL 与 Bearer 请求头的客户端。')}</p><p>{oauthServiceUrl?moteText('OAuth 客户端填 {0}。首次连接在本页批准。',oauthServiceUrl):moteText('配置可访问的中央地址后复制服务地址。')}</p></details>}
          {inventory&&!inventory.mcp.enabled&&<p role="status">{moteText('到「来源与外部应用」开启 MCP、设置读令牌并重启。写入须另行启用并设置允许信源。')}</p>}
          <div className="access-form-actions"><button className="button primary" disabled={!!busy||!label.trim()||!inventory?.mcp.enabled||!!mcp||mcpAccess==='calendar'&&!selectedCalendar}>{busy==='mcp'?moteText('正在生成…'):moteText('生成 MCP 配置')}</button></div>
        </form>
      </>:accessPage==='generated'&&mcp?<div className="access-detail">
        <div className="page-heading"><span className="eyebrow">{moteText('配置已生成')}</span><h1 id="connections-title">{moteText('{0} 的连接配置',mcp.credential.label)}</h1><p>{mcp.credential.scope==='mcp-calendar'?<>{moteText('创建日程')} · {mcp.credential.calendarName}</>:<>HTTP MCP · {credentialAccess(mcp.credential)}</>}</p></div>
        {mcp.credential.scope==='mcp-calendar'?<div className="connection-mcp"><h3>Codex</h3><p>{moteText('将配置粘贴到 Codex 的 config.toml，然后重启 Codex。')}</p><button className="button" onClick={()=>void copy(codexCalendarConfig(mcp.config))}><Copy size={15}/>{moteText('复制 Codex 配置')}</button><textarea className="codex-config" readOnly aria-label={moteText('Codex 配置')} value={codexCalendarConfig(mcp.config)} spellCheck={false}/></div>:<div className="connection-mcp oauth-access" aria-label={moteText('OAuth MCP 服务地址')}><h3>{moteText('OAuth 客户端')}</h3><p>{moteText('OAuth 客户端用此地址发现授权，无需 Bearer 头。')}</p><code>{oauthServiceUrl}</code><div className="connection-actions"><button type="button" className="button" disabled={!!busy||!oauthServiceUrl} onClick={()=>void copy(oauthServiceUrl)}><Copy size={15}/>{moteText('复制服务地址')}</button></div></div>}
        <div className="connection-mcp" aria-label={moteText('MCP 连接配置')}><p>{moteText('完整凭据只显示一次，可到连接列表撤销。')}</p><div className="connection-actions"><button className="button primary" onClick={()=>void copy(JSON.stringify(mcp.config,null,2))}><Copy size={15}/>{moteText('复制 MCP JSON')}</button><button className="button" onClick={()=>downloadFile('mote-mcp.json',new Blob([JSON.stringify(mcp.config,null,2)],{type:'application/json'}))}><Download size={15}/>{moteText('下载 JSON')}</button></div><textarea readOnly aria-label="MCP JSON" value={JSON.stringify(mcp.config,null,2)} spellCheck={false}/><div className="access-form-actions"><button className="button" disabled={!!busy} onClick={hideAccessCredential}>{moteText('已保存，隐藏凭据')}</button></div></div>
      </div>:selectedCredential?<div className="access-detail">
        <div className="page-heading split-heading"><div><span className="eyebrow">{moteText('AI 连接')}</span><h1 id="connections-title">{selectedCredential.label}</h1></div><span className={credentialActive(selectedCredential)?'access-state':'muted'}>{credentialState(selectedCredential)}</span></div>
        <dl className="access-properties"><dt>{moteText('访问权限')}</dt><dd>{credentialAccess(selectedCredential)}</dd>{selectedCredential.calendarName&&<><dt>{moteText('授权目标日历')}</dt><dd>{selectedCredential.calendarName}</dd></>}<dt>{moteText('连接方式')}</dt><dd>HTTP MCP</dd><dt>{moteText('服务地址')}</dt><dd>{selectedCredential.serverUrl.replace(/\/$/,'')}/mcp</dd><dt>{moteText('创建时间')}</dt><dd>{dateTime(selectedCredential.createdAt)}</dd><dt>{moteText('到期时间')}</dt><dd>{selectedCredential.expiresAt?dateTime(selectedCredential.expiresAt):moteText('未设置')}</dd>{selectedCredential.revokedAt&&<><dt>{moteText('撤销于')}</dt><dd>{dateTime(selectedCredential.revokedAt)}</dd></>}</dl>
        <p className="fine-print">{moteText('凭据只显示一次。丢失时撤销并新建。')}</p><details className="connection-help"><summary>{moteText('识别信息')}</summary><code>{selectedCredential.tokenHint}</code><p><code>{selectedCredential.id}</code></p></details>
        {!selectedCredential.revokedAt&&<div className="access-danger"><button className="text-button danger" disabled={!!busy} onClick={()=>setRevoking(selectedCredential.id)}>{moteText('撤销连接')}</button></div>}
      </div>:<>
        <div className="page-heading split-heading"><h1 id="connections-title">{moteText('AI 接入')}</h1><button className="button" onClick={()=>{setMcpAccess('read');setCalendarKey('');setError('');setMessage('');chooseAccessPage('new');}}><Plus size={16}/>{moteText('新建连接')}</button></div>
        {oauthRequests.length>0&&<div className="connection-mcp oauth-access" aria-label={moteText('OAuth 待批准连接')}><h3>{moteText('OAuth 待批准连接')}</h3><p>{moteText('批准后客户端会自动继续；只批准你发起的连接。')}</p><ul className="connection-list">{oauthRequests.map(item=><li key={item.id}><div><strong>{item.clientName}</strong><p>{item.write?moteText('仅写入指定来源'):moteText('只读归档资料')} · {dateTime(item.expiresAt)}</p><small><code>{item.redirectUri}</code></small></div><div className="connection-actions"><button className="button primary" disabled={!!busy} onClick={()=>decideOauth(item.id,'approve')}>{moteText('批准')}</button><button className="button subtle" disabled={!!busy} onClick={()=>decideOauth(item.id,'reject')}>{moteText('拒绝')}</button></div></li>)}</ul></div>}
        <div className="access-list-heading"><h2>{moteText('已授权连接')}</h2>{inventory&&<span>{moteText('{0} 个有效授权',activeCount)}</span>}</div>
        <div className="source-list-toolbar"><div className="source-filter" role="group" aria-label={moteText('授权状态')}><button aria-pressed={!showAll} onClick={()=>setShowAll(false)}>{moteText('有效')}</button><button aria-pressed={showAll} onClick={()=>setShowAll(true)}>{moteText('全部')}</button></div><button className="text-button" disabled={!!busy} onClick={()=>void action('refresh',refresh)}>{moteText('刷新')}</button></div>
        {!inventory?inventoryResource.loading&&<Loading label={moteText('正在读取连接…')}/>:<><ul className="connection-list access-list">{visibleCredentials.filter(item=>showAll||credentialActive(item)).map(item=><li key={item.id}><button className="access-row" onClick={()=>chooseAccessPage(item.id)}><span className="source-row-icon"><Diamond size={18}/></span><span className="source-row-copy"><strong>{item.label}</strong><small>{item.scope==='mcp-read'?moteText('只读资料'):moteText(scopes[item.scope])} · {moteText('创建于 {0}',dateTime(item.createdAt))}</small></span><span className={credentialActive(item)?'access-state':'muted'}>{credentialState(item)}</span><ChevronRight size={16}/></button></li>)}</ul>{!visibleCredentials.some(item=>showAll||credentialActive(item))&&<p className="fine-print">{moteText('还没有 AI 连接。生成 MCP 配置即可添加。')}</p>}</>}
        <details className="connection-help"><summary>{moteText('连接方式')}</summary><p>{moteText('生成标准 HTTP MCP 连接 JSON，粘贴到支持 URL 与 Bearer 请求头的客户端。')}</p><p>{oauthServiceUrl?moteText('OAuth 客户端填 {0}。首次连接在本页批准。',oauthServiceUrl):moteText('配置可访问的中央地址后复制服务地址。')}</p></details>
      </>}
      {!accessPage&&<DeveloperAccess api={api}/>}
      {revokingCredential&&<AccessRevocation key={revokingCredential.id} label={revokingCredential.label} calendar={revokingCredential.scope==='mcp-calendar'} busy={!!busy} cancel={()=>setRevoking('')} confirm={()=>revoke(revokingCredential.id)}/>}
    </section>;
    return <section className="connections device-pair-workspace" aria-labelledby={embedded ? undefined : 'connections-title'}>
    {!embedded && <><a className="back-link" href={pageHash('library')}><ArrowLeft size={14} aria-hidden="true" style={{verticalAlign:"middle",marginInlineEnd:"0.3em"}}/>{moteText('资料库')}</a><div className="page-heading"><h1 id="connections-title">{moteText('连接设备')}</h1></div></>}
    <div className="device-pair-center"><div><strong>{moteText('中央')}</strong><small>{invite&&!pairEditing?invite.invitation.serverUrl:endpoint}</small></div><span>{(invite&&!pairEditing?invite.scope:deviceScope)==='collector'?moteText('独立采集器 · 仅同步本设备'):moteText('完整客户端权限')}</span></div>
    {Boolean(error||inventoryResource.error||configuration.error)&&<div className="notice error" role="alert">{error||errorMessage(inventoryResource.error||configuration.error)}</div>}{message&&<div className="notice" role="status">{message}</div>}
    {(!invite||pairEditing)&&<form className="device-pair-form" onSubmit={event=>{event.preventDefault();createInvitation();}}>
    <div className="device-pair-choices" role="group" aria-label={moteText('设备类型')}>{(['macos','android'] as const).map(platform=><button type="button" key={platform} className="device-pair-choice" aria-pressed={pairPlatform===platform} disabled={!!busy} onClick={()=>setPairPlatform(platform)}><span aria-hidden="true">{platform==='macos'?<Laptop size={18} aria-hidden="true"/>:<Smartphone size={18} aria-hidden="true"/>}</span><span><strong>{platform==='macos'?'Mac':'Android'}</strong><small>{platform==='macos'?moteText('电脑客户端'):moteText('手机客户端')}</small></span></button>)}</div>
    <label>{moteText('连接名称')}<input aria-label={moteText('连接名称')} value={label} disabled={!!busy} onChange={event=>setLabel(event.target.value)} maxLength={120}/></label>
    <details className="device-pair-advanced"><summary>{moteText('中心地址与高级连接')}</summary><div className="connection-form"><label>{moteText('本服务供设备访问的地址')}<input aria-label={moteText('邀请节点地址')} type="url" value={endpoint} disabled={!!busy} onChange={event=>setEndpoint(event.target.value)} placeholder="https://mote.example.com" maxLength={2048}/></label>
    <label>{moteText('设备权限')}<select aria-label={moteText('设备权限')} value={deviceScope} disabled={!!busy} onChange={event=>setDeviceScope(event.target.value as 'owner'|'collector')}><option value="owner">{moteText('本人客户端 · 完整权限')}</option><option value="collector">{moteText('独立采集器 · 仅同步')}</option></select></label>
    <label>{moteText('设备身份')}<select aria-label={moteText('邀请设备身份')} value={deviceId} disabled={!!busy} onChange={event=>setDeviceId(event.target.value)}><option value="">{moteText('首次连接的新设备')}</option>{knownDevices.map(device=><option key={device.deviceId} value={device.deviceId}>{device.deviceName} · {device.deviceId}</option>)}</select></label></div><p>{moteText('重新配对选择原设备。成功后替换同类型凭据。')}</p>
    {loopback&&<p className="connection-warning">{moteText('本机地址适用于同机或已配置转发的开发环境。跨设备填写可访问的 HTTPS 地址。')}</p>}</details>
    <div className="device-pair-actions"><button className="button primary" disabled={!!busy||!label.trim()}>{busy==='invite'?moteText('正在生成…'):moteText('生成连接邀请')}</button>{pairEditing&&invite&&<button className="text-button" type="button" onClick={()=>setPairEditing(false)}>{moteText('取消')}</button>}</div><p className="fine-print">{deviceScope==='owner'?moteText('邀请一次有效，10 分钟失效。兑换后获得与节点令牌同权限的独立凭据。'):moteText('采集程序仅能同步绑定设备的资料与来源。完整客户端选择「本人客户端」。')}</p>
    </form>}
    {invite && !expired && !pairEditing && <div className="connection-invitation" aria-label={moteText("连接邀请")}>
      <div className="connection-qr">{qr ? <img src={qr} width={288} height={288} alt={moteText("使用 Mote 客户端扫描此一次性连接二维码")}/> : <p>{moteText("正在生成二维码…")}</p>}</div>
      <div className="connection-invitation-details"><span className="badge green">{moteText("有效期剩余")}{' '}{Math.max(0, Math.ceil((Date.parse(invite.invitation.expiresAt) - now) / 1000))}{' '}{moteText("秒")}</span><span className="badge muted">{moteText(scopes[invite.scope])}</span><h3>{invite.scope === 'collector' ? moteText("将邀请交给独立采集程序") : moteText(pairPlatform==='android'?'在手机打开 Mote':'在 Mac 打开 Mote')}</h3><p>{invite.scope === 'collector' ? moteText("采集程序兑换后核对 collector 身份和采集协议。完整 App 使用本人邀请。") : moteText("Android 扫码，Mac 导入码图。均可粘贴邀请或导入 JSON。")}</p><code>{invite.invitation.serverUrl}</code><p className="device-pair-status" role="status">{moteText("等待设备连接")}</p><p className="fine-print">{moteText("有效邀请可被持有人领取。妥善保管。关闭页面后邀请仍有效，可点击取消。")}</p>
        <div className="connection-actions"><button className="button" onClick={() => void copy(JSON.stringify(invite.invitation, null, 2))}><Copy size={15}/>{moteText("复制邀请 JSON")}</button><button className="button" onClick={() => downloadFile('mote-connection.json', new Blob([JSON.stringify(invite.invitation, null, 2)], { type: 'application/json' }))}><Download size={15}/>{moteText("下载 JSON")}</button></div>
        <details><summary>{moteText("连接信息与二维码文件")}</summary>{qr && <a className="button" href={qr} download="mote-connection.png"><Download size={15}/>{moteText("保存二维码")}</a>}<textarea readOnly aria-label={moteText("连接邀请 JSON")} value={JSON.stringify(invite.invitation, null, 2)} spellCheck={false}/></details><div className="connection-actions"><button className="text-button" disabled={!!busy} onClick={()=>setPairEditing(true)}>{moteText("修改连接设置")}</button><button className="button subtle" disabled={!!busy} onClick={cancelInvitation}><X size={15}/>{moteText("取消邀请")}</button></div>
      </div>
    </div>}
    {mcp && <div className="connection-mcp" aria-label={moteText("MCP 连接配置")}><h3>{moteText("保存此 MCP 配置")}</h3><p>{moteText("专用凭据只显示一次。丢失后可撤销并重建。")}</p><textarea readOnly aria-label="MCP JSON" value={JSON.stringify(mcp.config, null, 2)} spellCheck={false}/><div className="connection-actions"><button className="button" onClick={() => void copy(JSON.stringify(mcp.config, null, 2))}><Copy size={15}/>{moteText("复制 MCP JSON")}</button><button className="button" onClick={() => downloadFile('mote-mcp.json', new Blob([JSON.stringify(mcp.config, null, 2)], { type: 'application/json' }))}><Download size={15}/>{moteText("下载 MCP JSON")}</button><button className="button subtle" onClick={() => setMcp(undefined)}>{moteText("已保存，隐藏凭据")}</button></div></div>}
    {!embedded && <><details className="device-authorizations"><summary>{moteText("管理连接授权")}</summary><div className="section-heading connection-list-heading"><div><h3>{moteText("已授权的连接")}</h3><p>{moteText("撤销立即阻止后续请求，已归档资料保持不变。")}</p></div><button className="button subtle" disabled={!!busy} onClick={() => void action('refresh', refresh)}><RefreshCw size={15}/>{moteText("刷新连接")}</button></div>
    {!inventory ? inventoryResource.loading ? <Loading label={moteText('正在读取连接…')}/> : null : !visibleCredentials.length ? <p className="fine-print">{moteText(mode === 'device' ? '还没有设备连接。生成邀请即可添加。' : '还没有 AI 连接。生成 MCP 配置即可添加。')}</p> : <ul className="connection-list">{visibleCredentials.map(item => <li key={item.id}><div><strong>{item.label}</strong><span className={`badge ${item.revokedAt ? 'muted' : 'green'}`}>{item.revokedAt ? moteText("已撤销") : moteText(scopes[item.scope])}</span><p>{item.deviceName || moteText("外部 Chatbot")}{item.platform ? ` · ${item.platform}` : ''}{' '}{moteText("· 创建于")}{' '}{dateTime(item.createdAt)}</p><code>{item.tokenHint} {item.deviceId ? `· ${item.deviceId}` : ''}</code>{item.revokedAt && <small>{moteText("撤销于")}{' '}{ago(item.revokedAt)}</small>}</div>{!item.revokedAt && (revoking === item.id ? <div className="connection-revoke"><span>{moteText("停止此连接的后续访问与同步？")}</span><button className="button danger" disabled={!!busy} onClick={() => revoke(item.id)}>{moteText("确认撤销")}</button><button className="button subtle" disabled={!!busy} onClick={() => setRevoking('')}>{moteText("取消")}</button></div> : <button className="button subtle" disabled={!!busy} onClick={() => setRevoking(item.id)}><Unplug size={15}/>{moteText("撤销")}</button>)}</li>)}</ul>}
  </details><section className="device-native-guide"><h2>{moteText('尚未安装客户端')}</h2><a className="text-button" href="https://github.com/utopiafar/mote/releases" target="_blank" rel="noreferrer">{moteText('下载 Mac / Android 客户端')}</a><details><summary>{moteText('连接前准备')}</summary><p>{moteText('客户端需填可访问的中央地址。二维码只提供连接授权。')}</p></details></section></>}
  </section>;
}
