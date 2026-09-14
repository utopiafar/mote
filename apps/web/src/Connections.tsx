import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Link2, QrCode, RefreshCw, ShieldCheck, Unplug, X } from 'lucide-react';
import { connectionServerUrl, type ConnectionInvitation, type ServerConfiguration } from '@mote/shared';
import { type Api, type Device, ago, dateTime, errorMessage } from './api';

type Credential = {id:string;label:string;scope:'collector'|'mcp-read'|'mcp-write';createdAt:string;revokedAt?:string;deviceId?:string;deviceName?:string;platform?:string;serverUrl:string;tokenHint:string};
type Inventory = {items:Credential[];mcp:{enabled:boolean;writeEnabled:boolean;writeSourceIds:string[]}};
type InvitationResponse = {invitation:ConnectionInvitation;uri:string};
type McpResponse = {credential:Credential;config:{mcpServers:Record<string,{type:string;url:string;headers:{Authorization:string}}>}};
const scopes = {'collector':'采集与自身来源','mcp-read':'MCP · 只读资料','mcp-write':'MCP · 指定来源写入'};

function downloadFile(name:string, content:Blob) {
  const url=URL.createObjectURL(content),anchor=document.createElement('a');
  anchor.href=url;anchor.download=name;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function Connections({api,serverUrl,devices}:{api:Api;serverUrl:string;devices:Device[]}) {
  const [endpoint,setEndpoint]=useState(serverUrl);
  const [label,setLabel]=useState('我的新设备');
  const [deviceId,setDeviceId]=useState('');
  const [inventory,setInventory]=useState<Inventory>();
  const [invite,setInvite]=useState<InvitationResponse>();
  const [qr,setQr]=useState('');
  const [mcp,setMcp]=useState<McpResponse>();
  const [mcpAccess,setMcpAccess]=useState<'read'|'write'>('read');
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [now,setNow]=useState(Date.now());
  const [revoking,setRevoking]=useState('');
  const mounted=useRef(true),active=useRef<AbortController|null>(null),loading=useRef(false),acting=useRef(false);
  useEffect(()=>{
    mounted.current=true;
    const controller=new AbortController();
    void api.request<Inventory>('/api/connections',{signal:controller.signal}).then(setInventory).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});
    // An explicitly configured Tunnel URL is usually reachable from phones; loopback is not.
    void api.request<ServerConfiguration>('/api/configuration',{signal:controller.signal}).then(config=>{
      const configured=config.groups.flatMap(group=>group.fields).find(field=>field.key==='publicUrl')?.value;
      if(typeof configured==='string'&&configured){try{const url=connectionServerUrl(configured);if(!controller.signal.aborted)setEndpoint(current=>current===serverUrl?url:current);}catch{/* Keep the visible address for manual correction. */}}
    }).catch(()=>{});
    return ()=>{mounted.current=false;controller.abort();active.current?.abort();};
  },[api,serverUrl]);
  useEffect(()=>{if(!invite)return;const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[invite]);
  useEffect(()=>{
    setQr('');if(!invite)return;let alive=true;
    void import('qrcode').then(({default:QRCode})=>QRCode.toDataURL(invite.uri,{width:360,margin:4,errorCorrectionLevel:'M',color:{dark:'#142d28',light:'#ffffff'}})).then(value=>{if(alive)setQr(value);}).catch(()=>{if(alive)setError('二维码生成失败，可以复制或下载连接邀请 JSON。');});
    return ()=>{alive=false;};
  },[invite]);
  const expired=!!invite&&Date.parse(invite.invitation.expiresAt)<=now;
  useEffect(()=>{if(expired){setInvite(undefined);setQr('');setMessage('连接邀请已到期，请重新生成；已经连接的设备不受影响。');}},[expired]);
  async function refresh(signal?:AbortSignal) {
    if(loading.current)return;
    loading.current=true;
    try{const result=await api.request<Inventory>('/api/connections',{signal:signal??AbortSignal.timeout(15000)});if(mounted.current)setInventory(result);}
    finally{loading.current=false;}
  }
  async function action(name:string,operation:(signal:AbortSignal)=>Promise<void>) {
    if(acting.current)return;acting.current=true;
    const controller=new AbortController();active.current=controller;
    const timeout=setTimeout(()=>controller.abort(),20000);
    setBusy(name);setError('');setMessage('');
    try{await operation(controller.signal);}
    catch(e){if(mounted.current)setError(controller.signal.aborted?'请求超时，请刷新连接列表确认结果后重试。':errorMessage(e));}
    finally{clearTimeout(timeout);acting.current=false;if(active.current===controller)active.current=null;if(mounted.current)setBusy('');}
  }
  async function copy(value:string) {
    try{await navigator.clipboard.writeText(value);setMessage('已复制，请只粘贴到你信任的客户端。');}
    catch{setError('当前环境无法访问剪贴板，请使用下载 JSON，或展开内容手动复制。');}
  }
  function createInvitation() {void action('invite',async signal=>{
    const url=connectionServerUrl(endpoint.trim());
    if(invite)await api.request('/api/connections/invitations/revoke',{method:'POST',signal,body:JSON.stringify({code:invite.invitation.code})});
    setInvite(undefined);setQr('');
    const result=await api.request<InvitationResponse>('/api/connections/invitations',{method:'POST',signal,body:JSON.stringify({serverUrl:url,label:label.trim(),...(deviceId?{deviceId}:{})})});
    if(!mounted.current)return;setNow(Date.now());setInvite(result);
    await refresh(signal);
  });}
  function cancelInvitation(){void action('cancel',async signal=>{
    if(invite)await api.request('/api/connections/invitations/revoke',{method:'POST',signal,body:JSON.stringify({code:invite.invitation.code})});
    if(mounted.current){setInvite(undefined);setQr('');setMessage('邀请已取消，旧二维码和 JSON 不再有效。');}
  });}
  function createMcp(){void action('mcp',async signal=>{
    const result=await api.request<McpResponse>('/api/connections/mcp',{method:'POST',signal,body:JSON.stringify({serverUrl:connectionServerUrl(endpoint.trim()),label:label.trim(),access:mcpAccess})});
    if(mounted.current)setMcp(result);await refresh(signal);
  });}
  function revoke(id:string){void action('revoke',async signal=>{
    await api.request(`/api/connections/${encodeURIComponent(id)}`,{method:'DELETE',signal});
    if(mounted.current){setRevoking('');if(mcp?.credential.id===id)setMcp(undefined);setMessage('连接凭据已撤销；归档资料保留，客户端队列不会被删除。');}
    await refresh(signal);
  });}
  const loopback=(()=>{try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(endpoint).hostname);}catch{return false;}})();
  const activeCount=inventory?.items.filter(item=>!item.revokedAt).length??0;
  const knownDevices=[...new Map([
    ...(inventory?.items.filter(item=>item.scope==='collector'&&item.deviceId).map(item=>[item.deviceId!,{deviceId:item.deviceId!,deviceName:item.deviceName||item.label}] as const)??[]),
    ...devices.map(device=>[device.deviceId,device] as const),
  ]).values()];
  return <section className="panel connections" aria-labelledby="connections-title">
    <div className="section-heading"><div><span className="eyebrow">CONNECT ONCE</span><h2 id="connections-title"><Link2 size={19}/>添加设备与 Chatbot</h2><p>扫码或导入一次性邀请，把手机和电脑连接到中央节点。</p></div><span className="badge muted">{activeCount} 个有效连接</span></div>
    <div className="connection-steps"><span><b>1</b>填写设备可访问的地址</span><span><b>2</b>生成邀请或 MCP 配置</span><span><b>3</b>在客户端确认并连接</span></div>
    {error&&<div className="notice error" role="alert">{error}</div>}
    {message&&<div className="notice" role="status"><Check size={16}/>{message}</div>}
    <div className="connection-fields">
      <label>中央节点地址<input aria-label="邀请节点地址" type="url" value={endpoint} disabled={!!busy} onChange={event=>setEndpoint(event.target.value)} placeholder="https://mote.example.com" maxLength={2048}/><small>可使用 Cloudflare Tunnel 的 HTTPS 域名。二维码不会自动打通网络。</small></label>
      <label>连接名称<input aria-label="连接名称" value={label} disabled={!!busy} onChange={event=>setLabel(event.target.value)} placeholder="我的 K90 Pro Max / 工作电脑 / Chatbot" maxLength={120}/><small>用于在下面的列表中识别和撤销连接。</small></label>
    </div>
    {loopback&&<p className="connection-warning">当前是本机地址，手机扫码后会指向手机自己。跨设备连接请先填入可访问的 HTTPS 域名；本机地址可用于同一台电脑或明确配置了端口转发的开发环境。</p>}
    <div className="connection-methods">
      <div className="connection-method"><h3><QrCode size={18}/>手机、Mac 与其他采集端</h3>
        <p>每份邀请仅能使用一次，10 分钟后失效。连接后得到独立采集凭据，不包含中央管理令牌。</p>
        <label>设备身份<select aria-label="邀请设备身份" value={deviceId} disabled={!!busy} onChange={event=>setDeviceId(event.target.value)}><option value="">首次连接的新设备</option>{knownDevices.map(device=><option key={device.deviceId} value={device.deviceId}>{device.deviceName} · {device.deviceId}</option>)}</select></label>
        <small>从旧版手填令牌迁移或重新配对，请选择原设备以保留身份。成功配对后会替换该设备之前的采集凭据。</small>
        <button className="button primary" disabled={!!busy||!label.trim()} onClick={createInvitation}><QrCode size={16}/>{busy==='invite'?'正在生成…':invite?'重新生成邀请':'生成连接邀请'}</button>
      </div>
      <div className="connection-method"><h3><ShieldCheck size={18}/>连接其他 Chatbot · MCP</h3>
        <p>生成标准 HTTP MCP 连接 JSON，粘贴到支持 URL 与 Bearer 请求头的客户端。</p>
        <label>访问权限<select aria-label="MCP 访问权限" value={mcpAccess} disabled={!!busy||!inventory?.mcp.enabled} onChange={event=>setMcpAccess(event.target.value as 'read'|'write')}><option value="read">只读归档资料</option><option value="write" disabled={!inventory?.mcp.writeEnabled}>仅写入指定来源</option></select></label>
        {inventory&&!inventory.mcp.enabled?<small>尚未启用 MCP。请在服务端配置 MOTE_MCP_ENABLED 和独立 MOTE_MCP_READ_TOKEN 后重启；写入还需明确启用并设置允许的信源。</small>:<small>{mcpAccess==='write'?`仅可写入：${inventory?.mcp.writeSourceIds.join('、')||'未配置'}。`:'只读权限能检索归档中的个人资料，请只交给你信任的应用。'} 只接受 OAuth 的客户端暂不能直接使用此 JSON。</small>}
        <button className="button" disabled={!!busy||!label.trim()||!inventory?.mcp.enabled||!!mcp} onClick={createMcp}><Link2 size={16}/>{busy==='mcp'?'正在生成…':'生成 MCP JSON'}</button>
      </div>
    </div>
    {invite&&!expired&&<div className="connection-invitation" aria-label="连接邀请">
      <div className="connection-qr">{qr?<img src={qr} width={288} height={288} alt="使用 Mote 客户端扫描此一次性连接二维码"/>:<p>正在生成二维码…</p>}</div>
      <div className="connection-invitation-details"><span className="badge green">有效期剩余 {Math.max(0,Math.ceil((Date.parse(invite.invitation.expiresAt)-now)/1000))} 秒</span><h3>在客户端打开「连接中央节点」</h3><p>Android 可以直接扫码；Mac 可以导入二维码图片。两端均支持粘贴邀请或导入 JSON 文件，确认节点地址后连接。</p><code>{invite.invitation.serverUrl}</code><p className="fine-print">有效期内，持有邀请的人可以领取该连接。请勿公开分享；关闭此页面不会取消邀请，需使用下面的取消按钮。</p>
        <div className="connection-actions"><button className="button" onClick={()=>void copy(JSON.stringify(invite.invitation,null,2))}><Copy size={15}/>复制邀请 JSON</button><button className="button" onClick={()=>downloadFile('mote-connection.json',new Blob([JSON.stringify(invite.invitation,null,2)],{type:'application/json'}))}><Download size={15}/>下载 JSON</button>{qr&&<a className="button" href={qr} download="mote-connection.png"><Download size={15}/>保存二维码</a>}<button className="button subtle" disabled={!!busy} onClick={cancelInvitation}><X size={15}/>取消邀请</button></div>
        <details><summary>手动复制邀请内容</summary><textarea readOnly aria-label="连接邀请 JSON" value={JSON.stringify(invite.invitation,null,2)} spellCheck={false}/></details>
      </div>
    </div>}
    {mcp&&<div className="connection-mcp" aria-label="MCP 连接配置"><h3>保存此 MCP 配置</h3><p>专用凭据仅在此次生成时显示。离开页面后仍有效；丢失时可以撤销并重新生成。</p><textarea readOnly aria-label="MCP JSON" value={JSON.stringify(mcp.config,null,2)} spellCheck={false}/><div className="connection-actions"><button className="button" onClick={()=>void copy(JSON.stringify(mcp.config,null,2))}><Copy size={15}/>复制 MCP JSON</button><button className="button" onClick={()=>downloadFile('mote-mcp.json',new Blob([JSON.stringify(mcp.config,null,2)],{type:'application/json'}))}><Download size={15}/>下载 MCP JSON</button><button className="button subtle" onClick={()=>setMcp(undefined)}>已保存，隐藏凭据</button></div></div>}
    <div className="section-heading connection-list-heading"><div><h3>已授权的连接</h3><p>撤销立即阻止后续请求，已归档资料保持不变。</p></div><button className="button subtle" disabled={!!busy} onClick={()=>void action('refresh',refresh)}><RefreshCw size={15}/>刷新连接</button></div>
    {!inventory?<p>正在读取连接…</p>:!inventory.items.length?<p className="fine-print">还没有独立连接。旧版手填中央令牌的设备仍然可用；迁移后会显示在这里。</p>:<ul className="connection-list">{inventory.items.map(item=><li key={item.id}><div><strong>{item.label}</strong><span className={`badge ${item.revokedAt?'muted':'green'}`}>{item.revokedAt?'已撤销':scopes[item.scope]}</span><p>{item.deviceName||'外部 Chatbot'}{item.platform?` · ${item.platform}`:''} · 创建于 {dateTime(item.createdAt)}</p><code>{item.tokenHint} {item.deviceId?`· ${item.deviceId}`:''}</code>{item.revokedAt&&<small>撤销于 {ago(item.revokedAt)}</small>}</div>{!item.revokedAt&&(revoking===item.id?<div className="connection-revoke"><span>停止此连接的后续同步？</span><button className="button danger" disabled={!!busy} onClick={()=>revoke(item.id)}>确认撤销</button><button className="button subtle" disabled={!!busy} onClick={()=>setRevoking('')}>取消</button></div>:<button className="button subtle" disabled={!!busy} onClick={()=>setRevoking(item.id)}><Unplug size={15}/>撤销</button>)}</li>)}</ul>}
  </section>;
}
