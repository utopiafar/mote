import { getLocale, moteText } from '@mote/shared/i18n';
import type { DesktopApi, Status } from './contracts';
import type { DesktopPage } from './navigation';
import type { SyncHistoryPage, SyncHistoryItem, SyncSource, SyncHistoryRun } from './sync-history';

const names: Record<SyncSource, () => string> = {
  screen: () => moteText('截图'), ui_page: () => moteText('页面内容采集'), note: () => moteText('随手记'), activity: () => moteText('应用活动'), notification: () => moteText('通知'),
  file: () => moteText('文件与目录'), calendar: () => moteText('系统日历'), coding: () => 'Coding Agent',
};
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const n = (value: number) => value.toLocaleString(getLocale());
const bytes = (value: number) => `${(value / 1048576).toFixed(2)} MiB`;
const dateTime = (s: string) => new Date(s).toLocaleString(getLocale(), { hour12: false });
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const label = (source: SyncSource) => names[source]?.() ?? source;
const badge = (outcome: SyncHistoryRun['outcome'] | SyncHistoryItem['outcome']) => {
  const messages = { sending: moteText('正在上传'), received: moteText('中央已接收'), partial: moteText('部分成功'), unconfirmed: moteText('未确认'), interrupted: moteText('同步已中断') };
  return `<span class="upload-badge ${outcome === 'received' ? 'received' : outcome === 'sending' ? '' : 'needs-attention'}">${escape(messages[outcome])}</span>`;
};
export function createSyncHistoryUi(api: DesktopApi, navigate: (page: DesktopPage) => void) {
  const el = (id: string) => document.getElementById(id)!;
  const contentDialog = el('upload-content-dialog') as HTMLDialogElement;
  const receiptDialog = el('upload-receipt-dialog') as HTMLDialogElement;
  const closeReceipt = () => { runGeneration++; receiptDialog.close(); };
  const closeContent = () => { contentGeneration++; contentDialog.close(); };
  let current: Status | undefined, active = false, days: 1 | 7 = 1, offset = 0, source: SyncSource | undefined, outcome: 'received' | 'unconfirmed' | undefined;
  let refreshGeneration = 0, contentGeneration = 0, runGeneration = 0, timer: ReturnType<typeof setInterval> | undefined, refreshing = false;
  let runId = '', contentOffset = 0, contentSource: SyncSource | undefined, contentOutcome: 'received' | 'unconfirmed' | undefined, selected: SyncHistoryItem | undefined, chunkOffset = 0;
  let pending: Awaited<ReturnType<DesktopApi['syncHistoryPending']>> = [];
  (el('upload-day') as HTMLInputElement).value = localDay();
  const failure = (error: unknown) => error instanceof Error ? error.message : moteText('状态读取失败，请重试。');
  const setText = (id: string, s: string) => { el(id).textContent = s; };
  async function refresh() {
    if (!active || refreshing) return;
    refreshing = true; const generation = ++refreshGeneration;
    try {
      const day = (el('upload-day') as HTMLInputElement).value;
      const [page, week, rows] = await Promise.all([api.syncHistory({ day, days, offset, source, outcome }), api.syncHistory({ day, days: 7 }), api.syncHistoryPending()]);
      if (!active || generation !== refreshGeneration) return;
      pending = rows; render(page, week); setText('upload-error', '');
    } catch (error) { if (generation === refreshGeneration) setText('upload-error', failure(error)); }
    finally { if (generation === refreshGeneration) refreshing = false; }
  }
  function render(page: SyncHistoryPage, week: SyncHistoryPage) {
    const total = pending.reduce((sum, r) => sum + r.pending, 0), review = pending.reduce((sum, r) => sum + r.review, 0), errors = pending.reduce((sum, r) => sum + r.blocked + r.retrying, 0);
    const status = current?.sync;
    setText('upload-status-title', !current?.config.serverUrl || !current.config.tokenConfigured ? moteText('仅保存在本机') : status?.state === 'uploading' ? moteText('正在上传') : status?.state === 'error' || errors ? moteText('部分记录需要处理') : total ? moteText('本机记录等待同步') : moteText('本机积存内容已全部同步'));
    setText('upload-status-message', status?.message ?? moteText('正在读取'));
    setText('upload-status-extra', moteText('本机待传 {0} 条，含 {1} 条待隐私复核。', total, review));
    setText('upload-received', n(page.received)); setText('upload-bytes', bytes(page.bytes)); setText('upload-pending', n(total)); setText('upload-needs-attention', n(errors + review));
    setText('upload-review-count', moteText('{0} 条待复核', review)); setText('upload-failure-count', moteText('{0} 条需重试或处理', errors));
    setText('upload-period-label', days === 1 ? moteText('当天中央接收确认') : moteText('近 7 天中央接收确认'));
    setText('upload-retention-note', moteText('同步凭据从 {0} 开始记录，保留最近 30 天；旧版本历史无法补齐。', dateTime(page.since)));
    const maximum = Math.max(1, ...week.days.map(d => d.received));
    el('upload-chart').innerHTML = week.days.map(d => `<button class="upload-chart-day" data-upload-day="${d.day}" aria-label="${escape(moteText('{0}：中央接收 {1} 条', d.day, d.received))}"><span class="upload-bar-value">${n(d.received)}</span><span class="upload-chart-space"><span class="upload-chart-bar" data-height="${d.received ? Math.max(4, d.received / maximum * 95) : 0}"></span></span><span>${d.day.slice(5)}</span></button>`).join('');
    el('upload-chart').querySelectorAll<HTMLElement>('.upload-chart-bar').forEach(bar => { bar.style.height = `${Number(bar.dataset.height)}px`; });
    el('upload-source-summary').innerHTML = Object.keys(names).map(s => { const key = s as SyncSource, confirmed = page.sources.find(r => r.source === key)?.received ?? 0, queued = pending.find(r => r.source === key)?.pending ?? 0; return `<button class="upload-source-row" data-upload-source="${s}"><span>${escape(label(key))}</span><span>${n(confirmed)} / ${n(queued)} →</span></button>`; }).join('');
    el('upload-run-list').innerHTML = page.items.length ? `<div class="upload-table-wrap"><table class="upload-table"><thead><tr><th>${moteText('同步时间')}</th><th>${moteText('来源')}</th><th>${moteText('中央接收')}</th><th>${moteText('结果')}</th><th>${moteText('传输量')}</th><th></th></tr></thead><tbody>${page.items.map(r => `<tr><td>${escape(dateTime(r.startedAt))}<small>${r.trigger === 'manual' ? moteText('手动上传') : moteText('自动上传')}</small></td><td>${escape(r.sources.map(label).join(' / '))}</td><td>${moteText('{0} 条', n(r.received))}<small>${r.unconfirmed ? moteText('{0} 条未确认', n(r.unconfirmed)) : ''}</small></td><td>${badge(r.outcome)}</td><td>${bytes(r.bytes)}</td><td><button class="text-button" data-upload-run="${r.id}">${moteText('详情 →')}</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="upload-empty">${moteText('当前范围没有同步凭据。开始采集或添加来源后，上传结果会显示在这里。')}</div>`;
    setText('upload-run-page', moteText('第 {0} 页 · 共 {1} 轮同步', Math.floor(page.offset / 20) + 1, n(page.total)));
    (el('upload-prev') as HTMLButtonElement).disabled = offset === 0;
    (el('upload-next') as HTMLButtonElement).disabled = page.nextOffset === undefined;
    el('upload-next').dataset.offset = String(page.nextOffset ?? 0);
  }
  function resetFilters() { offset = 0; refreshGeneration++; refreshing = false; void refresh(); }
  async function receipt(id: string) {
    const generation = ++runGeneration; runId = id;
    el('upload-receipt-body').textContent = moteText('正在读取'); if (!receiptDialog.open) receiptDialog.showModal();
    try { const page = await api.syncHistoryContents({ runId: id }); if (generation !== runGeneration || !receiptDialog.open) return; const r = page.run;
      el('upload-receipt-body').innerHTML = `<h2>${escape(dateTime(r.startedAt))}</h2><p class="helper">${r.trigger === 'manual' ? moteText('手动上传') : moteText('自动上传')}</p>${badge(r.outcome)}<div class="upload-receipt-metrics"><div><span>${moteText('中央接收')}</span><strong>${n(r.received)}</strong></div><div><span>${moteText('未确认')}</span><strong>${n(r.unconfirmed)}</strong></div><div><span>${moteText('传输量')}</span><strong>${bytes(r.bytes)}</strong></div><div><span>${moteText('耗时')}</span><strong>${r.finishedAt ? moteText('{0} 秒', Math.max(0, (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(1)) : moteText('正在上传')}</strong></div></div><h3>${moteText('包含的来源')}</h3>${r.sources.map(s => `<button class="upload-source-row" data-upload-content-source="${s}"><span>${escape(label(s))}</span><span>${moteText('查看内容 →')}</span></button>`).join('')}<button class="primary upload-view-all" id="upload-view-all">${moteText('查看本次全部内容（{0} 条）', n(r.total))}</button><p class="upload-note">${moteText('接收确认与中央识别、索引、整理分别进行。失败重试保留原凭据；内容按当前归档保留策略读取。')}</p>${r.unconfirmed ? `<button class="secondary" id="upload-receipt-retry">${moteText('重试上传')}</button>` : ''}`;
    } catch (error) { if (generation === runGeneration) el('upload-receipt-body').textContent = failure(error); }
  }
  async function contents(id: string, filter?: SyncSource) {
    runId = id; contentSource = filter; contentOutcome = undefined; contentOffset = 0;
    closeReceipt(); selected = undefined; (el('upload-content-source') as HTMLSelectElement).value = filter ?? ''; (el('upload-content-outcome') as HTMLSelectElement).value = '';
    if (!contentDialog.open) contentDialog.showModal(); await loadContents();
  }
  async function loadContents() {
    const generation = ++contentGeneration;
    setText('upload-content-list', moteText('正在读取')); setText('upload-content-preview', moteText('请选择一条记录查看内容。'));
    try {
      const page = await api.syncHistoryContents({ runId, source: contentSource, outcome: contentOutcome, offset: contentOffset });
      if (generation !== contentGeneration || !contentDialog.open) return;
      setText('upload-content-title', moteText('{0} · 本次上传内容', dateTime(page.run.startedAt)));
      el('upload-content-list').innerHTML = page.items.length ? page.items.map((item, i) => `<button class="upload-record-pick" data-upload-key="${escape(item.key)}" data-index="${i}"><strong>${escape(item.title || label(item.source))}</strong><small>${escape(label(item.source))} · ${escape(dateTime(item.observedAt))}</small>${badge(item.outcome)}</button>`).join('') : `<p class="upload-empty">${moteText('当前筛选没有记录。')}</p>`;
      const available = new Set(page.run.sources); el('upload-content-source').querySelectorAll<HTMLOptionElement>('option').forEach(option => { option.hidden = Boolean(option.value && !available.has(option.value as SyncSource)); });
      setText('upload-content-page', moteText('第 {0} 页 · 共 {1} 条', Math.floor(page.offset / 20) + 1, n(page.total)));
      (el('upload-content-prev') as HTMLButtonElement).disabled = contentOffset === 0; (el('upload-content-next') as HTMLButtonElement).disabled = page.nextOffset === undefined; el('upload-content-next').dataset.offset = String(page.nextOffset ?? 0);
      el('upload-content-list').querySelectorAll<HTMLButtonElement>('button').forEach(button => button.addEventListener('click', () => { selected = page.items[Number(button.dataset.index)]; chunkOffset = 0; void preview(); }));
      selected = page.items[0]; chunkOffset = 0; if (selected) await preview();
    } catch (error) { if (generation === contentGeneration) setText('upload-content-list', failure(error)); }
  }
  async function preview() {
    if (!selected) return; const generation = ++contentGeneration, item = selected;
    el('upload-content-list').querySelectorAll<HTMLButtonElement>('button').forEach(button => { const chosen = button.dataset.uploadKey === item.key; button.classList.toggle('selected', chosen); button.setAttribute('aria-pressed', String(chosen)); });
    setText('upload-content-preview', moteText('正在读取内容…'));
    try { const result = await api.syncHistoryContent(runId, item.key, chunkOffset); if (generation !== contentGeneration || !contentDialog.open) return;
      el('upload-content-preview').innerHTML = `<h2>${escape(item.title || label(item.source))}</h2><p class="helper">${escape(label(item.source))} · ${escape(dateTime(item.observedAt))}</p><div class="actions">${badge(result.location === 'central' ? 'received' : item.outcome)}<span class="upload-badge">${result.location === 'central' ? moteText('中央已归档') : moteText('本机待传副本')}</span></div>${result.image ? `<img class="upload-content-image" src="${escape(result.image)}" alt="${escape(moteText('当前选择的采集截图'))}">` : ''}<h3>${moteText('内容')}</h3>${result.metadataOnly ? `<p class="upload-note">${moteText('此记录仅同步目录信息，未上传正文或原件。')}</p>` : result.text ? `<pre class="upload-content-text">${escape(result.text)}</pre>` : `<p class="upload-note">${result.processing ? moteText('内容已接收，中央仍在处理正文。请稍后刷新。') : moteText('此记录暂无可预览正文；可查看元数据或在中央打开原件。')}</p>`}${result.nextChunkOffset !== undefined ? `<button class="secondary" id="upload-next-chunks" data-offset="${result.nextChunkOffset}">${moteText('下一页正文')}</button>` : ''}<details class="disclosure"><summary>${moteText('元数据')}</summary><pre class="upload-content-text">${escape(result.metadata)}</pre></details><div class="actions"><button class="secondary" id="upload-preview-refresh">${moteText('刷新内容')}</button>${result.captureId ? `<button class="text-button" id="upload-preview-central" data-capture="${result.captureId}">${moteText('在中央打开 →')}</button>` : ''}</div><p class="upload-note">${moteText('已上传内容从中央读取；本机副本可能已清理。正文最长预览 100000 个字符，原件及完整内容可在中央查看。')}</p>`;
    } catch (error) { if (generation === contentGeneration) el('upload-content-preview').innerHTML = `<p role="alert">${escape(failure(error))}</p><button class="secondary" id="upload-preview-refresh">${moteText('重试')}</button>`; }
  }
  async function retry() { (el('upload-now') as HTMLButtonElement).disabled = true; try { await api.retry(); await refresh(); } catch (e) { setText('upload-error', failure(e)); } finally { (el('upload-now') as HTMLButtonElement).disabled = false; } }
  el('upload-refresh').addEventListener('click', () => void refresh()); el('upload-now').addEventListener('click', () => void retry());
  el('upload-day').addEventListener('change', resetFilters);
  el('upload-source-filter').addEventListener('change', e => { source = (e.target as HTMLSelectElement).value as SyncSource || undefined; resetFilters(); });
  el('upload-outcome-filter').addEventListener('change', e => { outcome = (e.target as HTMLSelectElement).value as typeof outcome || undefined; resetFilters(); });
  el('upload-history-root').addEventListener('click', e => { const button = (e.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
    if (button.dataset.uploadDays) { days = Number(button.dataset.uploadDays) as 1 | 7; el('upload-history-root').querySelectorAll('[data-upload-days]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); resetFilters(); }
    if (button.dataset.uploadDay) { (el('upload-day') as HTMLInputElement).value = button.dataset.uploadDay; days = 1; el('upload-history-root').querySelectorAll('[data-upload-days]').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.uploadDays === '1'))); resetFilters(); }
    if (button.dataset.uploadSource) { source = button.dataset.uploadSource as SyncSource; (el('upload-source-filter') as HTMLSelectElement).value = source; resetFilters(); el('upload-run-list').scrollIntoView({ block: 'start' }); }
    if (button.dataset.uploadRun) void receipt(button.dataset.uploadRun);
    if (button.id === 'upload-prev') { offset = Math.max(0, offset - 20); void refresh(); } if (button.id === 'upload-next') { offset = Number(button.dataset.offset); void refresh(); }
    if (button.id === 'upload-attention') { outcome = 'unconfirmed'; (el('upload-outcome-filter') as HTMLSelectElement).value = outcome; resetFilters(); }
    if (button.id === 'upload-review') navigate('privacy'); if (button.id === 'upload-source-settings') navigate('sources');
  });
  receiptDialog.addEventListener('click', e => { const b = (e.target as Element).closest<HTMLButtonElement>('button'); if (b?.id === 'upload-view-all') void contents(runId); if (b?.dataset.uploadContentSource) void contents(runId, b.dataset.uploadContentSource as SyncSource); if (b?.id === 'upload-receipt-retry') { closeReceipt(); void retry(); } });
  contentDialog.addEventListener('click', e => { const b = (e.target as Element).closest<HTMLButtonElement>('button'); if (!b) return; if (b.id === 'upload-content-back') { closeContent(); void receipt(runId); } if (b.id === 'upload-content-prev' || b.id === 'upload-content-next') { contentOffset = b.id.endsWith('prev') ? Math.max(0, contentOffset - 20) : Number(b.dataset.offset); void loadContents(); } if (b.id === 'upload-preview-refresh') void preview(); if (b.id === 'upload-next-chunks') { chunkOffset = Number(b.dataset.offset); void preview(); } if (b.id === 'upload-preview-central') void api.openCentral(undefined, b.dataset.capture).catch(e => { setText('upload-content-preview', failure(e)); }); });
  for (const id of ['upload-content-source', 'upload-content-outcome']) el(id).addEventListener('change', () => { contentSource = (el('upload-content-source') as HTMLSelectElement).value as SyncSource || undefined; contentOutcome = (el('upload-content-outcome') as HTMLSelectElement).value as typeof contentOutcome || undefined; contentOffset = 0; void loadContents(); });
  receiptDialog.querySelector('[data-upload-close]')!.addEventListener('click', closeReceipt);
  contentDialog.querySelector('[data-upload-close]')!.addEventListener('click', closeContent);
  receiptDialog.addEventListener('cancel', () => { runGeneration++; });
  contentDialog.addEventListener('cancel', () => { contentGeneration++; });
  return {
    show() { active = true; void refresh(); if (!timer) timer = setInterval(() => void refresh(), 5000); },
    hide() { active = false; refreshGeneration++; refreshing = false; if (timer) clearInterval(timer); timer = undefined; closeReceipt(); closeContent(); },
    update(status: Status) { const changed = current && (current.config.serverUrl !== status.config.serverUrl || current.config.deviceId !== status.config.deviceId || current.config.tokenConfigured !== status.config.tokenConfigured); current = status; if (changed) { closeReceipt(); closeContent(); resetFilters(); } },
  };
}
