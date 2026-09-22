import {readResource,resources} from './resource-cache';
import {useUnsavedChanges} from './unsaved';
import { moteText, getLocale } from '@mote/shared/i18n';
import {useEffect, useRef, useState} from 'react';
import {Check, ExternalLink, KeyRound, LoaderCircle, RotateCcw, Save, SlidersHorizontal, TestTube2} from 'lucide-react';
import {DEFAULT_MODEL_MAX_TOKENS, MODEL_OUTPUT_BUDGETS, MODEL_PROVIDER_PRESETS, type ModelSettingsView, type ModelTestResult} from '@mote/shared/models';
import {ApiError, errorMessage, type Api} from './api';
import {createModelDraft, modelDraftChanged, modelSettingsRequest, retainedCredentialsNeedConfirmation, type CredentialAction, type ModelSettingsDraft} from './model-settings-form';

const protocolNames: Record<ModelSettingsDraft['protocol'], string> = {
  'codex-app-server':moteText("本机 Codex App Server"),
  deepseek: moteText("DeepSeek 原生"),
  'openai-completions': moteText("OpenAI Chat Completions 兼容"),
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': moteText("Google Gemini 原生"),
};
const groupNames = {china: moteText("国内服务"), international: moteText("国际服务"), local: moteText("本机服务"), custom: moteText("自定义服务")};
const reasoningNames = {auto: moteText("由模型决定（推荐）"), off: moteText("关闭"), low: moteText("轻量"), high: moteText("深入"), max: moteText("最高")};
interface EditorState {name:string;api: Api; snapshot: ModelSettingsView; latest: ModelSettingsView; draft: ModelSettingsDraft}

export function ModelSettingsEditor({api, revision, onApplied, profileId='default'}: {api: Api; revision: number; onApplied: () => void;profileId?:string}) {
  const endpoint=profileId==='default'?'/api/model-settings':`/api/model-settings/profiles/${encodeURIComponent(profileId)}`;
  const profileView=(view:ModelSettingsView):ModelSettingsView=>{const profile=view.profiles?.find(p=>p.id===profileId);if(profileId!=='default'&&!profile)throw new Error(moteText("模型配置已被删除，请重新选择。"));return {...view,settings:profile?.settings??view.settings};};
  const profileName=(view:ModelSettingsView)=>view.profiles?.find(p=>p.id===profileId)?.name??moteText("默认配置");
  const [state, setState] = useState<EditorState>();
  const [loading, setLoading] = useState(true), [operation, setOperation] = useState<'save' | 'test' | 'restore'>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const [probe, setProbe] = useState<ModelTestResult>(), [restoreReview, setRestoreReview] = useState(false), [reload, setReload] = useState(0);
  const [customBudget,setCustomBudget]=useState(false);
  const [catalog,setCatalog]=useState<{id:string;name:string}[]>([]),[catalogError,setCatalogError]=useState(''),[catalogLoading,setCatalogLoading]=useState(false),[catalogReload,setCatalogReload]=useState(0);
  const requestRef = useRef<AbortController | undefined>(undefined), loadRef = useRef<AbortController | undefined>(undefined), epoch = useRef(0);
  const active = state?.api === api ? state : undefined;
  const busy = loading || !!operation;
  const catalogKey=active?JSON.stringify([active.snapshot.revision,active.draft.provider,active.draft.protocol,active.draft.baseUrl,active.draft.apiKeyAction,active.draft.apiKey,active.draft.headersAction,active.draft.headers,active.draft.extraBodyAction,active.draft.extraBody,active.draft.allowCredentialReuse]):'';
  useEffect(()=>{
    const controller=new AbortController();setCatalog([]);setCatalogError('');setCatalogLoading(false);
    if(!active)return;
    const timer=setTimeout(()=>{
      let body:unknown;
      try{body=modelSettingsRequest(active.snapshot,active.draft);}
      catch(e){setCatalogError(errorMessage(e));return;}
      setCatalogLoading(true);
      void api.request<{items:{id:string;name:string}[]}>(endpoint+'/models',{method:'POST',...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal})
        .then(result=>{if(!controller.signal.aborted)setCatalog(result.items);})
        .catch(e=>{if(!controller.signal.aborted)setCatalogError(errorMessage(e));})
        .finally(()=>{if(!controller.signal.aborted)setCatalogLoading(false);});
    },500);
    return()=>{clearTimeout(timer);controller.abort();};
  },[api,catalogKey,catalogReload,endpoint]);

  useEffect(() => {
    setState(undefined);
    setError(''); setNotice(''); setProbe(undefined); setOperation(undefined); setConflict(false); setRestoreReview(false);
    return () => { requestRef.current?.abort(); loadRef.current?.abort(); epoch.current++; };
  }, [api]);
  useEffect(() => {
    const controller = new AbortController(), requestEpoch = epoch.current;
    loadRef.current?.abort(); loadRef.current = controller; setLoading(true);
    void readResource<ModelSettingsView>(api,'/api/model-settings',controller.signal).then(result => {
      const snapshot=profileView(result);
      if (controller.signal.aborted || requestEpoch !== epoch.current) return;
      setState(previous => {
        const preserveDraft = previous?.api === api && (modelDraftChanged(previous.draft, previous.snapshot.settings)||previous.name!==profileName(previous.snapshot));
        return {api, name:preserveDraft?previous.name:profileName(snapshot), snapshot: preserveDraft ? previous.snapshot : snapshot, latest: snapshot, draft: preserveDraft ? previous.draft : createModelDraft(snapshot.settings)};
      });
      setError('');
    }).catch(e => {
      if (!controller.signal.aborted && requestEpoch === epoch.current) {if(e instanceof ApiError&&[401,403,404,410].includes(e.status))setState(undefined);setError(e instanceof ApiError && e.status === 404 ? moteText("此中央节点尚不支持页面模型配置，请先升级中央节点。") : errorMessage(e));}
    }).finally(() => { if (!controller.signal.aborted && requestEpoch === epoch.current) setLoading(false); });
    return () => controller.abort();
  }, [api, revision, reload]);
  function change(patch: Partial<ModelSettingsDraft>) {
    setState(previous => {
      if (!previous || previous.api !== api) return previous;
      const destinationChanged = 'provider' in patch || 'protocol' in patch || 'baseUrl' in patch;
      return {...previous, draft: {...previous.draft, ...(destinationChanged ? {allowCredentialReuse: false} : {}), ...patch}};
    });
    setError(''); setNotice(''); setProbe(undefined); setRestoreReview(false);
  }
  function reset() {
    if (!active) return;
    setState({...active, snapshot: active.latest, name:profileName(active.latest), draft: createModelDraft(active.latest.settings)});
    setError(''); setNotice(''); setProbe(undefined); setConflict(false); setRestoreReview(false);
  }
  function reread() { resources(api).invalidate(key=>key==='/api/model-settings');reset(); setState(undefined); setReload(n => n + 1); }
  async function run(kind: 'save' | 'test' | 'restore') {
    if (!active || busy) return;
    let body: unknown;
    try {
      body = kind === 'restore' ? {revision: active.snapshot.revision} : {...modelSettingsRequest(active.snapshot, active.draft),...(kind==='save'&&profileId!=='default'?{name:active.name.trim()}: {})};
      if (kind === 'test' && !active.draft.model.trim()) throw new Error(moteText("填写模型名称后才能测试连接。"));
    } catch (e) { setError(errorMessage(e)); return; }
    const controller = new AbortController(), requestEpoch = ++epoch.current;
    loadRef.current?.abort(); requestRef.current?.abort(); requestRef.current = controller;
    setOperation(kind); setLoading(false); setError(''); setNotice(''); setProbe(undefined); setConflict(false);
    try {
      const result = await api.request<ModelSettingsView | ModelTestResult>(kind === 'test' ? endpoint+'/test' : endpoint, {
        method: kind === 'test' ? 'POST' : kind === 'restore' ? 'DELETE' : 'PUT',
        body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(kind === 'test' ? Math.min(Number(active.draft.modelRequestTimeoutSeconds || '30') * 1000, 30000) + 15000 : 60000)]),
      });
      if (controller.signal.aborted || requestEpoch !== epoch.current) return;
      if (kind === 'test') setProbe(result as ModelTestResult);
      else {
        const snapshot = profileView(result as ModelSettingsView);
        setState({api, name:profileName(snapshot), snapshot, latest: snapshot, draft: createModelDraft(snapshot.settings)});
        setRestoreReview(false);
        setNotice(kind === 'restore' ? moteText("默认项已恢复部署配置，功能分配保持不变。") : moteText("已保存。选择此配置的新请求将立即使用这些设置。"));
        const agentTimeoutValues=[snapshot.settings.agentTimeoutMs,...(snapshot.profiles??[]).map(p=>p.settings.agentTimeoutMs)],agentTimeouts=agentTimeoutValues.filter((value):value is number=>value!==null);
        api.setAgentTimeout(agentTimeoutValues.some(value=>value===null)?null:agentTimeouts.length?Math.max(...agentTimeouts):null);
        resources(api).invalidate(key=>key.startsWith('/api/model-settings'));
        onApplied();
      }
    } catch (e) {
      if (controller.signal.aborted || requestEpoch !== epoch.current) return;
      if (e instanceof ApiError && e.status === 409) { setConflict(true); setError(moteText("配置已被其他会话更新。请重新读取生效配置，再编辑并保存。")); }
      else setError(errorMessage(e));
    } finally { if (!controller.signal.aborted && requestEpoch === epoch.current) setOperation(undefined); }
  }
  const draft = active?.draft, saved = active?.latest.settings;
  const preset = MODEL_PROVIDER_PRESETS.find(p => p.id === draft?.provider);
  const dirty = active ? modelDraftChanged(active.draft, active.snapshot.settings)||active.name!==profileName(active.snapshot) : false;
  useUnsavedChanges(dirty);
  const credentialChoice = (field: 'apiKeyAction' | 'headersAction' | 'extraBodyAction', label: string, configured: boolean) => <label className="preference-field">{label}<select aria-label={label} value={draft![field]} onChange={e => change({[field]: e.target.value as CredentialAction, ...(field === 'apiKeyAction' ? {apiKey: ''} : field === 'headersAction' ? {headers: ''} : {extraBody: ''})})}><option value="keep">{moteText("不改动（")}{configured ? moteText("已配置") : moteText("未配置")}）</option><option value="replace">{moteText("填写新值，替换已有配置")}</option><option value="clear">{moteText("清除已有配置")}</option></select></label>;
  return <>
    <section className="panel config-builder model-settings-editor" aria-label={moteText("模型服务设置")} aria-busy={busy}>
      <div className="section-heading"><div><h2><SlidersHorizontal size={18}/>{moteText("模型服务")}</h2><p>{moteText("设置连接与默认模型，其他模块可复用此连接并选择不同模型。")}</p></div><span className="badge green">{moteText("保存后生效")}</span></div>
      {!active && loading && <p role="status">{moteText("正在读取模型设置…")}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {conflict && <button className="button subtle" disabled={busy} onClick={reread}><RotateCcw size={15}/>{moteText("重新读取并还原草稿")}</button>}
      {!active && !loading && <button className="button subtle" onClick={() => setReload(n => n + 1)}>{moteText("重新读取模型设置")}</button>}
      {active && draft && <form onSubmit={e => {e.preventDefault(); void run('save');}}>
        <fieldset className="model-settings-fields" disabled={busy}>
          <div className="preference-grid">
            {profileId!=='default'&&<label className="preference-field">{moteText("预设名称")}<input aria-label={moteText("预设名称")} maxLength={100} required value={active.name} onChange={e=>setState({...active,name:e.target.value})}/></label>}
            <label className="preference-field">{moteText("服务商类型")}<select aria-label={moteText("服务商类型")} value={draft.provider} onChange={e => {
              const next = MODEL_PROVIDER_PRESETS.find(p => p.id === e.target.value);
              if (next) change({provider: next.id, ...(next.id !== 'custom' ? {baseUrl: next.baseUrl, protocol: next.protocol, reasoningEffort: next.reasoningEffort ?? 'auto', allowUnauthenticatedLocal: next.allowUnauthenticatedLocal ?? false,...(next.protocol==='codex-app-server'?{apiKeyAction:'clear' as const,apiKey:'',headersAction:'clear' as const,headers:'',extraBodyAction:'clear' as const,extraBody:''}:{})} : {})});
            }}>{!preset && <option value={draft.provider}>{moteText("当前自定义服务 ·")}{' '}{draft.provider}</option>}{Object.entries(groupNames).map(([group, name]) => <optgroup key={group} label={name}>{MODEL_PROVIDER_PRESETS.filter(p => p.group === group).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}</select><small>{preset?.description || moteText("选择预设后仍可自定义地址、协议与模型名称。")}</small></label>
            <div className="preference-field"><label>{moteText("可用模型")}<select aria-label={moteText("可用模型")} value={catalog.some(m=>m.id===draft.model)?draft.model:''} onChange={e=>{if(e.target.value)change({model:e.target.value});}} disabled={catalogLoading}><option value="">{catalogLoading?moteText("正在读取模型列表…"):moteText("选择模型，或在下方手动填写")}</option>{catalog.map(m=><option key={m.id} value={m.id}>{m.name===m.id?m.id:`${m.name} · ${m.id}`}</option>)}</select></label><label>{moteText("模型名称")}<input aria-label={moteText("模型名称")} autoComplete="off" spellCheck={false} value={draft.model} onChange={e => change({model: e.target.value})} placeholder={moteText("模型 ID 或私有部署名称")}/></label><button type="button" className="text-button" disabled={catalogLoading} onClick={()=>setCatalogReload(n=>n+1)}>{moteText("刷新模型列表")}</button>{catalogError&&<small role="status">{catalogError}</small>}{!catalogError&&!catalogLoading&&!catalog.length&&<small>{moteText("目录暂无可用模型，可手动填写。")}</small>}<small>{draft.protocol==='codex-app-server'?moteText("使用本机 Codex 的登录账户加载目录，并通过 Codex App Server 调用所选模型。"):moteText("根据当前地址和凭据自动加载；目录可见不代表支持工具调用，可使用下方测试连接验证。")}{' '}{moteText("留空表示此预设尚未就绪。")}</small></div>
            <label className="preference-field">{moteText("接口协议")}<select aria-label={moteText("接口协议")} value={draft.protocol} onChange={e => change({protocol: e.target.value as ModelSettingsDraft['protocol']})}>{Object.entries(protocolNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><small>{moteText("兼容地址应使用服务支持的协议；自定义参数按此协议传递。")}</small></label>
            {draft.protocol!=='codex-app-server'&&<label className="preference-field">{moteText("模型服务地址")}<input aria-label={moteText("模型服务地址")} type="url" autoComplete="off" spellCheck={false} value={draft.baseUrl} onChange={e => change({baseUrl: e.target.value})}/><small>{moteText("填写 API 基础地址；不包含 API key 或查询参数。")}</small></label>}
          </div>
          {preset?.docsUrl && <a className="model-provider-docs" href={preset.docsUrl} target="_blank" rel="noreferrer">{moteText("查看")}{' '}{preset.name}{' '}{moteText("接入文档")}<ExternalLink size={13}/></a>}
          {draft.protocol==='codex-app-server'?<p className="preference-note">{moteText("使用中央服务器上 Codex CLI 的文件登录凭据。无需在这里填写 API key。Codex Server 的单次模型请求由 App Server 内部管理，页面的“单次模型请求超时”不适用于内部模型生成；“Agent 总运行超时”可以留空，留空表示不设置 Mote 的总运行期限。输出 token 上限由 Codex 管理。")}</p>:<div className="model-credential-section"><div className="model-subheading"><h3><KeyRound size={16}/>API key</h3><span className={`badge ${active.snapshot.settings.apiKeyConfigured ? 'green' : 'muted'}`}>{active.snapshot.settings.apiKeyConfigured ? moteText("已配置，不回显") : moteText("未配置")}</span></div>
            <div className="preference-grid">{credentialChoice('apiKeyAction', moteText("API key 操作"), active.snapshot.settings.apiKeyConfigured)}{draft.apiKeyAction === 'replace' && <label className="preference-field">{moteText("新的 API key")}<input aria-label={moteText("新的 API key")} type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey} onChange={e => change({apiKey: e.target.value})} placeholder={moteText("输入此服务的 API key")}/><small>{moteText("只保留在当前页面内存，保存后清空输入。")}</small></label>}</div>
          </div>}
          <div className="preference-grid">
            <label className="preference-field">{moteText("推理强度")}<select aria-label={moteText("推理强度")} value={draft.reasoningEffort} onChange={e => change({reasoningEffort: e.target.value as ModelSettingsDraft['reasoningEffort']})}>{Object.entries(reasoningNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><small>{moteText("选择“由模型决定”兼容更多模型；具体能力取决于所选模型。")}</small></label>
            <label className="preference-field">{moteText("单次模型请求超时（秒）")}<input aria-label={moteText("单次模型请求超时（秒）")} type="number" min={5} max={600} step={1} disabled={draft.protocol==='codex-app-server'} value={draft.protocol==='codex-app-server'?'':draft.modelRequestTimeoutSeconds} onChange={e => change({modelRequestTimeoutSeconds: e.target.value})}/><small>{draft.protocol==='codex-app-server'?moteText("Codex Server 不暴露内部单次模型生成请求，此项不适用。") : moteText("5–600 秒；只限制一次 Provider API 请求，不包含后续工具循环。")}</small></label>
            <label className="preference-field">{moteText("Agent 总运行超时（秒）")}<input aria-label={moteText("Agent 总运行超时（秒）")} type="number" min={5} max={3600} step={1} placeholder={draft.protocol==='codex-app-server'?moteText("可留空"):undefined} value={draft.agentTimeoutSeconds} onChange={e => change({agentTimeoutSeconds: e.target.value})}/><small>{draft.protocol==='codex-app-server'?moteText("可留空；限制从 Agent 开始到结束的整个运行周期，包含多次模型请求和工具调用。") : moteText("5–3600 秒；限制一次 Agent 从开始到完成的整个运行周期。")}</small></label>
          </div>
          {draft.protocol!=='codex-app-server'&&<details className="preference-advanced"><summary>{moteText("高级设置 · 输出预算")}{' '}{Number(draft.maxTokens).toLocaleString(getLocale())} tokens</summary>
            <div className="preference-grid"><label className="preference-field">{moteText("输出预算档位")}<select aria-label={moteText("输出预算档位")} value={!customBudget&&MODEL_OUTPUT_BUDGETS.some(n=>String(n)===draft.maxTokens)?draft.maxTokens:'custom'} onChange={e=>{setCustomBudget(e.target.value==='custom');if(e.target.value!=='custom')change({maxTokens:e.target.value});}}>{MODEL_OUTPUT_BUDGETS.map(n=><option key={n} value={n}>{n.toLocaleString(getLocale())} tokens{n===DEFAULT_MODEL_MAX_TOKENS?moteText(" · 默认"):''}</option>)}<option value="custom">{moteText("自定义 · 在右侧填写")}</option></select><small>{moteText("常用默认 65,536；选择支持当前预算的模型。")}</small></label><label className="preference-field">{moteText("最大输出 token 数")}<input aria-label={moteText("输出 token 上限")} type="number" min={1} max={128000} value={draft.maxTokens} onChange={e => change({maxTokens: e.target.value})}/><small>{moteText("1–128000。单次响应的上限，包含正文、HTML 及服务商计入的推理 token，不是固定生成长度、字数或图片大小。保存后生效。")}</small></label></div>
            <label className="preference-toggle"><span><strong>{moteText("允许本机模型免密访问")}</strong><small>{moteText("只适用于回环地址；容器中的“本机”指容器本身。")}</small></span><input type="checkbox" role="switch" checked={draft.allowUnauthenticatedLocal} onChange={e => change({allowUnauthenticatedLocal: e.target.checked})}/></label>
            <div className="model-advanced-block">{credentialChoice('headersAction', moteText("自定义请求头操作"), active.snapshot.settings.headersConfigured)}{draft.headersAction === 'replace' && <label className="preference-field">{moteText("自定义请求头 JSON")}<textarea aria-label={moteText("自定义请求头 JSON")} rows={5} autoComplete="off" spellCheck={false} value={draft.headers} onChange={e => change({headers: e.target.value})} placeholder={'{"X-Custom-Header": "value"}'}/><small>{moteText("名称与值均为字符串；整体替换。已有值不会读取或回显。")}</small></label>}</div>
            <div className="model-advanced-block">{credentialChoice('extraBodyAction', moteText("高级请求参数操作"), active.snapshot.settings.extraBodyConfigured)}{draft.extraBodyAction === 'replace' && <label className="preference-field">{moteText("高级请求参数 JSON")}<textarea aria-label={moteText("高级请求参数 JSON")} rows={6} autoComplete="off" spellCheck={false} value={draft.extraBody} onChange={e => change({extraBody: e.target.value})} placeholder={'{"temperature": 0.7}'}/><small>{moteText("按当前协议填写 JSON 对象，整体替换。消息、工具与其他运行必需字段由 Mote 管理；已有值不会回显。")}</small></label>}</div>
          </details>}
          {retainedCredentialsNeedConfirmation(draft, active.snapshot.settings) && <label className="model-credential-reuse"><input type="checkbox" checked={draft.allowCredentialReuse} onChange={e => change({allowCredentialReuse: e.target.checked})}/><span><strong>{moteText("允许在更改后的服务地址复用已保存的凭据")}</strong><small>{moteText("这会把保留的 API key、请求头或高级参数发送到当前填写的地址。也可以改为填写新值或清除旧值。")}</small></span></label>}
        </fieldset>
        <p className="fine-print model-test-explanation">{moteText("测试连接会由中央节点发送少量合成内容，最多等待 30 秒，可能产生少量费用；不会读取资料库。测试不会保存草稿。")}</p>
        {probe && <div className={`notice ${probe.ok ? 'model-success' : 'error'}`} role="status">{probe.ok && <Check size={16}/>}<span>{probe.message}{Number.isFinite(probe.durationMs) ? moteText("（{0} 秒）", (probe.durationMs / 1000).toFixed(1)) : ''}{probe.ok && dirty && moteText("；保存后才会应用草稿。")}</span></div>}
        {notice && <p className="notice model-success" role="status"><Check size={16}/>{notice}</p>}
        <div className="config-draft-footer"><span>{dirty ? moteText("有未保存的修改，仅保留在当前页面") : moteText("当前没有未保存的修改")}</span><div>
          <button className="button subtle" type="button" disabled={!dirty || busy} onClick={reset}><RotateCcw size={15}/>{moteText("还原草稿")}</button>
          <button className="button subtle" type="button" disabled={busy || !draft.model.trim()} onClick={() => void run('test')}>{operation === 'test' ? <LoaderCircle size={16} className="spin"/> : <TestTube2 size={16}/>}{moteText("测试连接")}</button>
          <button className="button primary" disabled={!dirty || busy}>{operation === 'save' ? <LoaderCircle size={16} className="spin"/> : <Save size={16}/>}{moteText("保存并应用")}</button>
        </div></div>
      </form>}
    </section>
    {active && saved && <section className="panel effective-settings model-effective-settings" aria-label={moteText("当前生效模型配置")}>
      <div className="section-heading"><div><h2>{moteText("当前生效值")}</h2><p>{active.latest.source === 'saved' ? moteText("来自页面保存的配置；重启中央节点后仍然保留。") : moteText("来自中央节点的启动环境或部署配置。")}</p></div><span className="badge muted">{moteText("只读")}</span></div>
      {([
        [moteText("服务"), MODEL_PROVIDER_PRESETS.find(p => p.id === saved.provider)?.name || saved.provider], [moteText("模型"), saved.model || moteText("未设置（问答与模型回顾关闭）")],
        [moteText("协议"), protocolNames[saved.protocol]], [moteText("服务地址"), saved.baseUrl], [moteText("推理强度"), reasoningNames[saved.reasoningEffort]],
        [moteText("输出上限 / 超时"), saved.protocol==='codex-app-server'?moteText("Codex 管理输出；Agent 总运行超时 {0}", saved.agentTimeoutMs===null?moteText("未设置"):saved.agentTimeoutMs/1000+' 秒'):moteText("{0}；单次模型请求 {1} 秒；Agent 总运行 {2} 秒", saved.maxTokens+' tokens', saved.modelRequestTimeoutMs===null?moteText("未设置"):saved.modelRequestTimeoutMs/1000, saved.agentTimeoutMs===null?moteText("未设置"):saved.agentTimeoutMs/1000)],
        ['API key', saved.apiKeyConfigured ? moteText("已配置") : moteText("未配置")], [moteText("自定义请求头"), saved.headersConfigured ? moteText("已配置") : moteText("未配置")], [moteText("高级请求参数"), saved.extraBodyConfigured ? moteText("已配置") : moteText("未配置")],
      ] as const).map(([label, value]) => <div className="effective-field" key={label}><div><strong>{label}</strong></div><div>{value}</div></div>)}
      {profileId==='default'&&active.latest.source === 'saved' && <div className="model-restore"><button className="button subtle" disabled={busy} onClick={() => setRestoreReview(v => !v)}><RotateCcw size={15}/>{moteText("恢复部署配置")}</button>{restoreReview && <div className="preference-note"><p>{moteText("将默认配置恢复为中央节点的启动环境或部署配置，其他配置和功能分配保留。当前未保存的草稿也会清空；不会修改部署文件。")}</p><button className="button subtle" disabled={busy} onClick={() => void run('restore')}>{operation === 'restore' ? moteText("正在恢复…") : moteText("确认恢复部署配置")}</button></div>}</div>}
    </section>}
  </>;
}
