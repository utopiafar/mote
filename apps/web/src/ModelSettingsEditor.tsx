import {useEffect, useRef, useState} from 'react';
import {Check, ExternalLink, KeyRound, LoaderCircle, RotateCcw, Save, SlidersHorizontal, TestTube2} from 'lucide-react';
import {DEFAULT_MODEL_MAX_TOKENS, MODEL_OUTPUT_BUDGETS, MODEL_PROVIDER_PRESETS, type ModelSettingsView, type ModelTestResult} from '@mote/shared/models';
import {ApiError, errorMessage, type Api} from './api';
import {createModelDraft, modelDraftChanged, modelSettingsRequest, retainedCredentialsNeedConfirmation, type CredentialAction, type ModelSettingsDraft} from './model-settings-form';

const protocolNames: Record<ModelSettingsDraft['protocol'], string> = {
  deepseek: 'DeepSeek 原生',
  'openai-completions': 'OpenAI Chat Completions 兼容',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Gemini 原生',
};
const groupNames = {china: '国内服务', international: '国际服务', local: '本机服务', custom: '自定义服务'};
const reasoningNames = {auto: '由模型决定（推荐）', off: '关闭', low: '轻量', high: '深入', max: '最高'};
interface EditorState {api: Api; snapshot: ModelSettingsView; latest: ModelSettingsView; draft: ModelSettingsDraft}

export function ModelSettingsEditor({api, revision, onApplied}: {api: Api; revision: number; onApplied: () => void}) {
  const [state, setState] = useState<EditorState>();
  const [loading, setLoading] = useState(true), [operation, setOperation] = useState<'save' | 'test' | 'restore'>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const [probe, setProbe] = useState<ModelTestResult>(), [restoreReview, setRestoreReview] = useState(false), [reload, setReload] = useState(0);
  const [customBudget,setCustomBudget]=useState(false);
  const [catalog,setCatalog]=useState<{id:string;name:string}[]>([]),[catalogError,setCatalogError]=useState(''),[catalogLoading,setCatalogLoading]=useState(false),[catalogSource,setCatalogSource]=useState('provider'),[catalogReload,setCatalogReload]=useState(0);
  const requestRef = useRef<AbortController | undefined>(undefined), loadRef = useRef<AbortController | undefined>(undefined), epoch = useRef(0);
  const active = state?.api === api ? state : undefined;
  const busy = loading || !!operation;
  const catalogKey=active?JSON.stringify([active.snapshot.revision,active.draft.provider,active.draft.protocol,active.draft.baseUrl,active.draft.apiKeyAction,active.draft.apiKey,active.draft.headersAction,active.draft.headers,active.draft.extraBodyAction,active.draft.extraBody,active.draft.allowCredentialReuse]):'';
  useEffect(()=>{
    const controller=new AbortController();setCatalog([]);setCatalogError('');setCatalogLoading(false);
    if(!active)return;
    const timer=setTimeout(()=>{
      let body:unknown;
      try{if(catalogSource==='provider')body=modelSettingsRequest(active.snapshot,active.draft);}
      catch(e){setCatalogError(errorMessage(e));return;}
      setCatalogLoading(true);
      void api.request<{items:{id:string;name:string}[]}>(catalogSource==='provider'?'/api/model-settings/models':'/api/model-settings/codex-models',{method:catalogSource==='provider'?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal})
        .then(result=>{if(!controller.signal.aborted)setCatalog(result.items);})
        .catch(e=>{if(!controller.signal.aborted)setCatalogError(errorMessage(e));})
        .finally(()=>{if(!controller.signal.aborted)setCatalogLoading(false);});
    },500);
    return()=>{clearTimeout(timer);controller.abort();};
  },[api,catalogKey,catalogSource,catalogReload]);

  useEffect(() => {
    setState(undefined);
    setError(''); setNotice(''); setProbe(undefined); setOperation(undefined); setConflict(false); setRestoreReview(false);
    return () => { requestRef.current?.abort(); loadRef.current?.abort(); epoch.current++; };
  }, [api]);
  useEffect(() => {
    const controller = new AbortController(), requestEpoch = epoch.current;
    loadRef.current?.abort(); loadRef.current = controller; setLoading(true);
    void api.request<ModelSettingsView>('/api/model-settings', {signal: controller.signal}).then(snapshot => {
      if (controller.signal.aborted || requestEpoch !== epoch.current) return;
      setState(previous => {
        const preserveDraft = previous?.api === api && modelDraftChanged(previous.draft, previous.snapshot.settings);
        return {api, snapshot: preserveDraft ? previous.snapshot : snapshot, latest: snapshot, draft: preserveDraft ? previous.draft : createModelDraft(snapshot.settings)};
      });
      setError('');
    }).catch(e => {
      if (!controller.signal.aborted && requestEpoch === epoch.current) setError(e instanceof ApiError && e.status === 404 ? '此中央节点尚不支持页面模型配置，请先升级中央节点。' : errorMessage(e));
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
    setState({...active, snapshot: active.latest, draft: createModelDraft(active.latest.settings)});
    setError(''); setNotice(''); setProbe(undefined); setConflict(false); setRestoreReview(false);
  }
  function reread() { reset(); setState(undefined); setReload(n => n + 1); }
  async function run(kind: 'save' | 'test' | 'restore') {
    if (!active || busy) return;
    let body: unknown;
    try {
      body = kind === 'restore' ? {revision: active.snapshot.revision} : modelSettingsRequest(active.snapshot, active.draft);
      if (kind === 'test' && !active.draft.model.trim()) throw new Error('填写模型名称后才能测试连接。');
    } catch (e) { setError(errorMessage(e)); return; }
    const controller = new AbortController(), requestEpoch = ++epoch.current;
    loadRef.current?.abort(); requestRef.current?.abort(); requestRef.current = controller;
    setOperation(kind); setLoading(false); setError(''); setNotice(''); setProbe(undefined); setConflict(false);
    try {
      const result = await api.request<ModelSettingsView | ModelTestResult>(kind === 'test' ? '/api/model-settings/test' : '/api/model-settings', {
        method: kind === 'test' ? 'POST' : kind === 'restore' ? 'DELETE' : 'PUT',
        body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(kind === 'test' ? Math.min(Number(active.draft.timeoutSeconds) * 1000, 30000) + 15000 : 60000)]),
      });
      if (controller.signal.aborted || requestEpoch !== epoch.current) return;
      if (kind === 'test') setProbe(result as ModelTestResult);
      else {
        const snapshot = result as ModelSettingsView;
        setState({api, snapshot, latest: snapshot, draft: createModelDraft(snapshot.settings)});
        setRestoreReview(false);
        setNotice(kind === 'restore' ? '已恢复部署配置，新的问答与回顾将使用这些设置。' : '已保存并立即生效。新的问答与回顾将使用这些设置。');
        api.setAgentTimeout(snapshot.settings.timeoutMs);
        onApplied();
      }
    } catch (e) {
      if (controller.signal.aborted || requestEpoch !== epoch.current) return;
      if (e instanceof ApiError && e.status === 409) { setConflict(true); setError('配置已被其他会话更新。请重新读取生效配置，再编辑并保存。'); }
      else setError(errorMessage(e));
    } finally { if (!controller.signal.aborted && requestEpoch === epoch.current) setOperation(undefined); }
  }
  const draft = active?.draft, saved = active?.latest.settings;
  const preset = MODEL_PROVIDER_PRESETS.find(p => p.id === draft?.provider);
  const dirty = active ? modelDraftChanged(active.draft, active.snapshot.settings) : false;
  const credentialChoice = (field: 'apiKeyAction' | 'headersAction' | 'extraBodyAction', label: string, configured: boolean) => <label className="preference-field">{label}<select aria-label={label} value={draft![field]} onChange={e => change({[field]: e.target.value as CredentialAction, ...(field === 'apiKeyAction' ? {apiKey: ''} : field === 'headersAction' ? {headers: ''} : {extraBody: ''})})}><option value="keep">不改动（{configured ? '已配置' : '未配置'}）</option><option value="replace">填写新值，替换已有配置</option><option value="clear">清除已有配置</option></select></label>;
  return <>
    <section className="panel config-builder model-settings-editor" aria-label="模型服务设置" aria-busy={busy}>
      <div className="section-heading"><div><h2><SlidersHorizontal size={18}/>模型服务</h2><p>选择服务并保存，立即用于此中央节点的问答与回顾。</p></div><span className="badge green">保存后生效</span></div>
      {!active && loading && <p role="status">正在读取模型设置…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {conflict && <button className="button subtle" disabled={busy} onClick={reread}><RotateCcw size={15}/>重新读取并还原草稿</button>}
      {!active && !loading && <button className="button subtle" onClick={() => setReload(n => n + 1)}>重新读取模型设置</button>}
      {active && draft && <form onSubmit={e => {e.preventDefault(); void run('save');}}>
        <fieldset className="model-settings-fields" disabled={busy}>
          <div className="preference-grid">
            <label className="preference-field">服务预设<select aria-label="服务预设" value={draft.provider} onChange={e => {
              const next = MODEL_PROVIDER_PRESETS.find(p => p.id === e.target.value);
              if (next) change({provider: next.id, ...(next.id !== 'custom' ? {baseUrl: next.baseUrl, protocol: next.protocol, reasoningEffort: next.reasoningEffort ?? 'auto', allowUnauthenticatedLocal: next.allowUnauthenticatedLocal ?? false} : {})});
            }}>{!preset && <option value={draft.provider}>当前自定义服务 · {draft.provider}</option>}{Object.entries(groupNames).map(([group, name]) => <optgroup key={group} label={name}>{MODEL_PROVIDER_PRESETS.filter(p => p.group === group).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}</select><small>{preset?.description || '选择预设后仍可自定义地址、协议与模型名称。'}</small></label>
            <div className="preference-field"><label>模型目录来源<select aria-label="模型目录来源" value={catalogSource} onChange={e=>setCatalogSource(e.target.value)}><option value="provider">当前服务 API</option><option value="codex">本机 Codex App Server</option></select></label><label>可用模型<select aria-label="可用模型" value={catalog.some(m=>m.id===draft.model)?draft.model:''} onChange={e=>{if(e.target.value)change({model:e.target.value});}} disabled={catalogLoading}><option value="">{catalogLoading?'正在读取模型列表…':'选择模型，或在下方手动填写'}</option>{catalog.map(m=><option key={m.id} value={m.id}>{m.name===m.id?m.id:`${m.name} · ${m.id}`}</option>)}</select></label><label>模型名称<input aria-label="模型名称" autoComplete="off" spellCheck={false} value={draft.model} onChange={e => change({model: e.target.value})} placeholder="模型 ID 或私有部署名称"/></label><button type="button" className="text-button" disabled={catalogLoading} onClick={()=>setCatalogReload(n=>n+1)}>刷新模型列表</button>{catalogError&&<small role="status">{catalogError}</small>}{!catalogError&&!catalogLoading&&!catalog.length&&<small>目录暂无可用模型，可手动填写。</small>}<small>{catalogSource==='codex'?'目录使用中央节点本机 Codex 的登录账户。选择只填写模型 ID；实际请求仍使用本页配置的 API 协议与凭据。':'根据当前地址和凭据自动加载；目录可见不代表支持工具调用，可使用下方测试连接验证。'} 留空会关闭问答与模型回顾。</small></div>
            <label className="preference-field">接口协议<select aria-label="接口协议" value={draft.protocol} onChange={e => change({protocol: e.target.value as ModelSettingsDraft['protocol']})}>{Object.entries(protocolNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><small>兼容地址应使用服务支持的协议；自定义参数按此协议传递。</small></label>
            <label className="preference-field">模型服务地址<input aria-label="模型服务地址" type="url" autoComplete="off" spellCheck={false} value={draft.baseUrl} onChange={e => change({baseUrl: e.target.value})}/><small>填写 API 基础地址；不包含 API key 或查询参数。</small></label>
          </div>
          {preset?.docsUrl && <a className="model-provider-docs" href={preset.docsUrl} target="_blank" rel="noreferrer">查看 {preset.name} 接入文档<ExternalLink size={13}/></a>}
          <div className="model-credential-section"><div className="model-subheading"><h3><KeyRound size={16}/>API key</h3><span className={`badge ${active.snapshot.settings.apiKeyConfigured ? 'green' : 'muted'}`}>{active.snapshot.settings.apiKeyConfigured ? '已配置，不回显' : '未配置'}</span></div>
            <div className="preference-grid">{credentialChoice('apiKeyAction', 'API key 操作', active.snapshot.settings.apiKeyConfigured)}{draft.apiKeyAction === 'replace' && <label className="preference-field">新的 API key<input aria-label="新的 API key" type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey} onChange={e => change({apiKey: e.target.value})} placeholder="输入此服务的 API key"/><small>只保留在当前页面内存，保存后清空输入。</small></label>}</div>
          </div>
          <div className="preference-grid">
            <label className="preference-field">推理强度<select aria-label="推理强度" value={draft.reasoningEffort} onChange={e => change({reasoningEffort: e.target.value as ModelSettingsDraft['reasoningEffort']})}>{Object.entries(reasoningNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><small>选择“由模型决定”兼容更多模型；具体能力取决于所选模型。</small></label>
            <label className="preference-field">最长等待时间（秒）<input aria-label="最长等待时间（秒）" type="number" min={5} max={600} step={1} value={draft.timeoutSeconds} onChange={e => change({timeoutSeconds: e.target.value})}/><small>5–600 秒，适用于模型请求。</small></label>
          </div>
          <details className="preference-advanced"><summary>高级设置 · 输出预算 {Number(draft.maxTokens).toLocaleString()} tokens</summary>
            <div className="preference-grid"><label className="preference-field">输出预算档位<select aria-label="输出预算档位" value={!customBudget&&MODEL_OUTPUT_BUDGETS.some(n=>String(n)===draft.maxTokens)?draft.maxTokens:'custom'} onChange={e=>{setCustomBudget(e.target.value==='custom');if(e.target.value!=='custom')change({maxTokens:e.target.value});}}>{MODEL_OUTPUT_BUDGETS.map(n=><option key={n} value={n}>{n.toLocaleString()} tokens{n===DEFAULT_MODEL_MAX_TOKENS?' · 默认':''}</option>)}<option value="custom">自定义 · 在右侧填写</option></select><small>常用默认 65,536；选择支持当前预算的模型。</small></label><label className="preference-field">最大输出 token 数<input aria-label="输出 token 上限" type="number" min={1} max={128000} value={draft.maxTokens} onChange={e => change({maxTokens: e.target.value})}/><small>1–128000。单次响应的上限，包含正文、HTML 及服务商计入的推理 token，不是固定生成长度、字数或图片大小。保存后生效。</small></label></div>
            <label className="preference-toggle"><span><strong>允许本机模型免密访问</strong><small>只适用于回环地址；容器中的“本机”指容器本身。</small></span><input type="checkbox" role="switch" checked={draft.allowUnauthenticatedLocal} onChange={e => change({allowUnauthenticatedLocal: e.target.checked})}/></label>
            <div className="model-advanced-block">{credentialChoice('headersAction', '自定义请求头操作', active.snapshot.settings.headersConfigured)}{draft.headersAction === 'replace' && <label className="preference-field">自定义请求头 JSON<textarea aria-label="自定义请求头 JSON" rows={5} autoComplete="off" spellCheck={false} value={draft.headers} onChange={e => change({headers: e.target.value})} placeholder={'{"X-Custom-Header": "value"}'}/><small>名称与值均为字符串；整体替换。已有值不会读取或回显。</small></label>}</div>
            <div className="model-advanced-block">{credentialChoice('extraBodyAction', '高级请求参数操作', active.snapshot.settings.extraBodyConfigured)}{draft.extraBodyAction === 'replace' && <label className="preference-field">高级请求参数 JSON<textarea aria-label="高级请求参数 JSON" rows={6} autoComplete="off" spellCheck={false} value={draft.extraBody} onChange={e => change({extraBody: e.target.value})} placeholder={'{"temperature": 0.7}'}/><small>按当前协议填写 JSON 对象，整体替换。消息、工具与其他运行必需字段由 Mote 管理；已有值不会回显。</small></label>}</div>
          </details>
          {retainedCredentialsNeedConfirmation(draft, active.snapshot.settings) && <label className="model-credential-reuse"><input type="checkbox" checked={draft.allowCredentialReuse} onChange={e => change({allowCredentialReuse: e.target.checked})}/><span><strong>允许在更改后的服务地址复用已保存的凭据</strong><small>这会把保留的 API key、请求头或高级参数发送到当前填写的地址。也可以改为填写新值或清除旧值。</small></span></label>}
        </fieldset>
        <p className="fine-print model-test-explanation">测试连接会由中央节点发送少量合成内容，最多等待 30 秒，可能产生少量费用；不会读取资料库。测试不会保存草稿。</p>
        {probe && <div className={`notice ${probe.ok ? 'model-success' : 'error'}`} role="status">{probe.ok && <Check size={16}/>}<span>{probe.message}{Number.isFinite(probe.durationMs) ? `（${(probe.durationMs / 1000).toFixed(1)} 秒）` : ''}{probe.ok && dirty && '；保存后才会应用草稿。'}</span></div>}
        {notice && <p className="notice model-success" role="status"><Check size={16}/>{notice}</p>}
        <div className="config-draft-footer"><span>{dirty ? '有未保存的修改，仅保留在当前页面' : '当前没有未保存的修改'}</span><div>
          <button className="button subtle" type="button" disabled={!dirty || busy} onClick={reset}><RotateCcw size={15}/>还原草稿</button>
          <button className="button subtle" type="button" disabled={busy || !draft.model.trim()} onClick={() => void run('test')}>{operation === 'test' ? <LoaderCircle size={16} className="spin"/> : <TestTube2 size={16}/>}测试连接</button>
          <button className="button primary" disabled={!dirty || busy}>{operation === 'save' ? <LoaderCircle size={16} className="spin"/> : <Save size={16}/>}保存并应用</button>
        </div></div>
      </form>}
    </section>
    {active && saved && <section className="panel effective-settings model-effective-settings" aria-label="当前生效模型配置">
      <div className="section-heading"><div><h2>当前生效值</h2><p>{active.latest.source === 'saved' ? '来自页面保存的配置；重启中央节点后仍然保留。' : '来自中央节点的启动环境或部署配置。'}</p></div><span className="badge muted">只读</span></div>
      {([
        ['服务', MODEL_PROVIDER_PRESETS.find(p => p.id === saved.provider)?.name || saved.provider], ['模型', saved.model || '未设置（问答与模型回顾关闭）'],
        ['协议', protocolNames[saved.protocol]], ['服务地址', saved.baseUrl], ['推理强度', reasoningNames[saved.reasoningEffort]],
        ['输出上限 / 等待时间', `${saved.maxTokens} tokens / ${saved.timeoutMs / 1000} 秒`],
        ['API key', saved.apiKeyConfigured ? '已配置' : '未配置'], ['自定义请求头', saved.headersConfigured ? '已配置' : '未配置'], ['高级请求参数', saved.extraBodyConfigured ? '已配置' : '未配置'],
      ] as const).map(([label, value]) => <div className="effective-field" key={label}><div><strong>{label}</strong></div><div>{value}</div></div>)}
      {active.latest.source === 'saved' && <div className="model-restore"><button className="button subtle" disabled={busy} onClick={() => setRestoreReview(v => !v)}><RotateCcw size={15}/>恢复部署配置</button>{restoreReview && <div className="preference-note"><p>删除本页保存的模型配置，立即重新使用中央节点的启动环境或部署配置。当前未保存的草稿也会清空；不会修改部署文件。</p><button className="button subtle" disabled={busy} onClick={() => void run('restore')}>{operation === 'restore' ? '正在恢复…' : '确认恢复部署配置'}</button></div>}</div>}
    </section>}
  </>;
}
