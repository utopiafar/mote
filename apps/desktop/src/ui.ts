const desktopApi = window.mote;
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let currentStatus: import('./contracts').Status;
let initialized = false;
let busy = false;
const fields = byId<HTMLFieldSetElement>('settings-fields');
const settingsForm = byId<HTMLFormElement>('settings');
const pageNames = ['overview', 'notes', 'sources', 'settings', 'connection', 'sync', 'capture', 'privacy', 'developer', 'about', 'activity'] as const;
type Page = typeof pageNames[number];
let currentPage: Page = 'overview';
let settingsDirty = false;
const pageScroll = new Map<Page, number>();
const settingsPages = new Set<Page>(['connection', 'sync', 'capture', 'privacy', 'developer']);

function showPage(page: Page, focus = true): void {
  pageScroll.set(currentPage, window.scrollY);
  if (page !== currentPage) feedback('');
  currentPage = page;
  const selected = settingsPages.has(page) || page === 'about' ? 'settings' : page === 'activity' ? 'overview' : page;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-page]'))) element.hidden = element.dataset.page !== page;
  for (const button of Array.from(document.querySelectorAll<HTMLElement>('aside [data-nav]'))) {
    const active = button.dataset.nav === selected;
    button.classList.toggle('selected', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  updateSettingsHint();
  if (focus) document.querySelector<HTMLElement>(`[data-page="${page}"] [data-page-title]`)?.focus({ preventScroll: true });
  window.scrollTo({ top: pageScroll.get(page) || 0, behavior: 'instant' });
}
for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-nav]'))) button.addEventListener('click', () => {
  const page = button.dataset.nav as Page;
  if (pageNames.includes(page)) showPage(page);
});
function updateSettingsHint(): void {
  byId('settings-save-bar').hidden = !(settingsPages.has(currentPage) || (currentPage === 'settings' && settingsDirty));
  byId('settings-pending').hidden = !settingsDirty;
  byId('save-hint').textContent = currentStatus?.running ? '正在采集；停止后可修改设置。' : settingsDirty ? '有未保存的修改，切换页面会为你保留。' : '设置保存后生效。';
  byId<HTMLButtonElement>('settings-reset').disabled = !settingsDirty || busy || Boolean(currentStatus?.running);
}
function markSettingsDirty(): void { settingsDirty = true; updateSettingsHint(); }
settingsForm.addEventListener('input', markSettingsDirty);
settingsForm.addEventListener('change', markSettingsDirty);
byId('settings-reset').addEventListener('click', () => {
  if (!currentStatus || busy || currentStatus.running) return;
  fillConfig(currentStatus.config); feedback('已还原为上次保存的设置。', true);
});
// Inputs stay mounted across pages. Reveal an invalid field before native validation focuses it.
settingsForm.noValidate = true;
function revealField(element: HTMLElement): void {
  const page = element.closest<HTMLElement>('[data-page]')?.dataset.page as Page | undefined;
  if (page && pageNames.includes(page)) showPage(page);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  if (element instanceof HTMLInputElement && element.dataset.preset) { element.hidden = false; byId<HTMLSelectElement>(element.dataset.preset).value = 'custom'; }
  element.focus(); element.scrollIntoView({ block: 'center', behavior: 'instant' });
}
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); showPage('settings'); }
  if (event.key === 'Escape' && (settingsPages.has(currentPage) || currentPage === 'about')) showPage('settings');
  else if (event.key === 'Escape' && currentPage === 'activity') showPage('overview');
});
desktopApi.onNavigate?.(page => { if (pageNames.includes(page)) showPage(page); });
showPage('overview', false);

function feedback(message: string, success = false): void {
  const box = byId('feedback'); box.textContent = message; box.hidden = !message; box.className = success ? 'success' : '';
}
function setText(id: string, value: string): void { const element = byId(id); if (element.textContent !== value) element.textContent = value; }
function readInput(id: string): string { return byId<HTMLInputElement>(id).value; }
function numberInput(id: string): number { return Number(readInput(id)); }
function fillConfig(config: import('./contracts').PublicConfig): void {
  const values: Record<string, string | number> = {
    'diagnostic-interval': config.diagnosticIntervalSeconds, 'jpeg-quality': config.jpegQuality, 'capture-max-side': config.captureMaxSide, 'battery-pause-below': config.batteryPauseBelowPct,
    'server-url': config.serverUrl, 'device-name': config.deviceName, interval: config.intervalMs / 1000,
    'queue-mb': config.maxQueueBytes / 1024 / 1024, 'queue-events': config.maxQueueEvents,
    'default-collection': config.defaultCollection, 'sync-interval': config.syncIntervalMinutes, 'sync-batch': config.syncBatchSize,
    'excluded-apps': config.excludedAppIds.join('\n'), masks: JSON.stringify(config.masks, null, 2),
    idle: config.idlePauseSeconds, 'privacy-model-url': config.privacyModelUrl,
    'review-policy': config.reviewPolicy, 'review-max-tokens': config.reviewMaxTokens, 'review-max-side': config.reviewMaxSide, 'nsfw-threads': config.nsfwThreads,
    'nsfw-timeout': config.nsfwTimeoutMs / 1000, 'nsfw-source': config.nsfwSource, 'nsfw-custom-url': config.nsfwCustomUrl,
  };
  for (const [id, value] of Object.entries(values)) byId<HTMLInputElement>(id).value = String(value);
  byId<HTMLInputElement>('metadata-enabled').checked = config.metadataEnabled;
  byId('app-collection-rules').replaceChildren();
  for (const [id, mode] of Object.entries(config.appCollectionRules)) addAppRule(id, mode);
  byId<HTMLInputElement>('diagnostics-enabled').checked = config.diagnosticsEnabled;
  byId<HTMLInputElement>('pause-on-battery').checked = config.pauseOnBattery;
  byId<HTMLInputElement>('ocr').checked = config.ocrEnabled;
  byId<HTMLInputElement>('login').checked = currentStatus.environment?.legacy === false ? false : config.openAtLogin;
  byId<HTMLInputElement>('nsfw-enabled').checked = config.nsfwEnabled;
  byId<HTMLInputElement>('token').value = '';
  byId<HTMLInputElement>('token').placeholder = config.tokenConfigured ? '已安全保存；留空保留已有令牌' : '输入中央节点访问令牌';
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[name=sync-mode]'))) input.checked = input.value === config.syncMode;
  byId<HTMLInputElement>('confirm-local-backlog').checked = false;
  refreshPresets(); updateSyncOptions(); renderMaskEditor(); updateLocalBacklog();
  settingsDirty = false; updateSettingsHint();
}
let connectionPreview: import('./connection').ConnectionPreview | undefined;
function render(status: import('./contracts').Status): void {
  currentStatus = status;
  byId('connection-device').textContent = `设备：${status.config.deviceName} · ID ${status.config.deviceId}。迁移已有设备时，请在中央邀请中选择此 ID。`;
  byId('environment').textContent = status.environment ? `环境：${status.environment.profile}${status.environment.legacy ? '（原日常目录）' : ' · 独立数据'} · ${status.environment.dataDirectory}` : '';
  const names = { stopped: '采集已停止', capturing: '正在采集', paused: '采集已暂停', permission_required: '需要屏幕录制权限', error: '采集已停止 · 需要处理' };
  setText('state', names[status.state]);
  setText('sidebar-state', names[status.state]);
  byId('setup-prompt').hidden = Boolean(status.config.serverUrl && status.config.tokenConfigured);
  byId('settings-connection-summary').textContent = status.config.tokenConfigured ? `${status.config.deviceName} · 已保存连接` : '连接你的中央节点，让记录开始同步';
  byId<HTMLInputElement>('login').disabled = status.environment?.legacy === false;
  byId('login-hint').textContent = status.environment?.legacy === false ? '命名环境使用带 --profile 的启动命令；不会注册可能丢失环境参数的系统登录项。' : '应用启动后保持停止状态，需手动开始采集；已有记录按上传策略处理。';
  setText('message', status.message);
  byId('status-dot').className = `dot ${status.state === 'capturing' ? 'active' : status.state === 'error' || status.state === 'permission_required' ? 'error' : ''}`;
  setText('permission', status.platform !== 'macos' ? '此平台尚不支持采集' : status.screenPermission === 'granted' ? '屏幕权限已授权' : '屏幕权限未授权');
  setText('queue-count', status.queueDepth.toLocaleString());
  setText('queue-size', `${(status.queueBytes / 1024 / 1024).toFixed(1)} MiB`);
  setText('last-capture', status.lastCaptureAt ? new Date(status.lastCaptureAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚无');
  byId<HTMLButtonElement>('start').disabled = busy || status.running || status.platform !== 'macos';
  byId<HTMLButtonElement>('stop').disabled = busy || !status.running;
  byId('start').hidden = status.running;
  byId('stop').hidden = !status.running;
  // A source registration or settings update can need a flush even with no pending bodies.
  byId('retry').hidden = false;
  byId<HTMLButtonElement>('retry').disabled = busy || status.sync.state === 'uploading' || status.sync.state === 'unconfigured';
  byId('retry').textContent = status.sync.state === 'error' ? '重试上传' : '立即上传';
  fields.disabled = busy || status.running;
  for (const id of ['connection-preview', 'connection-json', 'connection-qr', 'connection-test', 'connection-owner-open']) byId<HTMLButtonElement>(id).disabled = busy || (id !== 'connection-test' && id !== 'connection-owner-open' && status.running);
  byId<HTMLButtonElement>('connection-cancel').disabled = busy;
  byId<HTMLTextAreaElement>('connection-input').disabled = busy;
  byId<HTMLInputElement>('connection-confirm-origin').disabled = busy;
  byId<HTMLButtonElement>('connection-connect').disabled = busy || status.running || !connectionPreview || Date.parse(connectionPreview.expiresAt) <= Date.now() || !byId<HTMLInputElement>('connection-confirm-origin').checked;
  updateSettingsHint();
  const syncNames = { unconfigured: '仅保存在本机', idle: '已同步', waiting: '等待同步条件', uploading: '正在上传', error: '上传需要处理', manual: '等待手动上传' };
  const syncStateLabel = status.sync.state === 'idle' && status.sync.pendingRecords > 0 ? '记录已保存 · 准备上传' : syncNames[status.sync.state];
  setText('sync-state', syncStateLabel);
  setText('sync-policy-label', syncModeLabels[status.sync.mode]);
  setText('sync-message', `${status.sync.message} · 共 ${status.sync.pendingRecords.toLocaleString()} 条待传（含本地来源）`);
  setText('settings-sync-summary', `${syncModeLabels[status.sync.mode]} · ${status.sync.state === 'unconfigured' ? '未连接时只在本机保存' : syncStateLabel}`);
  updateLocalBacklog();
  const uploadInfo = [];
  if (status.sync.nextUploadAt) uploadInfo.push(`${status.sync.state === 'error' ? '计划重试' : '计划上传'} ${new Date(status.sync.nextUploadAt).toLocaleString('zh-CN', { hour12: false })}`);
  if (status.lastUploadError) uploadInfo.push(status.lastUploadError);
  if (status.lastUploadAt) uploadInfo.push(`最近上传 ${new Date(status.lastUploadAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
  setText('upload-info', uploadInfo.join(' · '));
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
    byId('model-error').textContent = nsfw.error || (status.config.nsfwEnabled && nsfw.modelState !== 'ready' ? '千问视觉审查已开启；完整内容需先下载或导入模型。仅活动采样不使用模型。' : '截图仅在本机独立进程中推理，不发送给下载来源或外部模型。');
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
  if (busy || !initialized || currentStatus.running) return;
  for (const element of Array.from(settingsForm.elements)) {
    if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && !element.checkValidity()) {
      revealField(element); element.reportValidity(); return;
    }
  }
  let masks: import('./contracts').Rectangle[];
  let appCollectionRules: Record<string, import('./contracts').CollectionMode>;
  try { masks = masksForEditor(); }
  catch { revealField(byId('masks')); feedback('遮挡区域格式无效，或超出了屏幕范围。请检查高级 JSON。'); return; }
  try { appCollectionRules = readAppRules(); }
  catch (error) { feedback((error as Error).message); return; }
  void perform(async () => {
    const token = readInput('token').trim();
    const updated = await desktopApi.configure({
      metadataEnabled: byId<HTMLInputElement>('metadata-enabled').checked,
      defaultCollection: readInput('default-collection') as import('./contracts').CollectionMode, appCollectionRules,
      diagnosticsEnabled: byId<HTMLInputElement>('diagnostics-enabled').checked, diagnosticIntervalSeconds: numberInput('diagnostic-interval'),
      jpegQuality: numberInput('jpeg-quality'), captureMaxSide: numberInput('capture-max-side'), pauseOnBattery: byId<HTMLInputElement>('pause-on-battery').checked, batteryPauseBelowPct: numberInput('battery-pause-below'),
      syncMode: selectedSyncMode(), syncIntervalMinutes: numberInput('sync-interval'), syncBatchSize: numberInput('sync-batch'),
      ...(byId<HTMLInputElement>('confirm-local-backlog').checked ? { confirmLocalBacklog: true } : {}),
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
byId('start').addEventListener('click', () => {
  if (settingsDirty) { showPage('settings'); feedback('请先保存或还原修改，再开始采集。'); return; }
  void perform(async () => render(await desktopApi.start()));
});
byId('stop').addEventListener('click', () => void perform(async () => render(await desktopApi.stop())));
byId('retry').addEventListener('click', () => void perform(async () => { render(await desktopApi.retry()); feedback(currentStatus.sync.message, currentStatus.sync.state !== 'error' && currentStatus.sync.state !== 'unconfigured'); }));
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

byId('central').addEventListener('click', () => {
  if (!currentStatus?.config.tokenConfigured) { showPage('connection'); feedback('先连接你的中央节点，即可打开中央仓库。'); return; }
  if (currentStatus.config.credentialScope === 'collector') {
    revealField(byId('connection-owner-token')); feedback('此设备使用采集专用连接。填写管理员令牌后即可打开中央仓库。'); return;
  }
  void perform(() => desktopApi.openCentral());
});
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
      byId('note-feedback').textContent = currentStatus.sync.state === 'unconfigured' ? '已保存到本机。连接节点并确认后，再按你的策略同步。' : `已保存到本机 · ${syncModeLabels[currentStatus.config.syncMode]}上传。中央确认后清理待传记录。`;
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
  const editor = byId('source-editor-title').closest('details');
  if (editor) editor.open = true;
  byId('source-editor-title').scrollIntoView({ block: 'start', behavior: 'instant' });
  byId('source-retention').focus({ preventScroll: true });
  byId<HTMLSelectElement>('source-retention').value = source.retention; byId<HTMLInputElement>('source-interval').value = String(source.intervalSeconds);
  byId<HTMLInputElement>('source-deletions').checked = source.trackDeletions; byId<HTMLInputElement>('source-extensions').value = source.extensions.join(',');
  byId<HTMLTextAreaElement>('source-excludes').value = source.excludedPaths.join('\n'); byId<HTMLTextAreaElement>('source-redacts').value = source.redactLiterals.join('\n'); refreshPresets();
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
  if (settingsDirty) { showPage('settings'); feedback('请先保存或还原设置修改，再安装更新。'); return; }
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
  const status = await desktopApi.confirmConnection(connectionPreview.id, connectionPreview.serverUrl); clearConnectionPreview();
  if (settingsDirty) {
    // Pairing changes connection credentials only; preserve edits in other settings pages.
    byId<HTMLInputElement>('server-url').value = status.config.serverUrl;
    byId<HTMLInputElement>('token').value = '';
    byId<HTMLInputElement>('token').placeholder = '已安全保存；留空保留已有令牌';
  } else fillConfig(status.config);
  render(status); renderConnection(await desktopApi.connectionStatus()); feedback('连接已安全保存；原设备 ID、隐私设置和本地模型保留。', true);
}));
byId('connection-test').addEventListener('click', () => void perform(async () => renderConnection(await desktopApi.testConnection())));
byId('connection-owner-open').addEventListener('click', () => { const token = readInput('connection-owner-token').trim(); byId<HTMLInputElement>('connection-owner-token').value = ''; void perform(() => desktopApi.openCentralOwner(token)); });
void desktopApi.connectionStatus().then(renderConnection).catch(() => {});

function addAppRule(id = '', mode: import('./contracts').CollectionMode = 'activity'): void {
  const row = document.createElement('div'); row.className = 'app-rule';
  const input = document.createElement('input'); input.value = id; input.placeholder = 'com.example.app'; input.maxLength = 256; input.setAttribute('aria-label', '应用 Bundle ID'); input.spellcheck = false;
  const select = document.createElement('select'); select.setAttribute('aria-label', '应用采集级别');
  for (const [value, label] of [['content', '完整内容'], ['activity', '仅应用活动'], ['off', '不记录']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
  select.value = mode;
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除规则'; remove.addEventListener('click', () => { row.remove(); markSettingsDirty(); });
  const identity = document.createElement('label'); identity.className = 'app-identity'; const name = document.createElement('span'); name.textContent = installedApps.find(app => app.appId === id)?.appName || (id ? '应用规则' : '自定义应用'); identity.append(name, input);
  row.append(identity, select, remove); byId('app-collection-rules').append(row);
}
function readAppRules(): Record<string, import('./contracts').CollectionMode> {
  const rules: Record<string, import('./contracts').CollectionMode> = {};
  for (const row of Array.from(byId('app-collection-rules').children)) {
    const id = row.querySelector('input')!.value.trim(); const mode = row.querySelector('select')!.value as import('./contracts').CollectionMode;
    if (!id) { revealField(row.querySelector('input')!); throw new Error('应用规则需要填写 Bundle ID；不用的规则请移除'); }
    if (Object.hasOwn(rules, id)) { revealField(row.querySelector('input')!); throw new Error('同一应用只能设置一条采集规则'); }
    Object.defineProperty(rules, id, { value: mode, enumerable: true });
  }
  return rules;
}
byId('add-custom-app-rule').addEventListener('click', () => { addAppRule(); markSettingsDirty(); byId('app-collection-rules').lastElementChild?.querySelector('input')?.focus(); });

// Friendly controls write the same validated configuration as the custom fields.
const syncModeLabels: Record<import('./contracts').SyncMode, string> = { realtime: '实时', interval: '定时', batch: '积攒一批', manual: '仅手动' };
function selectedSyncMode(): import('./contracts').SyncMode {
  return (document.querySelector<HTMLInputElement>('[name=sync-mode]:checked')?.value || 'realtime') as import('./contracts').SyncMode;
}
function updateSyncOptions(): void {
  const mode = selectedSyncMode();
  byId('sync-interval-field').hidden = mode !== 'interval' && mode !== 'batch';
  byId('sync-batch-field').hidden = mode !== 'batch';
  byId('sync-interval-label').textContent = mode === 'batch' ? '最长等待（分钟）' : '上传间隔（分钟）';
  const descriptions = {
    realtime: '记录保存后尽快发送。断网或失败时仍留在本机，稍后自动重试。',
    interval: `每 ${readInput('sync-interval')} 分钟检查并上传待传记录。休眠期间顺延，唤醒后继续。`,
    batch: `攒够 ${readInput('sync-batch')} 条，或最早记录等待 ${readInput('sync-interval')} 分钟后发送，以先达到的条件为准。每条记录单独确认接收。`,
    manual: '不自动上传记录或发送设备状态。点击概览的“立即上传”或来源页的“立即检查并上传”时发送；下次仍由你手动触发。',
  };
  byId('sync-policy-help').textContent = descriptions[mode];
}
for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[name=sync-mode], #sync-interval, #sync-batch'))) input.addEventListener('input', updateSyncOptions);
function updateLocalBacklog(): void {
  if (!currentStatus) return;
  byId('local-backlog-confirmation').hidden = !currentStatus.sync.localBacklogUnbound;
  let destination = '你填写的节点';
  try { destination = new URL(readInput('server-url')).origin; } catch { /* Blank means local-only. */ }
  byId('local-backlog-copy').textContent = `本机有 ${currentStatus.sync.pendingRecords} 条尚未绑定节点的待传记录，及可能尚未完成保存的随手记。确认后将归属 ${destination}，按上传策略发送。`;
}
for (const id of ['server-url', 'token']) byId(id).addEventListener('input', () => { byId<HTMLInputElement>('confirm-local-backlog').checked = false; updateLocalBacklog(); });

const presetFields: Record<string, [number, string][]> = {
  interval: [[10, '每 10 秒 · 更细致'], [15, '每 15 秒 · 默认'], [30, '每 30 秒 · 日常'], [60, '每分钟 · 轻量'], [300, '每 5 分钟 · 低频']],
  idle: [[60, '空闲 1 分钟后'], [300, '空闲 5 分钟后'], [900, '空闲 15 分钟后'], [0, '不检测空闲']],
  'battery-pause-below': [[0, '不按电量暂停'], [10, '低于 10%'], [20, '低于 20%'], [30, '低于 30%']],
  'queue-mb': [[256, '256 MiB · 轻量'], [512, '512 MiB · 默认'], [1024, '1 GiB · 日常'], [5120, '5 GiB · 更多离线记录'], [20480, '20 GiB · 长期离线']],
  'queue-events': [[1000, '1,000 条'], [10000, '10,000 条'], [50000, '50,000 条'], [100000, '100,000 条']],
  'sync-interval': [[15, '15 分钟'], [30, '30 分钟'], [60, '1 小时'], [360, '6 小时'], [1440, '1 天']],
  'sync-batch': [[10, '10 条'], [20, '20 条'], [50, '50 条'], [100, '100 条'], [500, '500 条']],
  'source-interval': [[60, '每分钟'], [300, '每 5 分钟'], [900, '每 15 分钟'], [3600, '每小时']],
  'jpeg-quality': [[65, '65 · 节省空间'], [75, '75 · 默认'], [80, '80 · 均衡'], [90, '90 · 清晰']],
  'capture-max-side': [[1280, '1280 px'], [1600, '1600 px · 默认'], [1920, '1920 px'], [2560, '2560 px']],
  'review-max-tokens': [[128, '128 · 简短审查'], [256, '256 · 默认'], [512, '512 · 较长输出']],
  'review-max-side': [[256, '256 px · 轻量'], [512, '512 px · 默认'], [768, '768 px · 细节'], [1024, '1024 px · 更清晰']],
  'nsfw-threads': [[1, '1 · 最少资源'], [2, '2 · 默认'], [4, '4 · 更快处理'], [8, '8 · 更多资源']],
  'nsfw-timeout': [[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [180, '3 分钟']],
  'diagnostic-interval': [[15, '每 15 秒'], [60, '每分钟'], [300, '每 5 分钟']],
};
function refreshPresets(): void {
  for (const [id, choices] of Object.entries(presetFields)) {
    const input = byId<HTMLInputElement>(id), select = byId<HTMLSelectElement>(id + '-preset');
    select.value = choices.some(([value]) => value === Number(input.value)) ? input.value : 'custom';
    input.hidden = select.value !== 'custom';
  }
  const quality = `${readInput('capture-max-side')},${readInput('jpeg-quality')}`;
  byId<HTMLSelectElement>('image-preset').value = ['1280,65', '1600,75', '1920,80', '2560,90'].includes(quality) ? quality : 'custom';
  refreshExtensionChoices();
}
for (const [id, choices] of Object.entries(presetFields)) {
  const input = byId<HTMLInputElement>(id), select = document.createElement('select');
  select.id = id + '-preset'; input.dataset.preset = select.id;
  select.setAttribute('aria-label', (input.parentElement?.firstChild?.textContent || '配置').trim() + '预设');
  for (const [value, label] of [...choices, ['custom', '自定义…']] as [number | string, string][]) select.add(new Option(label, String(value)));
  input.before(select); input.classList.add('custom-value');
  select.addEventListener('change', () => {
    input.hidden = select.value !== 'custom';
    if (select.value === 'custom') { input.focus(); return; }
    input.value = select.value; input.dispatchEvent(new Event('input', { bubbles: true }));
    refreshPresets(); updateSyncOptions();
  });
  input.addEventListener('input', () => { select.value = 'custom'; });
}
byId('image-preset').addEventListener('change', () => {
  const value = readInput('image-preset');
  if (value === 'custom') { revealField(byId('jpeg-quality')); return; }
  const [side, quality] = value.split(',');
  byId<HTMLInputElement>('capture-max-side').value = side; byId<HTMLInputElement>('jpeg-quality').value = quality;
  refreshPresets(); markSettingsDirty();
});
byId('image-custom').addEventListener('click', () => revealField(byId('jpeg-quality')));

let installedApps: { appId: string; appName: string }[] = [];
byId('add-app-rule').addEventListener('click', () => void perform(async () => {
  byId('app-picker').hidden = false;
  installedApps = await desktopApi.installedApplications();
  const select = byId<HTMLSelectElement>('installed-app-choice');
  select.replaceChildren(...installedApps.map(app => new Option(`${app.appName} · ${app.appId}`, app.appId)));
  byId('app-picker-hint').textContent = installedApps.length ? `找到 ${installedApps.length} 个应用；选择后可调整采集级别。应用列表仅用于本机设置。` : '暂未找到应用，可在下方“手动输入 ID”中添加。';
  byId<HTMLButtonElement>('use-installed-app').disabled = !installedApps.length;
  byId<HTMLButtonElement>('exclude-installed-app').disabled = !installedApps.length;
  select.focus();
}));
function useInstalledApp(exclude: boolean): void {
  const id = readInput('installed-app-choice'); if (!id) return;
  if (exclude) {
    const ids = new Set(readInput('excluded-apps').split('\n').map(value => value.trim()).filter(Boolean)); ids.add(id);
    byId<HTMLTextAreaElement>('excluded-apps').value = [...ids].join('\n');
    byId('app-picker-hint').textContent = `${installedApps.find(app => app.appId === id)?.appName || id} 已加入完全排除列表，保存设置后生效。`;
  } else {
    const existing = Array.from(byId('app-collection-rules').children).find(row => row.querySelector('input')?.value === id);
    if (existing) { existing.querySelector('select')?.focus(); byId('app-picker-hint').textContent = '这个应用已有规则，可直接修改下方采集级别。'; return; }
    addAppRule(id); byId('app-picker-hint').textContent = '已添加为仅活动。可在规则中选择完整内容或不记录，保存设置后生效。';
  }
  markSettingsDirty();
}
byId('use-installed-app').addEventListener('click', () => useInstalledApp(false));
byId('exclude-installed-app').addEventListener('click', () => useInstalledApp(true));

type Mask = import('./contracts').Rectangle;
function masksForEditor(): Mask[] {
  const masks: unknown = JSON.parse(readInput('masks') || '[]');
  if (!Array.isArray(masks) || masks.length > 100 || masks.some(mask => !mask || ['x', 'y', 'width', 'height'].some(key => typeof mask[key] !== 'number' || !Number.isFinite(mask[key])) || mask.x < 0 || mask.y < 0 || mask.width <= 0 || mask.height <= 0 || mask.x + mask.width > 1 || mask.y + mask.height > 1)) throw new Error('最多 100 个遮挡区域，需要位于屏幕以内，宽高大于 0。请检查高级 JSON。');
  return masks;
}
function renderMaskPreview(masks: Mask[]): void {
  const group = document.getElementById('mask-preview-regions')!; group.replaceChildren();
  for (const mask of masks) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [key, scale] of [['x', 400], ['y', 225], ['width', 400], ['height', 225]] as const) rect.setAttribute(key, String(mask[key] * scale));
    rect.setAttribute('class', 'mask-region'); group.append(rect);
  }
}
function writeMasks(masks: Mask[]): void { byId<HTMLTextAreaElement>('masks').value = JSON.stringify(masks, null, 2); renderMaskPreview(masks); markSettingsDirty(); }
function renderMaskEditor(): void {
  const editor = byId('mask-editor'); editor.replaceChildren();
  let masks: Mask[];
  try { masks = masksForEditor(); } catch (error) { const p = document.createElement('p'); p.className = 'helper'; p.textContent = (error as Error).message; editor.append(p); renderMaskPreview([]); return; }
  renderMaskPreview(masks);
  if (!masks.length) { const p = document.createElement('p'); p.className = 'helper'; p.textContent = '尚未设置固定遮挡。选择上方预设即可添加。'; editor.append(p); }
  masks.forEach((mask, index) => {
    const card = document.createElement('div'); card.className = 'mask-control';
    const heading = document.createElement('div'); heading.className = 'section-heading';
    const title = document.createElement('strong'); title.textContent = `区域 ${index + 1}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除遮挡区域 ${index + 1}`);
    remove.addEventListener('click', () => { masks.splice(index, 1); writeMasks(masks); renderMaskEditor(); }); heading.append(title, remove); card.append(heading);
    const grid = document.createElement('div'); grid.className = 'form-grid';
    const controls = new Map<keyof Mask, { input: HTMLInputElement; output: HTMLOutputElement }>();
    for (const [key, title] of [['x', '距左侧'], ['y', '距顶部'], ['width', '宽度'], ['height', '高度']] as const) {
      const label = document.createElement('label'), output = document.createElement('output'), input = document.createElement('input');
      input.type = 'range'; input.min = key === 'width' || key === 'height' ? '0.1' : '0'; input.max = '100'; input.step = '0.1'; input.setAttribute('aria-label', `区域 ${index + 1} ${title}`);
      input.value = String(mask[key] * 100); output.textContent = `${+(mask[key] * 100).toFixed(1)}%`;
      controls.set(key, { input, output }); label.append(title, output, input); grid.append(label);
      input.addEventListener('input', () => {
        mask[key] = Number(input.value) / 100;
        if (key === 'x') mask.x = Math.min(mask.x, 1 - mask.width);
        if (key === 'y') mask.y = Math.min(mask.y, 1 - mask.height);
        if (key === 'width') mask.width = Math.min(mask.width, 1 - mask.x);
        if (key === 'height') mask.height = Math.min(mask.height, 1 - mask.y);
        for (const [field, control] of controls) { mask[field] = Math.round(mask[field] * 10000) / 10000; control.input.value = String(mask[field] * 100); control.output.textContent = `${+(mask[field] * 100).toFixed(1)}%`; }
        writeMasks(masks);
      });
    }
    card.append(grid); editor.append(card);
  });
}
const maskPresets: Record<string, Mask> = { notification: { x: .7, y: 0, width: .3, height: .2 }, menubar: { x: 0, y: 0, width: 1, height: .04 }, sidebar: { x: 0, y: 0, width: .22, height: 1 }, custom: { x: .25, y: .25, width: .25, height: .25 } };
for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-mask]'))) button.addEventListener('click', () => {
  try { const masks = masksForEditor(); if (masks.length >= 100) { feedback('最多可设置 100 个遮挡区域，请先移除不需要的区域。'); return; } masks.push({ ...maskPresets[button.dataset.mask!] }); writeMasks(masks); renderMaskEditor(); }
  catch (error) { revealField(byId('masks')); feedback((error as Error).message); }
});
byId('masks').addEventListener('change', renderMaskEditor);

const extensionChoices = [['.md', 'Markdown'], ['.txt', '纯文本'], ['.json', 'JSON'], ['.csv', 'CSV 表格'], ['.ics', '日历文件']] as const;
function refreshExtensionChoices(): void {
  const selected = new Set(readInput('source-extensions').split(',').map(value => value.trim()));
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[data-source-extension]'))) input.checked = selected.has(input.value);
}
const extensionInput = byId<HTMLInputElement>('source-extensions');
const extensionBox = document.createElement('div'); extensionBox.className = 'extension-choices'; extensionBox.setAttribute('role', 'group'); extensionBox.setAttribute('aria-label', '常用文件类型');
for (const [extension, title] of extensionChoices) {
  const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = extension; input.dataset.sourceExtension = extension;
  label.className = 'extension-choice'; label.append(input, title); extensionBox.append(label);
  input.addEventListener('change', () => {
    const values = new Set(readInput('source-extensions').split(',').map(value => value.trim()).filter(Boolean));
    if (input.checked) values.add(extension); else values.delete(extension);
    extensionInput.value = [...values].join(',');
  });
}
extensionInput.closest('label')!.before(extensionBox);
extensionInput.addEventListener('input', refreshExtensionChoices);
refreshExtensionChoices();
