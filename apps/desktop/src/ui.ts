const desktopApi = window.mote;
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let currentStatus: import('./contracts').Status;
let initialized = false;
let busy = false;
const fields = byId<HTMLFieldSetElement>('settings-fields');

function feedback(message: string, success = false): void {
  const box = byId('feedback'); box.textContent = message; box.hidden = !message; box.className = success ? 'success' : '';
}
function readInput(id: string): string { return byId<HTMLInputElement>(id).value; }
function numberInput(id: string): number { return Number(readInput(id)); }
function fillConfig(config: import('./contracts').PublicConfig): void {
  const values: Record<string, string | number> = {
    'diagnostic-interval': config.diagnosticIntervalSeconds, 'jpeg-quality': config.jpegQuality, 'capture-max-side': config.captureMaxSide, 'battery-pause-below': config.batteryPauseBelowPct,
    'server-url': config.serverUrl, 'device-name': config.deviceName, interval: config.intervalMs / 1000,
    'queue-mb': config.maxQueueBytes / 1024 / 1024, 'queue-events': config.maxQueueEvents,
    'excluded-apps': config.excludedAppIds.join('\n'), masks: JSON.stringify(config.masks, null, 2),
    idle: config.idlePauseSeconds, 'privacy-model-url': config.privacyModelUrl,
    'review-policy': config.reviewPolicy, 'review-max-tokens': config.reviewMaxTokens, 'review-max-side': config.reviewMaxSide, 'nsfw-threads': config.nsfwThreads,
    'nsfw-timeout': config.nsfwTimeoutMs / 1000, 'nsfw-source': config.nsfwSource, 'nsfw-custom-url': config.nsfwCustomUrl,
  };
  for (const [id, value] of Object.entries(values)) byId<HTMLInputElement>(id).value = String(value);
  byId<HTMLInputElement>('diagnostics-enabled').checked = config.diagnosticsEnabled;
  byId<HTMLInputElement>('pause-on-battery').checked = config.pauseOnBattery;
  byId<HTMLInputElement>('ocr').checked = config.ocrEnabled;
  byId<HTMLInputElement>('login').checked = currentStatus.environment?.legacy === false ? false : config.openAtLogin;
  byId<HTMLInputElement>('nsfw-enabled').checked = config.nsfwEnabled;
  byId<HTMLInputElement>('token').value = '';
  byId<HTMLInputElement>('token').placeholder = config.tokenConfigured ? '已安全保存；留空保留已有令牌' : '输入中央节点访问令牌';
}
let connectionPreview: import('./connection').ConnectionPreview | undefined;
function render(status: import('./contracts').Status): void {
  currentStatus = status;
  byId('connection-device').textContent = `设备：${status.config.deviceName} · ID ${status.config.deviceId}。迁移已有设备时，请在中央邀请中选择此 ID。`;
  byId('environment').textContent = status.environment ? `环境：${status.environment.profile}${status.environment.legacy ? '（原日常目录）' : ' · 独立数据'} · ${status.environment.dataDirectory}` : '';
  const names = { stopped: '采集已停止', capturing: '正在采集', paused: '采集已暂停', permission_required: '需要屏幕录制权限', error: '采集已停止 · 需要处理' };
  byId('state').textContent = names[status.state];
  byId<HTMLInputElement>('login').disabled = status.environment?.legacy === false;
  byId('login-hint').textContent = status.environment?.legacy === false ? '命名环境使用带 --profile 的启动命令；不会注册可能丢失环境参数的系统登录项。' : '应用启动后保持停止状态，需手动开始采集；已有队列会恢复上传。';
  byId('message').textContent = status.message;
  byId('status-dot').className = `dot ${status.state === 'capturing' ? 'active' : status.state === 'error' || status.state === 'permission_required' ? 'error' : ''}`;
  byId('permission').textContent = status.platform !== 'macos' ? '此平台尚不支持采集' : status.screenPermission === 'granted' ? '屏幕权限已授权' : '屏幕权限未授权';
  byId('queue-count').textContent = status.queueDepth.toLocaleString();
  byId('queue-size').textContent = `${(status.queueBytes / 1024 / 1024).toFixed(1)} MiB`;
  byId('last-capture').textContent = status.lastCaptureAt ? new Date(status.lastCaptureAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚无';
  byId<HTMLButtonElement>('start').disabled = busy || status.running || status.platform !== 'macos';
  byId<HTMLButtonElement>('stop').disabled = busy || !status.running;
  fields.disabled = busy || status.running;
  for (const id of ['connection-preview', 'connection-json', 'connection-qr', 'connection-test', 'connection-owner-open']) byId<HTMLButtonElement>(id).disabled = busy || (id !== 'connection-test' && id !== 'connection-owner-open' && status.running);
  byId<HTMLButtonElement>('connection-cancel').disabled = busy;
  byId<HTMLTextAreaElement>('connection-input').disabled = busy;
  byId<HTMLInputElement>('connection-confirm-origin').disabled = busy;
  byId<HTMLButtonElement>('connection-connect').disabled = busy || status.running || !connectionPreview || Date.parse(connectionPreview.expiresAt) <= Date.now() || !byId<HTMLInputElement>('connection-confirm-origin').checked;
  byId('save-hint').textContent = status.running ? '正在采集；停止后可修改隐私和连接设置。' : '设置保存后生效。';
  const uploadInfo = [];
  if (status.lastUploadError) uploadInfo.push(status.lastUploadError);
  if (status.nextRetryAt && status.lastUploadError) uploadInfo.push(`下次重试 ${new Date(status.nextRetryAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
  if (status.lastUploadAt) uploadInfo.push(`最近上传 ${new Date(status.lastUploadAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
  byId('upload-info').textContent = uploadInfo.join(' · ');
  if (!status.encryptedTokenStorage) byId('token-hint').textContent = '系统加密存储不可用，无法保存令牌。';
  if (status.nsfw) {
    const nsfw = status.nsfw;
    const modelNames = { missing: '模型尚未下载', partial: '模型可继续下载', ready: '模型已通过 SHA-256 校验', invalid: '模型校验失败', verifying: '正在校验模型' };
    const processNames = { stopped: '推理尚未启动', starting: '正在启动独立推理进程', ready: '离线推理已就绪', running: '正在本机推理', error: '推理中断，可自动恢复' };
    byId('model-state').textContent = nsfw.downloading && nsfw.modelState !== 'verifying' ? '正在下载模型' : modelNames[nsfw.modelState];
    byId('inference-state').textContent = processNames[nsfw.inferenceState];
    byId<HTMLProgressElement>('model-progress').value = nsfw.totalBytes ? Math.min(1, nsfw.bytes / nsfw.totalBytes) : 0;
    const details = [`${(nsfw.bytes / 1024 / 1024).toFixed(1)} / ${(nsfw.totalBytes / 1024 / 1024).toFixed(1)} MiB`, 'CPU · llama.cpp · Qwen3.5-0.8B'];
    if (nsfw.downloadSource) details.push(`来源 ${nsfw.downloadSource}`);
    if (nsfw.lastAllowed !== undefined) details.push(`最近审查：${nsfw.lastAllowed ? '通过' : '已过滤'}`);
    if (nsfw.lastDurationMs !== undefined) details.push(`${nsfw.lastDurationMs} ms`);
    details.push(`本次运行已过滤 ${nsfw.blockedCount} 张`);
    byId('model-detail').textContent = details.join(' · ');
    byId('model-error').textContent = nsfw.error || (status.config.nsfwEnabled && nsfw.modelState !== 'ready' ? '千问视觉审查已开启；请完成模型下载或本地导入后再开始采集。' : '截图仅在本机独立进程中推理，不发送给下载来源或外部模型。');
    byId<HTMLButtonElement>('model-download').disabled = busy || status.running || nsfw.downloading;
    byId<HTMLButtonElement>('model-cancel').disabled = busy || !nsfw.downloading;
    byId<HTMLButtonElement>('model-import').disabled = busy || status.running || nsfw.downloading;
    byId<HTMLButtonElement>('model-reload').disabled = busy || status.running || nsfw.downloading;
  }
  if (status.diagnostics) {
    const d = status.diagnostics, latest = d.latest;
    const rows = [d.enabled ? `诊断开启 · ${d.sampleCount} 条数值样本` : '诊断关闭', `保存 ${d.counters.saved} · 过滤 ${d.counters.blocked} · 失败 ${d.counters.failed}`, `图像累计 ${(d.counters.imageBytes / 1048576).toFixed(2)} MiB · 已上传请求体约 ${(d.counters.uploadedBytes / 1048576).toFixed(2)} MiB`];
    if (latest) rows.push(`主进程 RSS ${(latest.rssBytes / 1048576).toFixed(1)} MiB · 累计 CPU ${((latest.cpuUserMicros + latest.cpuSystemMicros) / 1000000).toFixed(1)} s`, `设备电量 ${latest.batteryPercent === undefined ? '不可用' : latest.batteryPercent.toFixed(0) + '%'} · ${latest.onBattery === undefined ? '供电信息不可用' : latest.onBattery ? '电池供电' : '外部电源'} · ${new Date(latest.at).toLocaleTimeString()}`);
    if (d.counters.saved + d.counters.blocked > 0) rows.push(`累计本地推理 ${(d.counters.inferenceMs / 1000).toFixed(1)} s · OCR ${(d.counters.ocrMs / 1000).toFixed(1)} s`);
    if (d.error) rows.push(d.error);
    byId('diagnostics-detail').textContent = rows.join('\n');
  }
  const statistics = [
    `待上传 ${status.queueDepth.toLocaleString()} / ${status.config.maxQueueEvents.toLocaleString()} 条 · 队列 ${(status.queueBytes / 1048576).toFixed(2)} / ${(status.config.maxQueueBytes / 1048576).toFixed(0)} MiB（${(100 * status.queueBytes / status.config.maxQueueBytes).toFixed(1)}%）`,
    `采样间隔 ${status.config.intervalMs / 1000} 秒 · 图像最大边 ${status.config.captureMaxSide} px · JPEG 质量 ${status.config.jpegQuality}`,
    `本地模型 ${((status.nsfw?.bytes || 0) / 1048576).toFixed(1)} MiB · 当前进程已过滤 ${status.nsfw?.blockedCount || 0} 张`,
  ];
  if (status.nsfw?.lastDurationMs !== undefined) statistics.push(`最近审查 ${status.nsfw.lastDurationMs} ms · 模型加载 ${status.nsfw.lastLoadMs ?? '—'} ms · 视觉编码 ${status.nsfw.lastVisionMs ?? '—'} ms · 生成 ${status.nsfw.lastTokens ?? '—'} token`);
  if (status.diagnostics?.enabled) { const c = status.diagnostics.counters; statistics.push(`诊断累计：保存 ${c.saved} · 过滤 ${c.blocked} · 失败 ${c.failed} · 推理 ${(c.inferenceMs / 1000).toFixed(1)} s · OCR ${(c.ocrMs / 1000).toFixed(1)} s`, `累计上传请求体约 ${(c.uploadedBytes / 1048576).toFixed(2)} MiB；不代表远端存储量。`); }
  else statistics.push('数值诊断未开启；如需持续处理计数、资源与耗时，请在开发者设置中启用。');
  byId('collection-statistics').replaceChildren(...statistics.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  if (!initialized) { fillConfig(status.config); initialized = true; }
}
async function perform(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true; feedback(''); if (currentStatus) render(currentStatus);
  try { await action(); } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败';
    feedback(message);
  } finally { busy = false; if (currentStatus) render(currentStatus); }
}
byId('settings').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    let masks: import('./contracts').Rectangle[];
    try { masks = JSON.parse(readInput('masks') || '[]'); } catch { throw new Error('遮挡区域不是有效 JSON，请检查括号与逗号'); }
    const token = readInput('token').trim();
    const updated = await desktopApi.configure({
      diagnosticsEnabled: byId<HTMLInputElement>('diagnostics-enabled').checked, diagnosticIntervalSeconds: numberInput('diagnostic-interval'),
      jpegQuality: numberInput('jpeg-quality'), captureMaxSide: numberInput('capture-max-side'), pauseOnBattery: byId<HTMLInputElement>('pause-on-battery').checked, batteryPauseBelowPct: numberInput('battery-pause-below'),
      serverUrl: readInput('server-url'), deviceName: readInput('device-name'), intervalMs: numberInput('interval') * 1000,
      maxQueueBytes: numberInput('queue-mb') * 1024 * 1024, maxQueueEvents: numberInput('queue-events'),
      excludedAppIds: readInput('excluded-apps').split('\n').map(v => v.trim()).filter(Boolean), masks,
      idlePauseSeconds: numberInput('idle'), ocrEnabled: byId<HTMLInputElement>('ocr').checked,
      privacyModelUrl: readInput('privacy-model-url').trim(), openAtLogin: byId<HTMLInputElement>('login').checked,
      nsfwEnabled: byId<HTMLInputElement>('nsfw-enabled').checked, reviewPolicy: readInput('review-policy'), reviewMaxTokens: numberInput('review-max-tokens'), reviewMaxSide: numberInput('review-max-side'),
      nsfwThreads: numberInput('nsfw-threads'), nsfwTimeoutMs: numberInput('nsfw-timeout') * 1000,
      nsfwSource: readInput('nsfw-source') as import('./contracts').Config['nsfwSource'], nsfwCustomUrl: readInput('nsfw-custom-url').trim(),
      ...(token ? { token } : {}),
    });
    fillConfig(updated.config); render(updated); feedback('设置已保存。开始采集后使用新设置。', true);
  });
});
byId('start').addEventListener('click', () => void perform(async () => render(await desktopApi.start())));
byId('stop').addEventListener('click', () => void perform(async () => render(await desktopApi.stop())));
byId('retry').addEventListener('click', () => void perform(async () => { render(await desktopApi.retry()); feedback(currentStatus.lastUploadError || '已触发队列上传。', !currentStatus.lastUploadError); }));
byId('permissions').addEventListener('click', () => void perform(() => desktopApi.openPermissions()));
byId('data-folder').addEventListener('click', () => void perform(() => desktopApi.openDataFolder()));
byId('export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportQueue(); if (!result.canceled) feedback(`队列备份已保存至 ${result.path}`, true); }));
byId('import').addEventListener('click', () => void perform(async () => { const result = await desktopApi.importQueue(); if (!result.canceled) feedback(`已导入 ${result.imported} 条待上传记录，重复记录自动跳过。`, true); }));
byId('model-download').addEventListener('click', () => void perform(async () => { render(await desktopApi.downloadModel()); feedback('模型下载已开始，支持断点续传；截图不会发送给下载源。', true); }));
byId('model-cancel').addEventListener('click', () => void perform(async () => render(await desktopApi.cancelModelDownload())));
byId('model-import').addEventListener('click', () => void perform(async () => { const result = await desktopApi.importModel(); if (!result.canceled) feedback('模型导入与 SHA-256 校验完成。', true); }));
byId('model-reload').addEventListener('click', () => void perform(async () => { render(await desktopApi.reloadModel()); feedback('模型已重新校验；下一次采样将启动新的推理进程。', true); }));
desktopApi.onStatus(render);
void desktopApi.status().then(render).catch(() => feedback('无法连接采集器进程，请重新打开 Mote。'));

byId('central').addEventListener('click', () => void perform(() => desktopApi.openCentral()));
let draft: import('./note-draft').NoteDraft | undefined;
let noteSaving = false;
let noteComposing = false;
const noteFields = ['note-text', 'note-mood', 'save-note'];
function lockNote(locked: boolean): void { for (const id of noteFields) (byId(id) as HTMLInputElement).disabled = locked; }
lockNote(true);
function renderDraft(value: import('./note-draft').NoteDraft): void {
  draft = value; byId<HTMLTextAreaElement>('note-text').value = value.text; byId<HTMLInputElement>('note-mood').value = value.mood;
  byId<HTMLTextAreaElement>('note-text').readOnly = Boolean(value.prepared); byId<HTMLInputElement>('note-mood').readOnly = Boolean(value.prepared);
}
void desktopApi.noteDraft().then(value => { renderDraft(value); lockNote(false); if (value.prepared) byId('note-feedback').textContent = '发现上次未完成的保存，点击保存可用原 ID 重试。'; }).catch(() => feedback('无法恢复随手记草稿，请重启应用。'));
for (const id of ['note-text', 'note-mood']) {
  byId(id).addEventListener('compositionstart', () => { noteComposing = true; });
  byId(id).addEventListener('compositionend', () => { noteComposing = false; });
}
for (const id of ['note-text', 'note-mood']) byId(id).addEventListener('input', () => {
  if (!draft || noteSaving) return;
  draft = { ...draft, text: readInput('note-text'), mood: readInput('note-mood'), revision: draft.revision + 1 };
  const changed = draft;
  void desktopApi.updateNoteDraft(changed).then(() => { if (draft?.id === changed.id && draft.revision === changed.revision) byId('note-feedback').textContent = '草稿已保存到本机。'; }).catch(() => { byId('note-feedback').textContent = '草稿暂未保存，请保留正文并重试；如上次保存未完成，请重新打开窗口恢复原稿。'; });
});
byId('note-form').addEventListener('submit', event => {
  event.preventDefault(); if (!draft || noteSaving || noteComposing || busy) return;
  const input = { ...draft, text: readInput('note-text'), mood: readInput('note-mood'), revision: draft.revision + 1 };
  noteSaving = true; lockNote(true);
  void perform(async () => {
    try {
      const result = await desktopApi.saveNote(input); renderDraft(result.draft);
      byId('note-feedback').textContent = '已写入本地队列；中央节点确认后自动清除待上传记录。';
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '保存未完成，请重试';
      byId('note-feedback').textContent = message;
      const persisted = await desktopApi.noteDraft();
      if (persisted.prepared || persisted.id !== input.id) renderDraft(persisted);
      else draft = { ...input, revision: Math.max(input.revision, persisted.revision) }; // Keep unsaved text visible if disk persistence failed.
      throw error;
    }
    finally { noteSaving = false; lockNote(false); }
  });
});

byId('diagnostics-sample').addEventListener('click', () => void perform(async () => render(await desktopApi.sampleDiagnostics())));
byId('diagnostics-export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportDiagnostics(); if (!result.canceled) feedback('数值诊断已导出。', true); }));

byId('support-export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportSupport(); if (!result.canceled) feedback('支持包已导出；只含数值、配置开关和固定阶段事件。', true); }));

let localSourceRows: import('./source-types').SourceStatus[] = [];
let sourceEditingId: string | undefined;
let sourceBusy = false;
function sourceOptions(): import('./source-types').SourceOptions {
  return { retention: readInput('source-retention') as 'snapshot' | 'reference', intervalSeconds: numberInput('source-interval'), trackDeletions: byId<HTMLInputElement>('source-deletions').checked, extensions: readInput('source-extensions').split(',').map(s => s.trim()).filter(Boolean), excludedPaths: readInput('source-excludes').split('\n').map(s => s.trim()).filter(Boolean), redactLiterals: readInput('source-redacts').split('\n').filter(Boolean) };
}
function editSource(id?: string): void {
  sourceEditingId = id;
  const source = localSourceRows.find(s => s.source.id === id)?.source;
  byId('source-editor-title').textContent = source ? '编辑：' + source.name : '新来源的保留与过滤规则';
  byId('source-save-edit').hidden = !source; byId('source-cancel-edit').hidden = !source;
  if (!source) return;
  byId<HTMLSelectElement>('source-retention').value = source.retention; byId<HTMLInputElement>('source-interval').value = String(source.intervalSeconds);
  byId<HTMLInputElement>('source-deletions').checked = source.trackDeletions; byId<HTMLInputElement>('source-extensions').value = source.extensions.join(',');
  byId<HTMLTextAreaElement>('source-excludes').value = source.excludedPaths.join('\n'); byId<HTMLTextAreaElement>('source-redacts').value = source.redactLiterals.join('\n');
}
async function refreshSources(): Promise<void> {
  const rows = await desktopApi.sources(); localSourceRows = rows;
  const list = byId('source-list'); list.replaceChildren();
  if (!rows.length) { const p = document.createElement('p'); p.className = 'helper'; p.textContent = '尚未连接本地来源。选择只包含你希望归档资料的目录。'; list.append(p); }
  for (const row of rows) {
    const card = document.createElement('article'); card.className = 'source-card';
    const title = document.createElement('strong'); title.textContent = `${row.source.kind === 'local-calendar' ? '日历' : '文件'} · ${row.source.name} · ${row.source.retention === 'reference' ? '引用' : '快照'}`;
    const detail = document.createElement('p'); detail.className = 'helper profile-path'; detail.textContent = row.source.path || '所选系统日历';
    const status = document.createElement('p'); status.className = 'helper'; status.textContent = `${row.source.enabled ? row.message : '本机已暂停'} · ${row.items} 项 · 待传 ${row.pending} · 跳过 ${row.skipped}${row.lastSyncAt ? ' · 最近同步 ' + new Date(row.lastSyncAt).toLocaleString() : ''}`;
    const actions = document.createElement('div'); actions.className = 'actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary'; edit.textContent = '编辑规则'; edit.addEventListener('click', () => editSource(row.source.id));
    const pause = document.createElement('button'); pause.type = 'button'; pause.className = 'secondary'; pause.textContent = row.source.enabled ? '暂停本机同步' : '恢复本机同步'; pause.disabled = sourceBusy;
    pause.addEventListener('click', () => void sourceAction(async () => { await desktopApi.updateSource(row.source.id, { ...row.source, enabled: !row.source.enabled }); }));
    actions.append(edit, pause); card.append(title, detail, status, actions); list.append(card);
  }
}
async function sourceAction(action: () => Promise<void>): Promise<void> {
  if (sourceBusy) return; sourceBusy = true; byId('source-feedback').textContent = '正在处理，请稍候…';
  for (const id of ['source-files', 'source-directory', 'source-calendar-connect', 'source-calendar-add', 'source-save-edit', 'source-sync']) byId<HTMLButtonElement>(id).disabled = true;
  try { await action(); byId('source-feedback').textContent = '已处理，下面显示各来源的当前同步状态。'; }
  catch (error) { byId('source-feedback').textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作未完成，请检查权限与配置后重试'; }
  finally { sourceBusy = false; for (const id of ['source-files', 'source-directory', 'source-calendar-connect', 'source-calendar-add', 'source-save-edit', 'source-sync']) byId<HTMLButtonElement>(id).disabled = false; await refreshSources().catch(() => {}); }
}
for (const mode of ['files', 'directory'] as const) byId('source-' + mode).addEventListener('click', () => void sourceAction(async () => { await desktopApi.chooseSourceFiles(mode, sourceOptions()); }));
byId('source-calendar-connect').addEventListener('click', () => void sourceAction(async () => {
  const calendars = await desktopApi.authorizeCalendar(); const select = byId<HTMLSelectElement>('source-calendar-choice'); select.replaceChildren();
  for (const calendar of calendars) { const option = document.createElement('option'); option.value = calendar.id; option.textContent = calendar.title; select.append(option); }
  byId('source-calendars').hidden = !calendars.length;
  if (!calendars.length) throw new Error('已授权，但系统中没有可选日历；请在系统日历中添加后重试');
}));
byId('source-calendar-add').addEventListener('click', () => void sourceAction(async () => { await desktopApi.addCalendarSource(readInput('source-calendar-choice'), sourceOptions()); }));
byId('source-sync').addEventListener('click', () => void sourceAction(() => desktopApi.syncSources()));
byId('source-calendar-permissions').addEventListener('click', () => void sourceAction(() => desktopApi.openCalendarPermissions()));
byId('source-cancel-edit').addEventListener('click', () => editSource());
byId('source-save-edit').addEventListener('click', () => void sourceAction(async () => {
  const source = localSourceRows.find(s => s.source.id === sourceEditingId)?.source; if (!source) throw new Error('请先选择要编辑的来源');
  await desktopApi.updateSource(source.id, { ...sourceOptions(), enabled: source.enabled }); editSource();
}));
void refreshSources().catch(() => { byId('source-feedback').textContent = '来源状态暂不可用，请重新打开应用'; });
setInterval(() => { if (!sourceBusy) void refreshSources().catch(() => {}); }, 3000);

let updateState: import('./updater').UpdateStatus | undefined;
function renderUpdate(value: import('./updater').UpdateStatus): void {
  updateState = value;
  byId('update-version').textContent = `当前 ${value.currentVersion}${value.availableVersion ? ' · 发布 ' + value.availableVersion : ''}`;
  byId<HTMLSelectElement>('update-channel').value = value.channel;
  byId('update-message').textContent = value.message; byId('update-install-reason').textContent = value.installReason;
  byId<HTMLProgressElement>('update-progress').value = value.total ? value.received / value.total : 0;
  byId('update-bytes').textContent = value.total ? `${(value.received / 1048576).toFixed(1)} / ${(value.total / 1048576).toFixed(1)} MiB` : '';
  const working = ['checking', 'downloading', 'verifying', 'installing'].includes(value.state);
  byId<HTMLButtonElement>('update-check').disabled = working;
  byId<HTMLSelectElement>('update-channel').disabled = working;
  byId<HTMLButtonElement>('update-download').disabled = working || !value.availableVersion || value.state === 'up_to_date' || value.state === 'idle';
  byId<HTMLButtonElement>('update-cancel').disabled = !working || value.state === 'installing';
  byId<HTMLButtonElement>('update-install').disabled = value.state !== 'ready' || !value.canInstall;
  byId<HTMLButtonElement>('update-reveal').disabled = !['ready', 'installing'].includes(value.state);
  byId<HTMLButtonElement>('update-notes').disabled = !value.notesUrl;
}
byId('update-channel').addEventListener('change', () => void perform(async () => renderUpdate(await desktopApi.updateChannel(readInput('update-channel') as 'stable' | 'preview'))));
byId('update-check').addEventListener('click', () => { void desktopApi.checkUpdate().then(renderUpdate).catch(() => feedback('更新检查未完成，请重试。')); });
byId('update-download').addEventListener('click', () => void perform(async () => renderUpdate(await desktopApi.downloadUpdate())));
byId('update-cancel').addEventListener('click', () => void perform(async () => renderUpdate(await desktopApi.cancelUpdate())));
byId('update-reveal').addEventListener('click', () => void perform(() => desktopApi.revealUpdate()));
byId('update-notes').addEventListener('click', () => void perform(() => desktopApi.releaseNotes()));
byId('update-install').addEventListener('click', () => {
  if (noteSaving || noteComposing) { feedback('请先完成当前随手记输入，再安装更新。'); return; }
  void perform(async () => {
    lockNote(true); byId('local-sources').inert = true;
    try {
      if (draft && !draft.prepared) { draft = await desktopApi.updateNoteDraft({ ...draft, text: readInput('note-text'), mood: readInput('note-mood'), revision: draft.revision + 1 }); }
      await desktopApi.installUpdate();
    } finally { lockNote(false); byId('local-sources').inert = false; }
  });
});
void desktopApi.updateStatus().then(renderUpdate).catch(() => {});
setInterval(() => { void desktopApi.updateStatus().then(renderUpdate).catch(() => {}); }, 1000);

function renderConnection(value: import('./connection').ConnectionStatus): void {
  byId('connection-state').textContent = value.message + (value.checkedAt ? ' · ' + new Date(value.checkedAt).toLocaleTimeString() : '');
  byId('connection-capabilities').textContent = value.identity ? `权限：${value.identity.credential.scope === 'collector' ? '此设备采集与自身来源同步' : '管理员'} · 中央 ${value.identity.node.version} · 环境 ${value.identity.node.profile}` : currentStatus?.config.credentialScope === 'collector' ? '已保存采集专用凭据；完整仓库需单独管理员登录。' : '';
}
function clearConnectionPreview(): void { connectionPreview = undefined; byId('connection-confirmation').hidden = true; byId<HTMLInputElement>('connection-confirm-origin').checked = false; }
function showConnectionPreview(value: import('./connection').ConnectionPreview): void {
  connectionPreview = value; byId<HTMLTextAreaElement>('connection-input').value = ''; byId<HTMLInputElement>('connection-confirm-origin').checked = false;
  byId('connection-origin').textContent = value.serverUrl; byId('connection-expiry').textContent = '邀请到期：' + new Date(value.expiresAt).toLocaleString();
  byId('connection-resume').textContent = value.serverUrl === currentStatus?.config.serverUrl ? '同一节点重新授权后，现有待传截图、随手记和来源版本将继续发往此地址。节点身份以此地址和 HTTPS 证书为准；请确认它仍由你控制。' : '更换节点时，本机必须没有待传截图、随手记或来源版本；设备 ID、隐私设置和本地模型将保留。';
  byId('connection-confirmation').hidden = false; byId<HTMLButtonElement>('connection-connect').disabled = true;
}
byId('connection-input').addEventListener('input', () => { clearConnectionPreview(); void desktopApi.cancelConnection(); });
byId('connection-preview').addEventListener('click', () => void perform(async () => { clearConnectionPreview(); showConnectionPreview(await desktopApi.previewConnection(readInput('connection-input'))); }));
for (const kind of ['json', 'qr'] as const) byId('connection-' + kind).addEventListener('click', () => void perform(async () => { clearConnectionPreview(); byId<HTMLTextAreaElement>('connection-input').value = ''; const result = await desktopApi.importConnection(kind); if (!result.canceled && result.preview) showConnectionPreview(result.preview); }));
byId('connection-confirm-origin').addEventListener('change', () => { if (currentStatus) render(currentStatus); });
byId('connection-cancel').addEventListener('click', () => { clearConnectionPreview(); byId<HTMLTextAreaElement>('connection-input').value = ''; void desktopApi.cancelConnection(); });
byId('connection-connect').addEventListener('click', () => void perform(async () => {
  if (!connectionPreview || !byId<HTMLInputElement>('connection-confirm-origin').checked) throw new Error('请先确认中央地址');
  feedback('正在连接并验证新凭据，此过程无法取消；原配置在确认成功前保持不变。');
  const status = await desktopApi.confirmConnection(connectionPreview.id, connectionPreview.serverUrl); clearConnectionPreview(); fillConfig(status.config); render(status); renderConnection(await desktopApi.connectionStatus()); feedback('连接已安全保存；原设备 ID、隐私设置和本地模型保留。', true);
}));
byId('connection-test').addEventListener('click', () => void perform(async () => renderConnection(await desktopApi.testConnection())));
byId('connection-owner-open').addEventListener('click', () => { const token = readInput('connection-owner-token').trim(); byId<HTMLInputElement>('connection-owner-token').value = ''; void perform(() => desktopApi.openCentralOwner(token)); });
void desktopApi.connectionStatus().then(renderConnection).catch(() => {});
