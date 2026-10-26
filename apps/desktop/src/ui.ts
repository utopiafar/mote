import {createMemoryTopicsUi} from './memory-topics-ui';
import {desktopAppearance} from './appearance';
import {createContentLibraryUi} from './content-library-ui';
import {createSyncHistoryUi} from './sync-history-ui';
import {createDesktopPresentation} from './presentation';
import {createWorkActivityUi} from './work-activity-ui';
import {nativeStatusSummary} from './native-status';
import { renderAskAnswer, renderAskCitation } from './ask-presentation';
import {prependConversationTurns} from './ask-conversation';
import { moteText, getLocale } from '@mote/shared/i18n';
import {builtinUiRules} from '@mote/shared';
import {createAppCaptureUi} from './app-capture-ui';
import {normalizeAppCollectionRules} from './app-collection';
import { DesktopNavigation, desktopPages, needsCollectionSetup, type DesktopPage } from './navigation';
const desktopApi = window.mote;
document.getElementById('ui-page-builtins')!.addEventListener('click',()=>{byId<HTMLTextAreaElement>('ui-page-rules').value=JSON.stringify(builtinUiRules,null,2);appCaptureUi.refreshRules();markSettingsDirty();});
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let currentStatus: import('./contracts').Status;
let initialized = false;
let busy = false;
const fields = byId<HTMLFieldSetElement>('settings-fields');
const settingsForm = byId<HTMLFormElement>('settings');
const appCaptureUi=createAppCaptureUi({root:byId('app-collection-rules'),defaultRoot:byId('default-collection'),rulesEditor:byId<HTMLTextAreaElement>('ui-page-rules'),
  applications:()=>desktopApi.installedApplications(),changed:markSettingsDirty,permissions:()=>{showPage('permissions');},
  editRules:appId=>{const editor=byId<HTMLTextAreaElement>(appId==='com.google.Chrome'?'chrome-origins':'ui-page-rules');revealField(editor);editor.focus();}});
byId('device-name').addEventListener('input', () => markSettingsDirty());
const pageNames = desktopPages;
type Page = DesktopPage;
const navigation = new DesktopNavigation();
const quickNote = location.hash === '#quick-note';
if (quickNote) document.body.classList.add('quick-note-window');
let currentPage: Page = 'overview';
let settingsDirty = false;
let captureStorageDirectory = '';
let settingsApplying = false;
let wasRunningBeforeSave = false;
let pageRevision = 0;
let pageEnteredAt = Date.now();
const pageScroll = new Map<Page, number>();
const settingsPages = new Set<Page>(['connection', 'sync', 'capture', 'privacy', 'developer']);
const memoryTopicsUi=createMemoryTopicsUi(desktopApi,document.getElementById('memory-topics-dialog') as HTMLDialogElement);
const libraryUi=createContentLibraryUi(desktopApi,()=>memoryTopicsUi.open());
function refreshContent():Promise<void>{return libraryUi.refresh();}
const syncHistoryUi = createSyncHistoryUi(desktopApi, page => showPage(page));
const workActivityUi=createWorkActivityUi(desktopApi,page=>showPage(page));
const presentation=createDesktopPresentation({root:document.body,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:byId('main-content'),navigate:page=>{showPage(page);}},desktopAppearance);
window.addEventListener('beforeunload',()=>{workActivityUi.dispose();presentation.dispose();},{once:true});
let setupReviewed = false;
try { setupReviewed = localStorage.getItem('mote-desktop-collection-reviewed') === '1'; } catch { /* Collection remains usable without local storage. */ }

function showPage(page: Page, focus = true, preserveSettingsDraft = false): boolean {
  if (page === 'notes' && !quickNote && desktopApi.openQuickNote) { void desktopApi.openQuickNote(); return false; }
  if (quickNote && page !== 'notes') return false;
  if (!navigation.navigate(page, () => preserveSettingsDraft || !settingsDirty || !settingsPages.has(currentPage) || window.confirm(moteText("有未保存的修改。离开并丢弃修改？")))) return false;
  if (settingsPages.has(currentPage)) pageScroll.delete(currentPage);
  else pageScroll.set(currentPage, window.scrollY);
  if (page !== currentPage) {
    pageRevision++;
    pageEnteredAt = Date.now();
    feedback('');
    if (initialized && settingsPages.has(currentPage) && !preserveSettingsDraft) fillConfig(currentStatus.config);
    if (currentPage === 'connection') {
      clearConnectionPreview();
      byId<HTMLTextAreaElement>('connection-input').value = '';
      // Confirmed pairing still commits if the user navigates away while it is running.
      if (!settingsApplying) void desktopApi.cancelConnection().catch(() => {});
    }
  }
  if (currentPage === 'uploads' && page !== 'uploads') syncHistoryUi.hide();
  if (currentPage === 'work' && page !== 'work') workActivityUi.hide();
  currentPage = page;
  if(initialized) renderOperations(currentStatus.operations??[]);
  if (page === 'uploads') syncHistoryUi.show();
  if (page === 'work') workActivityUi.show();
  const selected = navigation.section;
  presentation.update({section:selected});
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-page]'))) element.hidden = element.dataset.page !== page;
  for (const button of Array.from(document.querySelectorAll<HTMLElement>('aside [data-nav]'))) {
    const active = button.dataset.nav === selected;
    button.classList.toggle('selected', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  const heading = (target: Page) => target === 'overview' ? moteText('工作台') : document.querySelector<HTMLElement>(`[data-page="${target}"] [data-page-title]`)?.textContent?.trim() ?? '';
  const title = heading(page), sectionTitle = heading(page==='connection'&&navigation.backTarget==='ask'?'ask':selected);
  byId('workspace-location').textContent = page === selected ? title : `${sectionTitle} / ${title}`;
  byId('workspace-back').hidden = !navigation.canGoBack;
  updateNoteAction();
  byId('workspace-back').setAttribute('aria-label', moteText("返回{0}", heading(navigation.backTarget)));
  updateSettingsHint();
  if (focus) document.querySelector<HTMLElement>(`[data-page="${page}"] [data-page-title]`)?.focus({ preventScroll: true });
  window.scrollTo({ top: pageScroll.get(page) || 0, behavior: 'instant' });
  if (page === 'compression') { byId<HTMLInputElement>('compression-quality').value=String(currentStatus.config.jpegQuality); const side=byId<HTMLSelectElement>('compression-side');if(!Array.from(side.options).some(o=>o.value===String(currentStatus.config.captureMaxSide)))side.add(new Option(String(currentStatus.config.captureMaxSide),String(currentStatus.config.captureMaxSide)));side.value=String(currentStatus.config.captureMaxSide); void refreshCompression(); }
  if (page === 'ask') void refreshAsk();
  if (page === 'permissions') void refreshPermissions();
  if (page === 'privacy') void appCaptureUi.refreshApplications();
  if (page === 'statistics') void loadStorageStatistics();
  if (page === 'records') { void loadRecords(); void refreshContent(); }
  if (page === 'overview' && initialized) { void refreshContent(); void refreshSources(); }
  if (page === 'sources') void refreshSources();
  if (page === 'overview' && initialized) void desktopApi.status().then(render).catch(() => feedback(moteText("状态读取失败，请重试。")));
  return true;
}
for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-nav]:not([data-presentation-nav])'))) button.addEventListener('click', () => {
  const page = button.dataset.nav as Page;
  if (pageNames.includes(page)) showPage(page);
});
byId('workspace-back').addEventListener('click', () => showPage(navigation.backTarget));
function updateNoteAction(): void {
  const action = byId('note-action');
  action.classList.add('secondary');
  action.hidden = currentPage !== 'notes' && (navigation.section === 'settings' || settingsPages.has(currentPage));
}
const addDialog=byId<HTMLDialogElement>('add-dialog');
let addOrigin:HTMLElement|undefined;
for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-add]'))) button.addEventListener('click',()=>{addOrigin=button;addDialog.showModal();});
byId('add-close').addEventListener('click',()=>{addDialog.close();addOrigin?.focus();});
for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-add-choice]'))) button.addEventListener('click',()=>{
  addDialog.close(); const action=button.dataset.addChoice;
  if(action==='note')showPage('notes');
  else if(action==='screen')showPage('screen');
  else if(action==='source')showPage('sources');
  else if(action==='folder'||action==='file')void beginSourceSelection(action==='folder'?'directory':'files');
  else if(action==='lark'){
    if(!currentStatus?.config.serverUrl){showPage('connection');feedback(moteText('先连接你的中央节点，即可打开中央仓库。'));return;}
    void perform(()=>desktopApi.openCentral('lark'));
  }
});
function reviewCollectionSetup(): void {
  setupReviewed = true;
  try { localStorage.setItem('mote-desktop-collection-reviewed', '1'); } catch { /* This preference is not required for capture. */ }
  if (currentStatus) render(currentStatus);
}
byId('setup-primary').addEventListener('click', () => { if (showPage('privacy')) reviewCollectionSetup(); });
byId('setup-current').addEventListener('click', () => { reviewCollectionSetup(); byId('start').focus(); });
byId('pause-sending').addEventListener('click',()=>void perform(async()=>{ const updated=await desktopApi.setSyncPaused(!currentStatus.config.syncPaused); render(updated); }));
function updateSettingsHint(): void {
  byId('settings-save-bar').hidden = !settingsPages.has(currentPage);
  byId('settings-pending').hidden = !settingsDirty;
  byId('save-hint').textContent = settingsDirty ? moteText("有未保存的修改，离开前会提醒。保存后立即生效。") : currentStatus?.running ? moteText("保存后立即应用；必要时会短暂暂停并自动恢复采集。") : moteText("设置保存后立即生效；采集保持当前开停状态。");
  byId<HTMLButtonElement>('settings-reset').disabled = !settingsDirty || busy;
  reserveSettingsFooter();
}
// Long translated hints and zoom can add a row. Reserve the actual footer rather
// than a fixed estimate so the final configuration controls remain scrollable.
const settingsSaveBar = byId('settings-save-bar');
function reserveSettingsFooter(): void {
  const fixed = !settingsSaveBar.hidden && getComputedStyle(settingsSaveBar).position === 'fixed';
  document.documentElement.style.setProperty('--settings-save-height', `${fixed ? settingsSaveBar.getBoundingClientRect().height : 0}px`);
}
new ResizeObserver(reserveSettingsFooter).observe(settingsSaveBar);
window.addEventListener('resize', reserveSettingsFooter);
function markSettingsDirty(): void { settingsDirty = true; updateSettingsHint(); }
settingsForm.addEventListener('input', markSettingsDirty);
settingsForm.addEventListener('change', markSettingsDirty);
byId('settings-reset').addEventListener('click', () => {
  if (!currentStatus || busy) return;
  fillConfig(currentStatus.config); feedback(moteText("已还原为上次保存的设置。"), true);
});
// Reveal collapsed or custom inputs before native validation focuses them.
settingsForm.noValidate = true;
function revealField(element: HTMLElement): void {
  const page = element.closest<HTMLElement>('[data-page]')?.dataset.page as Page | undefined;
  if (page && pageNames.includes(page)) showPage(page, true, true);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  if (element instanceof HTMLInputElement && element.dataset.preset) { element.hidden = false; byId<HTMLSelectElement>(element.dataset.preset).value = 'custom'; }
  element.focus(); element.scrollIntoView({ block: 'center', behavior: 'instant' });
}
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); showPage('settings'); }
  if (event.key === 'Escape' && document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && currentPage === 'records' && !byId('record-detail').hidden) closeRecordDetail();
  else if (event.key === 'Escape' && navigation.canGoBack) showPage(navigation.backTarget);
});
desktopApi.onNavigate?.(page => {
  if (page === 'central') byId('central').click();
  else if (pageNames.includes(page)) showPage(page);
});
showPage(quickNote ? 'notes' : 'overview', false);

function feedback(message: string, success = false): void {
  const box = byId('feedback'); box.textContent = message; box.hidden = !message; box.className = success ? 'success' : '';
}
function setText(id: string, value: string): void { const element = byId(id); if (element.textContent !== value) element.textContent = value; }

let selectedSession: import('@mote/shared/capture-sessions').CaptureSession | undefined;
let selectedRecordButton: HTMLButtonElement | undefined;
let recordsRevision = 0, recordsPage = 0, recordsNext: string | undefined;
let recordsCursors: (string | undefined)[] = [undefined];
const recordsDate = new Date();
byId<HTMLInputElement>('records-day').value = `${recordsDate.getFullYear()}-${String(recordsDate.getMonth() + 1).padStart(2, '0')}-${String(recordsDate.getDate()).padStart(2, '0')}`;
const ocrNames = { get pending() { return moteText("等待 OCR"); }, get completed() { return moteText("OCR 已完成"); }, get disabled() { return moteText("OCR 已关闭"); }, get failed() { return moteText("OCR 待重试"); }, get unknown() { return moteText("OCR 状态未知"); } };
function ocrLabel(value: import('./capture-browser').BrowserCapture, location: import('./capture-browser').CaptureLocation = 'central'): string {
  if(value.source==='ui_page')return moteText("页面内容采集");
  if(location==='local')return moteText("本机截图 · 完整内容由中央识别");
  return value.ocr.status === 'pending' && value.ocr.reason === 'charging' ? moteText("待接通电源后 OCR") : ocrNames[value.ocr.status];
}
function resetRecords(): void { selectedSession = undefined; recordsPage = 0; recordsCursors = [undefined]; void loadRecords(); }
async function openRecord(item: import('./capture-browser').BrowserCapture, location: import('./capture-browser').CaptureLocation, revision: number): Promise<void> {
  const panel = byId('record-detail'); panel.hidden = false;
  panel.setAttribute('aria-busy', 'true');
  byId('record-detail-title').textContent = item.appName || moteText("截图");
  byId('record-detail-meta').textContent = `${new Date(item.capturedAt).toLocaleString(getLocale())} · ${ocrLabel(item, location)}`;
  byId('record-detail-text').textContent = moteText("正在读取记录详情…");
  byId<HTMLImageElement>('record-detail-image').removeAttribute('src');
  byId('record-detail-title').focus(); panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const id = item.id; panel.dataset.recordId = id;
  let detailRead = false;
  try {
    const detail = await desktopApi.captureDetail(location, id);
    if (revision !== recordsRevision || panel.dataset.recordId !== id || panel.hidden) return;
    byId('record-detail-meta').textContent = `${new Date(detail.capturedAt).toLocaleString(getLocale())} · ${detail.deviceName || ''} · ${ocrLabel(detail, location)}${detail.syncError ? ' · ' + detail.syncError : ''}`;
    byId('record-detail-text').textContent = detail.ocrText || (detail.ocr.status === 'completed' ? moteText("未识别到文字。") : ocrLabel(detail, location));
    detailRead = true;
    byId<HTMLImageElement>('record-detail-image').alt = moteText("正在加载原图…");
    if (!detail.hasImage) { byId<HTMLImageElement>('record-detail-image').alt=moteText("此采样没有图片"); return; }
    const image = await desktopApi.captureImage(location, id, false);
    if (revision === recordsRevision && panel.dataset.recordId === id && !panel.hidden) { byId<HTMLImageElement>('record-detail-image').src = image; byId<HTMLImageElement>('record-detail-image').alt = moteText("当前选择的采集截图"); }
  } catch (error) { if (revision === recordsRevision && panel.dataset.recordId === id) {
    const message = error instanceof Error ? error.message : moteText("读取记录失败，请刷新后重试");
    if (detailRead) byId<HTMLImageElement>('record-detail-image').alt = moteText("原图加载失败：{0}；可重新打开详情重试", message);
    else byId('record-detail-text').textContent = message;
  } }
  finally { if (revision === recordsRevision && panel.dataset.recordId === id) panel.setAttribute('aria-busy', 'false'); }
}
async function loadRecords(): Promise<void> {
  const revision = ++recordsRevision;
  const location = readInput('records-location') as import('./capture-browser').CaptureLocation;
  byId('records-back').hidden = !selectedSession;
  byId('records-selection').textContent = selectedSession ? `${selectedSession.appName || moteText("应用未知")} · ${new Date(selectedSession.firstAt).toLocaleTimeString(getLocale())} — ${new Date(selectedSession.capturedAt).toLocaleTimeString(getLocale())}` : '';
  byId('record-detail').hidden = true; byId('records-grid').replaceChildren();
  byId('records-status').textContent = moteText("正在读取采集记录…");
  byId('records-status').setAttribute('aria-busy', 'true');
  byId<HTMLButtonElement>('records-previous').disabled = true; byId<HTMLButtonElement>('records-next').disabled = true;
  try {
    const page = await desktopApi.browseCaptures({ source:readInput('records-source') as 'screen'|'ui_page', location, day: readInput('records-day'), cursor: recordsCursors[recordsPage], grouping: readInput('records-grouping') as 'sessions' | 'records', sessionId: selectedSession?.id });
    if (revision !== recordsRevision) return;
    recordsNext = page.nextCursor;
    byId('records-status').textContent = page.items.length ? moteText("{0} · 当天共 {1} 张截图", location === 'local' ? moteText("本机保留") : moteText("中央已归档"), page.totalCount) : location === 'local' ? moteText("当天没有本机待处理截图。已同步的截图可切换到“中央已归档”查看。") : moteText("当天没有已归档截图。");
    byId('records-page').textContent = page.items.length ? moteText("第 {0} 页 · 每页最多 30 张", recordsPage + 1) : '';
    byId<HTMLButtonElement>('records-previous').disabled = recordsPage === 0;
    byId<HTMLButtonElement>('records-next').disabled = !recordsNext;
    if(readInput('records-source')==='ui_page')byId('records-status').textContent=moteText('页面记录：{0} 条',page.totalCount);
    if (page.items.length && readInput('records-source')!=='ui_page') byId('records-status').textContent = moteText("{0} · 列表已读取 {1} 条，正在加载缩略图…", location === 'local' ? moteText("本机保留") : moteText("中央已归档"), page.items.length);
    if (page.sessions) {
      byId('records-status').textContent = moteText("{0} · {1} 条记录 · {2} 个 Session", location === 'local' ? moteText("本机保留") : moteText("中央已归档"), page.totalCount, page.sessionCount);
      byId('records-page').textContent = moteText("第 {0} 页", recordsPage + 1);
      for (const session of page.sessions) {
        const card=document.createElement('button');card.type='button';card.className='record-session';
        const title=document.createElement('strong');title.textContent=session.appName||moteText("应用未知");
        const span=document.createElement('span');span.textContent=`${new Date(session.firstAt).toLocaleTimeString(getLocale())} — ${new Date(session.capturedAt).toLocaleTimeString(getLocale())}`;
        const count=document.createElement('small');count.textContent=moteText("{0} 条记录 · {1} 张图片 · 展开 →", session.count, session.imageCount);
        card.append(title,span,count);card.addEventListener('click',()=>{selectedSession=session;recordsPage=0;recordsCursors=[undefined];void loadRecords();});byId('records-grid').append(card);
      }
      return;
    }
    const images: { element: HTMLImageElement; item: import('./capture-browser').BrowserCapture }[] = [];
    for (const item of page.items) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'record-card';
      const image = document.createElement('img'); image.alt = `${item.appName || moteText("截图")} · ${new Date(item.capturedAt).toLocaleTimeString(getLocale())}`;
      const caption = document.createElement('div'); caption.className = 'record-card-caption';
      const title = document.createElement('strong'); title.textContent = item.appName || moteText("截图");
      const time = document.createElement('time'); time.dateTime = item.capturedAt; time.textContent = new Date(item.capturedAt).toLocaleTimeString(getLocale());
      const state = document.createElement('small'); state.textContent = item.syncError ? moteText("同步需处理 · {0}", ocrLabel(item, location)) : `${location === 'local' ? moteText("本机待同步 · ") : ''}${ocrLabel(item, location)}`;
      if(item.sizeBytes!==undefined)state.textContent+=` · ${(item.sizeBytes/1024).toFixed(1)} KiB`;
      caption.append(title, time, state); card.append(image, caption); card.addEventListener('click', () => {
        selectedRecordButton?.classList.remove('selected'); selectedRecordButton?.setAttribute('aria-pressed', 'false');
        selectedRecordButton = card; card.classList.add('selected'); card.setAttribute('aria-pressed', 'true');
        void openRecord(item, location, revision);
      });
      byId('records-grid').append(card); if(item.hasImage) images.push({ element: image, item }); else image.alt=moteText("无图片 · 点击查看采样记录");
    }
    let next = 0, completed = 0, failed = 0;
    await Promise.all(Array.from({ length: Math.min(4, images.length) }, async () => {
      while (next < images.length && revision === recordsRevision) {
        const { element, item } = images[next++];
        try { const image = await desktopApi.captureImage(location, item.id, true); if (revision === recordsRevision) element.src = image; }
        catch { failed++; if (revision === recordsRevision) element.alt = moteText("缩略图暂不可用；点击查看详情或刷新"); }
        completed++;
        if (revision === recordsRevision) byId('records-status').textContent = moteText("正在加载缩略图 {0}/{1} · 失败 {2}", completed, images.length, failed);
      }
    }));
    if (revision === recordsRevision && page.items.length && readInput('records-source')!=='ui_page') byId('records-status').textContent = moteText("{0} · 当天共 {1} 张截图 · 缩略图成功 {2}/{3}{4}", location === 'local' ? moteText("本机保留") : moteText("中央已归档"), page.totalCount, completed - failed, images.length, failed ? moteText(" · {0} 张失败，可刷新重试", failed) : '');
  } catch (error) { if (revision === recordsRevision) { byId('records-status').textContent = error instanceof Error ? error.message : moteText("读取采集记录失败，请重试"); byId('records-page').textContent = ''; } }
  finally { if (revision === recordsRevision) {
    byId('records-status').setAttribute('aria-busy', 'false');
    byId('records-grid').classList.toggle('record-list',readInput('records-source')==='ui_page'||readInput('records-layout')==='list');
  } }
}
byId('records-back').addEventListener('click', resetRecords);
byId('records-source').addEventListener('change', resetRecords);
byId('records-grouping').addEventListener('change', resetRecords);
byId('records-day').addEventListener('change', resetRecords);
byId('records-location').addEventListener('change', resetRecords);
byId('records-layout').addEventListener('change',()=>byId('records-grid').classList.toggle('record-list',readInput('records-layout')==='list'));
byId('records-refresh').addEventListener('click', resetRecords);
byId('records-previous').addEventListener('click', () => { if (recordsPage > 0) { recordsPage--; void loadRecords(); } });
byId('records-next').addEventListener('click', () => { if (recordsNext) { recordsCursors[++recordsPage] = recordsNext; void loadRecords(); } });
function closeRecordDetail(): void {
  byId('record-detail').hidden = true; byId<HTMLImageElement>('record-detail-image').removeAttribute('src');
  selectedRecordButton?.classList.remove('selected'); selectedRecordButton?.setAttribute('aria-pressed', 'false'); selectedRecordButton?.focus();
}
byId('record-detail-close').addEventListener('click', closeRecordDetail);
function readInput(id: string): string { return byId<HTMLInputElement>(id).value; }
function numberInput(id: string): number { return Number(readInput(id)); }
function fillConfig(config: import('./contracts').PublicConfig): void {
  byId<HTMLInputElement>('packed-upload').checked = config.packedUpload ?? false;
  writeChannels(byId('default-collection'),config.defaultCollection);
  byId<HTMLInputElement>('structured-ocr').checked=config.structuredOcrEnabled;
  byId<HTMLTextAreaElement>('chrome-origins').value=config.chromeOrigins.join('\n');
  byId<HTMLTextAreaElement>('ui-page-rules').value=JSON.stringify(config.uiPageRules??[],null,2);
  byId<HTMLInputElement>('notification-collection').checked=Boolean(config.notificationCollectionEnabled);
  captureStorageDirectory = config.captureStorageDirectory || '';
  renderStorage();
  const values: Record<string, string | number> = {
    'diagnostic-interval': config.diagnosticIntervalSeconds, 'image-dedupe': config.imageDedupeMode ?? 'off', 'jpeg-quality': config.jpegQuality, 'capture-max-side': config.captureMaxSide, 'battery-pause-below': config.batteryPauseBelowPct,
    'server-url': config.serverUrl, 'device-name': config.deviceName, interval: config.intervalMs / 1000,
    'queue-mb': config.maxQueueBytes / 1024 / 1024, 'queue-events': config.maxQueueEvents,
    'sync-interval': config.syncIntervalMinutes, 'sync-batch': config.syncBatchSize,
    masks: JSON.stringify(config.masks, null, 2),
    idle: config.idlePauseSeconds,
  };
  for (const [id, value] of Object.entries(values)) byId<HTMLInputElement>(id).value = String(value);
  byId<HTMLInputElement>('metadata-enabled').checked = config.metadataEnabled;
  appCaptureUi.setConfig(config);
  byId<HTMLInputElement>('diagnostics-enabled').checked = config.diagnosticsEnabled;
  byId<HTMLInputElement>('pause-on-battery').checked = config.pauseOnBattery;
  byId<HTMLInputElement>('login').checked = currentStatus.environment?.defaultProfile === false ? false : config.openAtLogin;
  byId<HTMLInputElement>('gate-enabled').checked = config.uploadGate?.enabled ?? true;
  byId<HTMLTextAreaElement>('gate-text').value = (config.uploadGate?.blockedText ?? []).join('\n');
  byId<HTMLSelectElement>('gate-failure').value = config.uploadGate?.failureAction ?? 'hold';
  byId<HTMLInputElement>('token').value = '';
  byId<HTMLInputElement>('token').placeholder = config.tokenConfigured ? moteText("已安全保存；留空保留已有令牌") : moteText("输入中央节点访问令牌");
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[name=sync-mode]'))) input.checked = input.value === config.syncMode;
  byId<HTMLInputElement>('confirm-local-backlog').checked = false;
  refreshPresets(); updateSyncOptions(); renderMaskEditor(); updateLocalBacklog();
  updateTokenField();
  settingsDirty = false; updateSettingsHint();
}
function renderStorage(): void {
  byId('storage-restart').hidden = !currentStatus?.storage?.recoveryRequired;
  byId<HTMLInputElement>('capture-directory').value = captureStorageDirectory || currentStatus?.storage?.defaultDirectory || moteText("默认位置（当前环境目录）");
  byId('capture-directory-state').textContent = currentStatus?.storage?.cleanupPending ? moteText("新目录已生效；旧副本尚未清理，请连接原磁盘后重新打开 Mote。") : captureStorageDirectory !== (currentStatus?.config.captureStorageDirectory || '') ? moteText("保存设置后迁移本机已有记录，过程中会自动暂停并恢复。") : moteText("这里保存本机待同步的截图。完整内容识别与已归档图片保存在中央节点。");
}
byId('storage-restart').addEventListener('click', () => void desktopApi.restartForStorageRecovery());
byId('capture-directory-choose').addEventListener('click', () => void perform(async () => {
  const revision = pageRevision;
  const result = await desktopApi.chooseCaptureDirectory();
  if (revision === pageRevision && !result.canceled && result.directory) { captureStorageDirectory = result.directory; markSettingsDirty(); renderStorage(); }
}));
byId('capture-directory-default').addEventListener('click', () => { captureStorageDirectory = ''; markSettingsDirty(); renderStorage(); });
byId('capture-directory-open').addEventListener('click', () => void perform(() => desktopApi.openCaptureDirectory()));
let connectionPreview: import('./connection').ConnectionPreview | undefined;
function renderOperations(jobs:NonNullable<import('./contracts').Status['operations']>):void {
  // Completed work belongs to the page where it began; active work and failures remain global.
  const operations=jobs.filter(job=>job.state!=='completed'||job.startedAt>=pageEnteredAt);
  byId('background-progress').hidden = !operations.length;
  byId('background-progress').textContent = operations.map(job => `${job.message}${job.total !== undefined ? ` · ${job.completed ?? 0}/${job.total}` : ''}${job.state === 'running' ? moteText(" · 已用 {0} 秒", Math.floor((Date.now() - job.startedAt) / 1000)) : ''}`).join('；');
}
function render(status: import('./contracts').Status): void {
  syncHistoryUi.update(status);libraryUi.update(status);memoryTopicsUi.update(status);workActivityUi.update(status);
  if(currentStatus&&(currentStatus.authorizationGeneration!==status.authorizationGeneration||currentStatus.config.serverUrl!==status.config.serverUrl||currentStatus.config.tokenConfigured!==status.config.tokenConfigured||currentStatus.config.authSignedOut!==status.config.authSignedOut||currentStatus.config.authExpiresAt!==status.config.authExpiresAt)){
    recordsRevision++;closeRecordDetail();byId('records-grid').replaceChildren();byId('record-detail-title').textContent='';byId('record-detail-meta').textContent='';byId('record-detail-text').textContent='';
    askGeneration++;clearTimeout(askTimer);askRun=undefined;askConversation=undefined;askPendingInput=undefined;byId('ask-history').replaceChildren();renderAsk();setText('ask-login-status','');
  }
  currentStatus = status; renderStorage();appCaptureUi.setStatus(status);
  askConnectionState();
  updateTokenField();
  renderOperations(status.operations??[]);
  byId('connection-device').textContent = moteText("设备：{0} · ID {1}。迁移已有设备时，请在中央邀请中选择此 ID。", status.config.deviceName, status.config.deviceId);
  byId('environment').textContent = status.environment ? moteText("环境：{0}{1} · {2}", status.environment.profile, status.environment.defaultProfile ? moteText("（原日常目录）") : moteText(" · 独立数据"), status.environment.dataDirectory) : '';
  const names = { stopped: moteText("采集已停止"), capturing: moteText("正在采集"), paused: moteText("采集已暂停"), permission_required: moteText("需要屏幕录制权限"), error: moteText("采集已停止 · 需要处理") };
  setText('state', names[status.state]);
  setText('sidebar-state', names[status.state]);
  const hasCentralConnection = Boolean(status.config.serverUrl && status.config.tokenConfigured);
  const centralState = !hasCentralConnection ? 'unconfigured' : status.sync.state === 'uploading' ? 'syncing' : status.sync.state === 'error' ? 'error' : 'connected';
  const centralTitle = !hasCentralConnection
    ? moteText("未连接中央节点")
    : centralState === 'syncing'
      ? moteText("正在同步中央节点")
      : centralState === 'error'
        ? moteText("连接需要处理")
        : moteText("已连接中央节点");
  const centralMessage = !hasCentralConnection
    ? moteText("记录只保存在本机；连接后按你的策略上传。")
    : centralState === 'error'
      ? status.sync.message
      : status.sync.pendingRecords > 0
        ? moteText("待同步 {0} 条", status.sync.pendingRecords.toLocaleString(getLocale()))
        : status.sync.message;
  const firstCollection = needsCollectionSetup({ reviewed: setupReviewed, running: status.running, hasCapture: Boolean(status.lastCaptureAt), queuedRecords: status.queueDepth, recoveryRequired: status.state === 'error' || Boolean(status.storage?.recoveryRequired) });
  byId('setup-prompt').hidden = !firstCollection;
  byId('collection-workbench').hidden = firstCollection;
  setText('home-screen-state',status.running ? moteText('采集中') : moteText('已停止'));
  setText('home-central-state',centralTitle);
  setText('home-sync-line',status.config.syncPaused?moteText('暂停全部发送'):moteText('待上传 {0} 条',status.sync.pendingRecords));
  setText('pause-sending',status.config.syncPaused?moteText('恢复全部发送'):moteText('暂停全部发送'));
  byId<HTMLButtonElement>('retry').disabled=busy||Boolean(status.config.syncPaused);
  updateNoteAction();
  byId('central-status').className = `central-status ${centralState}`;
  byId('central-status-icon').className = `central-status-icon ${centralState}`;
  setText('central-status-title', centralTitle);
  setText('central-status-message', centralMessage);
  setText('central-status-origin', hasCentralConnection ? `${status.config.deviceName} · ${status.config.serverUrl}` : moteText("连接后，采集记录会按同步设置发送"));
  setText('central-status-action', hasCentralConnection ? moteText("连接详情") : moteText("连接节点"));
  byId('settings-connection-summary').textContent = status.config.tokenConfigured ? moteText("{0} · 已保存连接", status.config.deviceName) : moteText("连接你的中央节点，让记录开始同步");
  byId<HTMLInputElement>('login').disabled = status.environment?.defaultProfile === false;
  byId('login-hint').textContent = status.environment?.defaultProfile === false ? moteText("命名环境使用带 --profile 的启动命令；不会注册可能丢失环境参数的系统登录项。") : moteText("应用启动后保持停止状态，需手动开始采集；已有记录按上传策略处理。");
  setText('message', status.message);
  byId('status-dot').className = `dot ${status.state === 'capturing' ? 'active' : status.state === 'error' || status.state === 'permission_required' ? 'error' : ''}`;
  setText('permission', status.platform !== 'macos' ? moteText("此平台尚不支持采集") : status.screenPermission === 'granted' ? moteText("屏幕权限已授权") : moteText("屏幕权限未授权"));
  setText('permissions', status.screenPermission === 'granted' ? moteText("屏幕录制已授权 · 管理 ↗") : moteText("屏幕录制未授权 · 去授权 ↗"));
  byId('message').setAttribute('aria-busy', String(status.running && status.state === 'capturing'));
  setText('queue-count', status.queueDepth.toLocaleString(getLocale()));
  setText('queue-size', `${(status.queueBytes / 1024 / 1024).toFixed(1)} MiB`);
  setText('last-capture', status.lastCaptureAt ? new Date(status.lastCaptureAt).toLocaleTimeString(getLocale(), { hour12: false }) : moteText("尚无"));
  byId<HTMLButtonElement>('start').disabled = busy || status.running || status.platform !== 'macos';
  byId<HTMLButtonElement>('stop').disabled = !status.running && !(settingsApplying && wasRunningBeforeSave);
  byId('start').hidden = status.running || (settingsApplying && wasRunningBeforeSave);
  byId('stop').hidden = !status.running && !(settingsApplying && wasRunningBeforeSave);
  // A source registration or settings update can need a flush even with no pending bodies.
  byId('retry').hidden = false;
  byId<HTMLButtonElement>('retry').disabled = busy || (status.facts ? !status.facts.sync.allowedActions.includes('retry_sync') : status.sync.state === 'uploading' || status.sync.state === 'unconfigured');
  byId('retry').textContent = status.sync.state === 'error' ? moteText("重试上传") : moteText("立即上传");
  fields.disabled = busy;
  byId<HTMLInputElement>('device-name').disabled = busy;
  for (const id of ['connection-preview', 'connection-json', 'connection-qr', 'connection-test']) byId<HTMLButtonElement>(id).disabled = busy;
  byId<HTMLButtonElement>('connection-cancel').disabled = busy;
  byId<HTMLTextAreaElement>('connection-input').disabled = busy;
  byId<HTMLInputElement>('connection-confirm-origin').disabled = busy;
  byId<HTMLButtonElement>('connection-connect').disabled = busy || !connectionPreview || Date.parse(connectionPreview.expiresAt) <= Date.now() || !byId<HTMLInputElement>('connection-confirm-origin').checked;
  updateSettingsHint();
  const syncNames = { unconfigured: moteText("仅保存在本机"), idle: moteText("已同步"), waiting: moteText("等待同步条件"), uploading: moteText("正在上传"), error: moteText("上传需要处理"), manual: moteText("等待手动上传") };
  const syncStateLabel = status.sync.state === 'idle' && status.sync.pendingRecords > 0 ? moteText("记录已保存 · 准备上传") : syncNames[status.sync.state];
  setText('sync-state', syncStateLabel);
  setText('sync-policy-label', syncModeLabels[status.sync.mode]);
  setText('upload-speed', status.sync.state === 'uploading' ? `${((status.sync.uploadBytesPerSecond ?? 0) / 1024).toFixed(1)} KiB/s` : '0 KiB/s');
  setText('sync-upload-speed', byId('upload-speed').textContent ?? '0 KiB/s');
  setText('sync-message', moteText("{0} · 共 {1} 条待传（含本地来源）", status.sync.message, status.sync.pendingRecords.toLocaleString(getLocale())) + (status.facts ? `\n${nativeStatusSummary(status.facts)}` : ''));
  setText('settings-sync-summary', `${syncModeLabels[status.sync.mode]} · ${status.sync.state === 'unconfigured' ? moteText("未连接时只在本机保存") : syncStateLabel}`);
  updateLocalBacklog();
  const uploadInfo = [];
  if (status.sync.nextUploadAt) uploadInfo.push(`${status.sync.state === 'error' ? moteText("计划重试") : moteText("计划上传")} ${new Date(status.sync.nextUploadAt).toLocaleString(getLocale(), { hour12: false })}`);
  if (status.lastUploadError) uploadInfo.push(status.lastUploadError);
  if (status.lastUploadAt) uploadInfo.push(moteText("最近上传 {0}", new Date(status.lastUploadAt).toLocaleTimeString(getLocale(), { hour12: false })));
  setText('upload-info', uploadInfo.join(' · '));
  byId('token-hint').textContent = status.credentialStorage === 'json'
    ? moteText("开发环境使用权限受限的本机 JSON 保存凭据，不使用系统密钥存储。")
    : status.encryptedTokenStorage ? moteText("使用系统密钥存储加密；不会展示已有令牌。") : moteText("系统加密存储不可用，无法保存令牌。");

  if (status.diagnostics) {
    const d = status.diagnostics, latest = d.latest;
    const rows = [d.enabled ? moteText("诊断开启 · {0} 条数值样本", d.sampleCount) : moteText("诊断关闭"), moteText("保存 {0} · 过滤 {1} · 失败 {2}", d.counters.saved, d.counters.blocked, d.counters.failed), moteText("图像累计 {0} MiB · 已上传请求体约 {1} MiB", (d.counters.imageBytes / 1048576).toFixed(2), (d.counters.uploadedBytes / 1048576).toFixed(2))];
    if (latest) rows.push(moteText("主进程 RSS {0} MiB · 累计 CPU {1} s", (latest.rssBytes / 1048576).toFixed(1), ((latest.cpuUserMicros + latest.cpuSystemMicros) / 1000000).toFixed(1)), moteText("设备电量 {0} · {1} · {2}", latest.batteryPercent === undefined ? moteText("不可用") : latest.batteryPercent.toFixed(0) + '%', latest.onBattery === undefined ? moteText("供电信息不可用") : latest.onBattery ? moteText("电池供电") : moteText("外部电源"), new Date(latest.at).toLocaleTimeString(getLocale())));
    if (d.counters.saved + d.counters.blocked > 0) rows.push(moteText("累计截图文字隐私审查 {0} s", (d.counters.ocrMs / 1000).toFixed(1)));
    if (d.error) rows.push(d.error);
    byId('diagnostics-detail').textContent = rows.join('\n');
  }
  const statistics = [
    moteText("待上传 {0} / {1} 条 · 队列 {2} / {3} MiB（{4}%）", status.queueDepth.toLocaleString(getLocale()), status.config.maxQueueEvents.toLocaleString(getLocale()), (status.queueBytes / 1048576).toFixed(2), (status.config.maxQueueBytes / 1048576).toFixed(0), (100 * status.queueBytes / status.config.maxQueueBytes).toFixed(1)),
    moteText("采样间隔 {0} 秒 · 图像最大边 {1} px · JPEG 质量 {2}", status.config.intervalMs / 1000, status.config.captureMaxSide, status.config.jpegQuality),
  ];
  if (status.diagnostics?.enabled) { const c = status.diagnostics.counters; statistics.push(moteText("诊断累计：保存 {0} · 过滤 {1} · 失败 {2} · 截图文字隐私审查 {3} s", c.saved, c.blocked, c.failed, (c.ocrMs / 1000).toFixed(1)), moteText("累计上传请求体约 {0} MiB；不代表远端存储量。", (c.uploadedBytes / 1048576).toFixed(2))); }
  else statistics.push(moteText("数值诊断未开启；如需持续处理计数、资源与耗时，请在开发者设置中启用。"));
  byId('collection-statistics').replaceChildren(...statistics.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  if (!initialized) { fillConfig(status.config); initialized = true;void refreshContent(); }
}
async function perform(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true; feedback(moteText("正在处理，请稍候…")); byId('feedback').setAttribute('aria-busy', 'true'); if (currentStatus) render(currentStatus);
  try { await action(); } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : moteText("操作失败");
    feedback(message);
  } finally { busy = false; byId('feedback').setAttribute('aria-busy', 'false'); if (byId('feedback').textContent === moteText("正在处理，请稍候…")) feedback(''); if (currentStatus) render(currentStatus); }
}
byId('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !initialized) return;
  for (const element of Array.from(settingsForm.elements)) {
    if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && !element.checkValidity()) {
      revealField(element); element.reportValidity(); return;
    }
  }
  let masks: import('./contracts').Rectangle[];
  let appCollectionRules: Record<string, import('./contracts').CollectionMode>;
  try { masks = masksForEditor(); }
  catch { revealField(byId('masks')); feedback(moteText("遮挡区域格式无效，或超出了屏幕范围。请检查高级 JSON。")); return; }
  try { appCollectionRules = appCaptureUi.readRules(); }
  catch (error) { feedback((error as Error).message); return; }
  void perform(async () => {
    const token = readInput('token').trim();
    settingsApplying = true; wasRunningBeforeSave = currentStatus.running; render(currentStatus);
    let updated: import('./contracts').Status;
    try { updated = await desktopApi.configure({
      syncPaused:currentStatus.config.syncPaused, captureStorageDirectory,
      structuredOcrEnabled:byId<HTMLInputElement>('structured-ocr').checked, chromeOrigins:readInput('chrome-origins').split('\n').map(s=>s.trim()).filter(Boolean), uiPageRules:JSON.parse(readInput('ui-page-rules')||'[]'),
      notificationCollectionEnabled: byId<HTMLInputElement>('notification-collection').checked,
      metadataEnabled: byId<HTMLInputElement>('metadata-enabled').checked,
      defaultCollection: readChannels(byId('default-collection')), appCollectionRules,
      diagnosticsEnabled: byId<HTMLInputElement>('diagnostics-enabled').checked, diagnosticIntervalSeconds: numberInput('diagnostic-interval'),
      packedUpload: byId<HTMLInputElement>('packed-upload').checked, imageDedupeMode: readInput('image-dedupe') as import('./image-dedupe').ImageDedupeMode, jpegQuality: numberInput('jpeg-quality'), captureMaxSide: numberInput('capture-max-side'), pauseOnBattery: byId<HTMLInputElement>('pause-on-battery').checked, batteryPauseBelowPct: numberInput('battery-pause-below'),
      syncMode: selectedSyncMode(), syncIntervalMinutes: numberInput('sync-interval'), syncBatchSize: numberInput('sync-batch'),
      ...(byId<HTMLInputElement>('confirm-local-backlog').checked ? { confirmLocalBacklog: true } : {}),
      serverUrl: readInput('server-url'), deviceName: readInput('device-name'), intervalMs: numberInput('interval') * 1000,
      maxQueueBytes: numberInput('queue-mb') * 1024 * 1024, maxQueueEvents: numberInput('queue-events'),
      masks,
      idlePauseSeconds: numberInput('idle'),
      uploadGate: {enabled:byId<HTMLInputElement>('gate-enabled').checked,blockedText:readInput('gate-text').split('\n').map(s=>s.trim()).filter(Boolean),failureAction:readInput('gate-failure') as 'drop'|'hold'|'allow'},
      openAtLogin: byId<HTMLInputElement>('login').checked,
      ...(token ? { token } : {}),
    });
    } finally { settingsApplying = false; wasRunningBeforeSave = false; }
    render(updated); fillConfig(updated.config); feedback(updated.running ? moteText("设置已保存并立即生效，采集已恢复。") : moteText("设置已保存并立即生效，采集保持停止。"), true);
  });
});
const captureConfirmation=byId<HTMLDialogElement>('capture-confirm-dialog');
let captureConfirmedConfig='';
function showCaptureConfirmation():void {
  const config=currentStatus.config;captureConfirmedConfig=JSON.stringify(config);
  const describe=(v:import('./contracts').CollectionMode)=>[v.duration?moteText('记录时长'):'',v.screenshots?moteText('保存截图'):'',v.structured?moteText('结构化解析'):''].filter(Boolean).join(' / ')||moteText('不记录');
  byId('capture-confirm-range').textContent=[moteText('未单独配置的应用：{0}',describe(config.defaultCollection)),...Object.entries(config.appCollectionRules).map(([id,mode])=>`${id} · ${describe(mode)}`),moteText('固定遮挡：{0} 个区域',config.masks.length)].join('\n');
  byId('capture-confirm-destination').textContent=config.serverUrl?moteText('先保存本机，再按发送策略发送到：{0}',config.serverUrl):moteText('尚未连接中央，先保存在本机');
  captureConfirmation.showModal();
}
byId('start').addEventListener('click', () => {
  if (settingsDirty) { showPage('settings'); feedback(moteText("请先保存或还原修改，再开始采集。")); return; }
  showCaptureConfirmation();
});
byId('capture-confirm-cancel').addEventListener('click',()=>{captureConfirmation.close();byId('start').focus();});
byId('capture-confirm-start').addEventListener('click',()=>{
  captureConfirmation.close();if(captureConfirmedConfig!==JSON.stringify(currentStatus.config)){showCaptureConfirmation();return;}
  void perform(async () => {
    const permissions = await desktopApi.permissionStatus();
    // Each producer handles missing permissions without disabling independent channels.
    const status = await desktopApi.start();
    if (status.running) reviewCollectionSetup();
    render(status);
  });
});
byId('stop').addEventListener('click', () => { wasRunningBeforeSave = false; void desktopApi.stop().then(render).catch(error => feedback((error as Error).message)); });
byId('retry').addEventListener('click', () => void perform(async () => { render(await desktopApi.retry()); feedback(currentStatus.sync.message, currentStatus.sync.state !== 'error' && currentStatus.sync.state !== 'unconfigured'); }));
byId('permissions').addEventListener('click', () => showPage('permissions'));
byId('data-folder').addEventListener('click', () => void perform(() => desktopApi.openDataFolder()));
byId('export-metadata').addEventListener('click',()=>void perform(()=>desktopApi.exportMetadata()));
byId('export-central').addEventListener('click',()=>void perform(()=>desktopApi.openCentral('vault')));
byId('export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportQueue(); if (!result.canceled) feedback(moteText("队列备份已保存至 {0}", result.path), true); }));
byId('import').addEventListener('click', () => void perform(async () => { const result = await desktopApi.importQueue(); if (!result.canceled) feedback(moteText("已导入 {0} 条待上传记录，重复记录自动跳过。", result.imported), true); }));
desktopApi.onStatus(render);
void desktopApi.status().then(render).catch(() => feedback(moteText("无法连接采集器进程，请重新打开 Mote。")));

byId('note-attachments').addEventListener('click',()=>void perform(()=>desktopApi.openCentral('notes')));
byId('central').addEventListener('click', () => {
  if (!currentStatus?.config.serverUrl) { showPage('connection'); feedback(moteText("先连接你的中央节点，即可打开中央仓库。")); return; }

  void perform(() => desktopApi.openCentral('overview'));
});
byId('home-feature-guide').addEventListener('click', () => {
  if (!currentStatus?.config.serverUrl) { showPage('connection'); feedback(moteText("先连接你的中央节点，即可打开中央仓库。")); return; }
  void perform(() => desktopApi.openCentral('guide'));
});
let draft: import('./note-draft').NoteDraft | undefined;
let noteSaving = false;
let noteComposing = false;
const noteFields = ['note-text', 'save-note'];
function lockNote(locked: boolean): void { for (const id of noteFields) (byId(id) as HTMLInputElement).disabled = locked; }
lockNote(true);
function renderDraft(value: import('./note-draft').NoteDraft): void {
  draft = value; byId<HTMLTextAreaElement>('note-text').value = value.text;
  byId<HTMLTextAreaElement>('note-text').readOnly = Boolean(value.prepared);
}
void desktopApi.noteDraft().then(value => { renderDraft(value); lockNote(false); if (value.prepared) byId('note-feedback').textContent = moteText("发现上次未完成的保存，点击保存可用原 ID 重试。"); }).catch(() => feedback(moteText("无法恢复随手记草稿，请重启应用。")));
for (const id of ['note-text']) {
  byId(id).addEventListener('compositionstart', () => { noteComposing = true; });
  byId(id).addEventListener('compositionend', () => { noteComposing = false; });
}
for (const id of ['note-text']) byId(id).addEventListener('input', () => {
  if (!draft || noteSaving) return;
  draft = { ...draft, text: readInput('note-text'), mood: draft?.mood??'', revision: draft.revision + 1 };
  const changed = draft;
  void desktopApi.updateNoteDraft(changed).then(() => { if (draft?.id === changed.id && draft.revision === changed.revision) byId('note-feedback').textContent = moteText("草稿已保存到本机。"); }).catch(() => { byId('note-feedback').textContent = moteText("草稿暂未保存，请保留正文并重试；如上次保存未完成，请重新打开窗口恢复原稿。"); });
});
byId('note-form').addEventListener('submit', event => {
  event.preventDefault(); if (!draft || noteSaving || noteComposing || busy) return;
  const input = { ...draft, text: readInput('note-text'), mood: draft?.mood??'', revision: draft.revision + 1 };
  noteSaving = true; lockNote(true);
  void perform(async () => {
    try {
      const result = await desktopApi.saveNote(input); renderDraft(result.draft);void refreshContent();
      if (quickNote) window.close();
      byId('note-feedback').textContent = currentStatus.sync.state === 'unconfigured' ? moteText("已保存到本机。连接节点并确认后，再按你的策略同步。") : moteText("已保存到本机 · {0}上传。中央确认后清理待传记录。", syncModeLabels[currentStatus.config.syncMode]);
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : moteText("保存未完成，请重试");
      byId('note-feedback').textContent = message;
      const persisted = await desktopApi.noteDraft();
      if (persisted.prepared || persisted.id !== input.id) renderDraft(persisted);
      else draft = { ...input, revision: Math.max(input.revision, persisted.revision) }; // Keep unsaved text visible if disk persistence failed.
      throw error;
    }
    finally { noteSaving = false; lockNote(false); }
  });
});

byId('open-feedback').addEventListener('click', () => void perform(() => desktopApi.openFeedback()));
byId('diagnostics-sample').addEventListener('click', () => void perform(async () => render(await desktopApi.sampleDiagnostics())));
byId('diagnostics-export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportDiagnostics(); if (!result.canceled) feedback(moteText("数值诊断已导出。"), true); }));
let logText = '';
let logWrap = true;
function renderLogs(): void {
  const viewer = byId('events-viewer'); viewer.replaceChildren();
  const actions = document.createElement('div'); actions.className = 'actions';
  const output = document.createElement('textarea'); output.readOnly = true;
  output.setAttribute('aria-label', moteText("原始日志")); output.spellcheck = false;
  output.className = 'raw-log-output'; output.wrap = logWrap ? 'soft' : 'off'; output.value = logText;
  output.placeholder = moteText("暂无日志。诊断关闭时停止新增，历史仍可查看。");
  const notice = document.createElement('p'); notice.setAttribute('role', 'status');
  notice.textContent = moteText("按文件原始顺序显示，可拖动选中或使用 ⌘/Ctrl+A、C 复制。");
  for (const label of [moteText("刷新日志"), moteText("复制全部"), moteText("全选"), moteText("自动换行")]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    if (label === moteText("刷新日志")) button.onclick = () => void loadLogs();
    if (label === moteText("全选")) button.onclick = () => { output.focus(); output.select(); };
    if (label === moteText("自动换行")) {
      button.setAttribute('aria-pressed', String(logWrap));
      button.onclick = () => { logWrap = !logWrap; output.wrap = logWrap ? 'soft' : 'off'; button.setAttribute('aria-pressed', String(logWrap)); };
    }
    if (label === moteText("复制全部")) {
      button.disabled = !logText;
      button.onclick = () => { void navigator.clipboard.writeText(logText).then(() => { notice.textContent = moteText("已复制全部原始日志。"); }, () => { output.focus(); output.select(); notice.textContent = moteText("剪贴板不可用，已全选，请按 ⌘/Ctrl+C 复制。"); }); };
    }
    actions.append(button);
  }
  viewer.append(actions, notice, output);
}
let logLoading = false;
async function loadLogs(): Promise<void> {
  if (logLoading) return;
  logLoading = true;
  const viewer = byId('events-viewer'); viewer.hidden = false;
  try { logText = await desktopApi.readRawEvents(); renderLogs(); }
  catch { let notice = viewer.querySelector('[role="status"]'); if (!notice) { notice = document.createElement('p'); notice.setAttribute('role', 'status'); viewer.append(notice); } notice.textContent = moteText("日志读取失败，请点击查看本地日志重试。"); }
  finally { logLoading = false; }
}
byId('events-open').addEventListener('click', () => void loadLogs());

byId('support-export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportSupport(Number(byId<HTMLSelectElement>('log-export-hours').value)); if (!result.canceled) feedback(moteText("支持包已导出；只含数值、配置开关和固定阶段事件。"), true); }));

let localSourceRows: import('./source-types').SourceStatus[] = [];
let sourceEditingId: string | undefined;
let sourceBusy = false;
let sourceSelection:{id:string;mode:'files'|'directory';names:string[]}|undefined;
const sourceRules=byId<HTMLDetailsElement>('source-rules');
const sourceRulesHome=sourceRules.parentElement!;
function refreshSourcePolicySummaries():void {
  for(const [fieldId,summaryId] of [['source-initial-sync','source-history-value'],['source-retention','source-retention-value']]) byId(summaryId).textContent=byId<HTMLSelectElement>(fieldId).selectedOptions[0]?.textContent??'';
}
function restoreSourceRules():void {sourceRulesHome.append(sourceRules);sourceRules.open=false;byId<HTMLSelectElement>('source-initial-sync').disabled=false;refreshSourcePolicySummaries();}
function updateSourceHistoryChoice():void {const field=byId<HTMLSelectElement>('source-initial-sync'),once=sourceSelection?.mode==='files'&&!byId<HTMLInputElement>('source-continuous').checked;field.disabled=Boolean(once);if(once)field.value='all';refreshSourcePolicySummaries();}
byId('source-initial-sync').addEventListener('change',refreshSourcePolicySummaries);
refreshSourcePolicySummaries();
byId('source-continuous').addEventListener('change',updateSourceHistoryChoice);
async function beginSourceSelection(mode:'files'|'directory'):Promise<void>{
  if(sourceBusy||!showPage('sources'))return;
  await sourceAction(async()=>{
    const result=await desktopApi.selectSourceFiles(mode);if(result.canceled||!result.selectionId)return;
    if(sourceSelection)await desktopApi.cancelSourceFiles(sourceSelection.id);
    sourceSelection={id:result.selectionId,mode,names:result.names??[]};sourceEditingId=undefined;
    byId('source-confirmation').hidden=false;byId('source-selected-names').textContent=sourceSelection.names.join('\n');
    byId('source-confirm-title').textContent=mode==='directory'?moteText('确认同步文件夹'):moteText('确认导入文件');
    byId<HTMLInputElement>('source-continuous').checked=mode==='directory';byId<HTMLInputElement>('source-continuous').disabled=mode==='directory';
    byId('source-destination').textContent=currentStatus?.config.serverUrl?moteText('发送到：{0}',currentStatus.config.serverUrl):moteText('尚未连接中央，先保存在本机');
    byId<HTMLSelectElement>('source-initial-sync').value='all';byId<HTMLSelectElement>('source-retention').value='snapshot';
    updateSourceHistoryChoice();
    byId('source-edit-continuous-row').hidden=true;byId('source-save-edit').hidden=true;byId('source-cancel-edit').hidden=true;
    byId('source-confirm-rules').append(sourceRules);sourceRules.open=true;refreshSourceTextOptions();
    byId('source-confirm-title').scrollIntoView({block:'start'});
  });
}
byId('source-selection-cancel').addEventListener('click',()=>{if(sourceSelection)void desktopApi.cancelSourceFiles(sourceSelection.id);sourceSelection=undefined;byId('source-confirmation').hidden=true;restoreSourceRules();});
byId('source-confirm').addEventListener('click',()=>void sourceAction(async()=>{
  if(!sourceSelection)return;const selected=sourceSelection;const oneTime=selected.mode==='files'&&!byId<HTMLInputElement>('source-continuous').checked;await desktopApi.confirmSourceFiles(selected.id,{...sourceOptions(),initialSync:selected.mode==='files'&&!byId<HTMLInputElement>('source-continuous').checked?'all':sourceOptions().initialSync,syncContinuously:byId<HTMLInputElement>('source-continuous').checked});
  sourceSelection=undefined;byId('source-confirmation').hidden=true;restoreSourceRules();await refreshContent();if(oneTime)showPage('records');
}));
function sourceOptions(): import('./source-types').SourceOptions {
  return { syncContinuously:sourceEditingId?byId<HTMLInputElement>('source-edit-continuous').checked:sourceSelection?byId<HTMLInputElement>('source-continuous').checked:true,centralProcessingConsent:true, initialSync: readInput('source-initial-sync') as 'all' | 'new_only', allowRead:readInput('source-retention')==='snapshot'&&byId<HTMLInputElement>('source-allow-read').checked,retention: readInput('source-retention') as 'snapshot' | 'reference' | 'archive', intervalSeconds: numberInput('source-interval'), trackDeletions: byId<HTMLInputElement>('source-deletions').checked, extensions: readInput('source-extensions').split(',').map(s => s.trim()).filter(Boolean), excludedPaths: readInput('source-excludes').split('\n').map(s => s.trim()).filter(Boolean), redactLiterals: readInput('source-redacts').split('\n').filter(Boolean) };
}
function editSource(id?: string): void {
  if(sourceSelection){void desktopApi.cancelSourceFiles(sourceSelection.id);sourceSelection=undefined;byId('source-confirmation').hidden=true;}restoreSourceRules();
  sourceEditingId = id;
  const source = localSourceRows.find(s => s.source.id === id)?.source;
  byId('source-editor-title').textContent = source ? moteText("编辑：") + source.name : moteText("新来源的保留与过滤规则");
  byId('source-edit-continuous-row').hidden=!source||source.kind!=='local-files';byId<HTMLInputElement>('source-edit-continuous').checked=source?.syncContinuously!==false;
  byId('source-save-edit').hidden = !source; byId('source-cancel-edit').hidden = !source;
  if (!source) { refreshSourceTextOptions(); return; }
  const editor = byId('source-editor-title').closest('details');
  if (editor) editor.open = true;
  byId('source-editor-title').scrollIntoView({ block: 'start', behavior: 'instant' });
  byId('source-retention').focus({ preventScroll: true });
  byId<HTMLSelectElement>('source-initial-sync').value=source.initialSync??'all'; byId<HTMLSelectElement>('source-retention').value = source.retention;byId<HTMLInputElement>('source-allow-read').checked=source.allowRead??false; byId<HTMLInputElement>('source-interval').value = String(source.intervalSeconds);
  byId<HTMLInputElement>('source-deletions').checked = source.trackDeletions; byId<HTMLInputElement>('source-extensions').value = source.extensions.join(',');
  byId<HTMLTextAreaElement>('source-excludes').value = source.excludedPaths.join('\n'); byId<HTMLTextAreaElement>('source-redacts').value = source.redactLiterals.join('\n'); refreshPresets();
  refreshSourceTextOptions();
}
function refreshSourceTextOptions(): void {
  refreshSourcePolicySummaries();
  const source=localSourceRows.find(row=>row.source.id===sourceEditingId)?.source;
  const visible=(!source||source.kind==='local-files')&&readInput('source-retention')==='snapshot';
  byId('source-file-text-options').hidden=!visible;
  byId<HTMLInputElement>('source-allow-read').disabled=!visible;
}
byId('source-retention').addEventListener('change',refreshSourceTextOptions);
let sourcesReading = false;
async function refreshSources(): Promise<void> {
  if (sourcesReading) return;
  sourcesReading = true;
  try {
  const rows = await desktopApi.sources(); localSourceRows = rows;
  const list = byId('source-list'); list.replaceChildren();byId('source-attention').replaceChildren();
  const home=byId('home-sources');home.replaceChildren();
  if(!rows.length){const empty=document.createElement('p');empty.className='helper';empty.textContent=moteText('同步文件夹后，它会出现在这里。也可以连接日历与编码对话。');home.append(empty);}
  for(const row of rows.filter(row=>row.source.syncContinuously!==false).sort((a,b)=>Number(Boolean(b.blocked))-Number(Boolean(a.blocked))).slice(0,4)){const button=document.createElement('button');button.type='button';button.className='home-source';const title=document.createElement('strong');title.textContent=row.source.name;const state=document.createElement('span');state.textContent=row.blocked?moteText('本机待处理 {0} 项',row.blocked):row.source.enabled?row.message:moteText('本机已暂停');button.append(title,state);button.addEventListener('click',()=>{if(showPage('sources'))editSource(row.source.id);});home.append(button);}
  const ongoing = rows.filter(row => row.source.syncContinuously !== false);
  byId('home-onboarding').hidden = ongoing.length > 0 || Boolean(currentStatus?.lastCaptureAt) || Boolean(currentStatus?.running);
  if (!ongoing.length) { const p = document.createElement('p'); p.className = 'helper'; p.textContent = moteText("尚未连接本地来源。选择只包含你希望归档资料的目录。"); list.append(p); }
  const groups = [
    { title: '需要处理', rows: ongoing.filter(row=>Boolean(row.blocked)) },
    { title: '文件与文件夹', rows: ongoing.filter(row=>!row.blocked && row.source.kind==='local-files') },
    { title: 'Coding Agent', rows: ongoing.filter(row=>!row.blocked && row.source.kind==='coding-agent') },
    { title: '本机日历与其他来源', rows: ongoing.filter(row=>!row.blocked && !['local-files','coding-agent'].includes(row.source.kind)) },
  ];
  for (const group of groups) {
    if (!group.rows.length) continue;
    const target=group.title==='需要处理'?byId('source-attention'):list;
    const heading=document.createElement('h2');heading.textContent=moteText(group.title);target.append(heading);
  for (const row of group.rows) {
    const card = document.createElement('article'); card.className = 'source-card';
    const title = document.createElement('strong'); title.textContent = `${row.source.kind === 'local-calendar' ? moteText("日历") : row.source.kind === 'coding-agent' ? moteText("编码对话") : moteText("文件")} · ${row.source.name} · ${row.source.retention === 'reference' ? moteText("仅文件目录") : row.source.retention === 'archive' ? moteText("原件归档") : row.source.kind==='local-files'?moteText("中央提取正文，不保留原件"):moteText("内容快照")}`;
    const detail = document.createElement('p'); detail.className = 'helper profile-path'; detail.textContent = row.source.path || moteText("所选系统日历");
    const status = document.createElement('p'); status.className = 'helper'; status.textContent = moteText("{0} · {1} 项 · 待传 {2} · 跳过 {3}{4}", row.source.enabled ? row.message : moteText("本机已暂停"), row.items, row.pending, row.skipped, row.lastSyncAt ? moteText(" · 最近同步 ") + new Date(row.lastSyncAt).toLocaleString(getLocale()) : '') + (row.facts ? `\n${nativeStatusSummary(row.facts)}` : '');
    const actions = document.createElement('div'); actions.className = 'actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary'; edit.textContent = moteText("编辑规则"); edit.addEventListener('click', () => editSource(row.source.id));
    const pause = document.createElement('button'); pause.type = 'button'; pause.className = 'secondary'; pause.textContent = row.source.enabled ? moteText("暂停这个来源") : moteText("恢复这个来源"); pause.disabled = sourceBusy;
    pause.addEventListener('click', () => void sourceAction(async () => { await desktopApi.updateSource(row.source.id, { ...row.source, enabled: !row.source.enabled }); }));
    actions.append(edit, pause); card.append(title, detail, status);
    if(row.blocked){
      const failures=document.createElement('details'),summary=document.createElement('summary'),explanation=document.createElement('p');
      failures.className='source-failures';summary.textContent=moteText('本机待处理 {0} 项',row.blocked);explanation.className='helper';explanation.textContent=moteText('这些文件的本机副本仍保留，其他资料会继续同步。');failures.append(summary,explanation);
      for(const failure of row.failures??[]){const item=document.createElement('p');item.className='helper profile-path';item.textContent=`${failure.title||failure.externalId} · ${failure.status===410?moteText('中央已删除此文件'):failure.status===409?moteText('文件版本冲突'):moteText('中央拒绝此文件（{0}）',failure.status)}`;failures.append(item);}
      card.append(failures);
    }
    card.append(actions); target.append(card);
  }
  }
  } finally { sourcesReading = false; }
}
async function sourceAction(action: () => Promise<void>): Promise<void> {
  if (sourceBusy) return; sourceBusy = true; byId('source-feedback').textContent = moteText("正在处理，请稍候…");
  for (const id of ['source-agent-discover', 'source-agent-add', 'source-files', 'source-directory', 'source-calendar-connect', 'source-calendar-add', 'source-save-edit', 'source-sync', 'source-confirm']) byId<HTMLButtonElement>(id).disabled = true;
  try { await action(); byId('source-feedback').textContent = moteText("已处理，下面显示各来源的当前同步状态。"); }
  catch (error) { byId('source-feedback').textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : moteText("操作未完成，请检查权限与配置后重试"); }
  finally { sourceBusy = false; for (const id of ['source-agent-discover', 'source-agent-add', 'source-files', 'source-directory', 'source-calendar-connect', 'source-calendar-add', 'source-save-edit', 'source-sync', 'source-confirm']) byId<HTMLButtonElement>(id).disabled = false; await refreshSources().catch(() => {}); }
}
for (const mode of ['files','directory'] as const)byId('source-'+mode).addEventListener('click',()=>void beginSourceSelection(mode));
byId('source-calendar-connect').addEventListener('click', () => void sourceAction(async () => {
  const permissions = await desktopApi.permissionStatus();
  if (permissions.calendar === 'denied') { window.alert(moteText("日历访问尚未授权，请在权限管理中开启。")); showPage('permissions'); return; }
  const calendars = await desktopApi.authorizeCalendar(); const select = byId<HTMLSelectElement>('source-calendar-choice'); select.replaceChildren();
  for (const calendar of calendars) { const option = document.createElement('option'); option.value = calendar.id; option.textContent = calendar.title; select.append(option); }
  byId('source-calendars').hidden = !calendars.length;
  if (!calendars.length) throw new Error(moteText("已授权，但系统中没有可选日历；请在系统日历中添加后重试"));
}));
byId('source-agent-discover').addEventListener('click', () => void sourceAction(async () => {
  const agents = await desktopApi.codingAgents(); const select = byId<HTMLSelectElement>('source-agent-choice'); select.replaceChildren();
  for (const agent of agents.filter(a => a.available)) { const option = document.createElement('option'); option.value = agent.provider; option.textContent = agent.name; select.append(option); }
  select.hidden = !select.options.length; byId('source-agent-add').hidden = !select.options.length;
  if (!select.options.length) throw new Error(moteText("本机默认目录中尚未发现受支持的 Agent 会话"));
}));
byId('source-agent-add').addEventListener('click', () => void sourceAction(() => desktopApi.addCodingAgent(readInput('source-agent-choice') as import('./coding-agents').CodingProvider, sourceOptions())));
byId('source-calendar-add').addEventListener('click', () => void sourceAction(async () => { await desktopApi.addCalendarSource(readInput('source-calendar-choice'), sourceOptions()); }));
byId('source-sync').addEventListener('click', () => void sourceAction(() => desktopApi.syncSources()));
byId('source-calendar-permissions').addEventListener('click', () => void sourceAction(() => desktopApi.openCalendarPermissions()));
byId('source-cancel-edit').addEventListener('click', () => editSource());
byId('source-save-edit').addEventListener('click', () => void sourceAction(async () => {
  const source = localSourceRows.find(s => s.source.id === sourceEditingId)?.source; if (!source) throw new Error(moteText("请先选择要编辑的来源"));
  await desktopApi.updateSource(source.id, { ...sourceOptions(), enabled: source.enabled }); editSource();
}));
void refreshSources().catch(() => { byId('source-feedback').textContent = moteText("来源状态暂不可用，请重新打开应用"); });
setInterval(() => { void refreshSources().catch(() => {}); }, 3000);

let updateState: import('./updater').UpdateStatus | undefined;
function renderUpdate(value: import('./updater').UpdateStatus): void {
  updateState = value;
  for (const id of ['update-channel','update-check','update-download','update-cancel','update-install','update-reveal','update-progress']) byId(id).hidden=!!value.manualDownload;
  byId('update-channel').closest('label')!.hidden=!!value.manualDownload;
  byId('app-updates').querySelector('details')!.hidden=!!value.manualDownload;
  byId('update-notes').textContent=value.manualDownload?moteText('查看 Dev 构建产物'):moteText('查看版本说明与安装包');
  byId('update-version').textContent = moteText("当前 {0}{1}", value.currentVersion, value.availableVersion ? moteText(" · 发布 ") + value.availableVersion : '');
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
byId('update-check').addEventListener('click', () => { void desktopApi.checkUpdate().then(renderUpdate).catch(() => feedback(moteText("更新检查未完成，请重试。"))); });
byId('update-download').addEventListener('click', () => void perform(async () => renderUpdate(await desktopApi.downloadUpdate())));
byId('update-cancel').addEventListener('click', () => { void desktopApi.cancelUpdate().then(renderUpdate).catch(error => feedback(String(error))); });
byId('update-reveal').addEventListener('click', () => void perform(() => desktopApi.revealUpdate()));
byId('update-notes').addEventListener('click', () => void perform(() => desktopApi.releaseNotes()));
byId('update-install').addEventListener('click', () => {
  if (settingsDirty) { showPage('settings'); feedback(moteText("请先保存或还原设置修改，再安装更新。")); return; }
  if (noteSaving || noteComposing) { feedback(moteText("请先完成当前随手记输入，再安装更新。")); return; }
  void perform(async () => {
    lockNote(true); byId('local-sources').inert = true;
    try {
      if (draft && !draft.prepared) { draft = await desktopApi.updateNoteDraft({ ...draft, text: readInput('note-text'), mood: draft?.mood??'', revision: draft.revision + 1 }); }
      await desktopApi.installUpdate();
    } finally { lockNote(false); byId('local-sources').inert = false; }
  });
});
void desktopApi.updateStatus().then(renderUpdate).catch(() => {});
// One polling request at a time, even if a slow disk or worker delays a reply.
let statusReading = false;
setInterval(() => {
  if (statusReading || document.hidden) return;
  statusReading = true;
  void Promise.allSettled([desktopApi.status().then(render), desktopApi.updateStatus().then(renderUpdate)])
    .finally(() => { statusReading = false; });
}, 1000);

function renderConnection(value: import('./connection').ConnectionStatus): void {
  byId('connection-state').textContent = value.message + (value.checkedAt ? ' · ' + new Date(value.checkedAt).toLocaleTimeString(getLocale()) : '');
  byId('connection-capabilities').textContent = value.identity ? moteText("权限：{0} · 中央 {1} · 环境 {2}", moteText("管理员"), value.identity.node.version, value.identity.node.profile) : currentStatus?.config.credentialScope === 'owner' ? moteText("登录凭据已安全保存，所有中央功能共用此登录。") : '';
}
function clearConnectionPreview(): void { connectionPreview = undefined; byId('connection-confirmation').hidden = true; byId<HTMLInputElement>('connection-confirm-origin').checked = false; }
function showConnectionPreview(value: import('./connection').ConnectionPreview): void {
  connectionPreview = value; byId<HTMLTextAreaElement>('connection-input').value = ''; byId<HTMLInputElement>('connection-confirm-origin').checked = false;
  byId('connection-origin').textContent = value.serverUrl; byId('connection-expiry').textContent = moteText("邀请到期：") + new Date(value.expiresAt).toLocaleString(getLocale());
  byId('connection-resume').textContent = value.serverUrl === currentStatus?.config.serverUrl ? moteText("同一节点重新授权后，现有待传截图、随手记和来源版本将继续发往此地址。节点身份以此地址和 HTTPS 证书为准；请确认它仍由你控制。") : moteText("更换节点时，本机必须没有待传截图、随手记或来源版本；设备 ID、隐私设置和本地模型将保留。");
  byId('connection-confirmation').hidden = false; byId<HTMLButtonElement>('connection-connect').disabled = true;
}
byId('connection-input').addEventListener('input', () => { clearConnectionPreview(); void desktopApi.cancelConnection(); });
async function previewForCurrentPage(operation: () => Promise<import('./connection').ConnectionPreview | undefined>): Promise<void> {
  const revision = pageRevision;
  clearConnectionPreview();
  const preview = await operation();
  if (revision !== pageRevision) { await desktopApi.cancelConnection(); return; }
  if (preview) showConnectionPreview(preview);
}
byId('connection-preview').addEventListener('click', () => void perform(() => previewForCurrentPage(() => desktopApi.previewConnection(readInput('connection-input')))));
for (const kind of ['json', 'qr'] as const) byId('connection-' + kind).addEventListener('click', () => void perform(() => previewForCurrentPage(async () => {
  byId<HTMLTextAreaElement>('connection-input').value = '';
  const result = await desktopApi.importConnection(kind); return result.canceled ? undefined : result.preview;
})));
byId('connection-confirm-origin').addEventListener('change', () => { if (currentStatus) render(currentStatus); });
byId('connection-cancel').addEventListener('click', () => { clearConnectionPreview(); byId<HTMLTextAreaElement>('connection-input').value = ''; void desktopApi.cancelConnection(); });
byId('connection-connect').addEventListener('click', () => void perform(async () => {
  if (!connectionPreview || !byId<HTMLInputElement>('connection-confirm-origin').checked) throw new Error(moteText("请先确认中央地址"));
  feedback(moteText("正在连接并验证新凭据，此过程无法取消；原配置在确认成功前保持不变。"));
  settingsApplying = true; wasRunningBeforeSave = currentStatus.running; render(currentStatus);
  let status: import('./contracts').Status;
  try { status = await desktopApi.confirmConnection(connectionPreview.id, connectionPreview.serverUrl, readInput('device-name')); }
  finally { settingsApplying = false; wasRunningBeforeSave = false; }
  clearConnectionPreview();
  // Invitation confirmation replaces the connection page draft with the committed config.
  render(status); fillConfig(status.config);
  renderConnection(await desktopApi.connectionStatus()); feedback(moteText("连接已安全保存；原设备 ID、隐私设置和本地模型保留。"), true);
}));
byId('connection-test').addEventListener('click', () => void perform(async () => renderConnection(await desktopApi.testConnection())));
void desktopApi.connectionStatus().then(renderConnection).catch(() => {});

function channelControls(mode: import('./contracts').CollectionMode):HTMLElement {
  const controls=document.createElement('div');controls.className='capture-channels';
  for(const [key,label] of [['duration',moteText('应用时长')],['screenshots',moteText('截图')],['structured',moteText('结构化内容')]] as const){
    const field=document.createElement('label');field.className='checkbox';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.channel=key;checkbox.checked=mode[key];
    const text=document.createElement('span');text.textContent=label;field.append(checkbox,text);controls.append(field);
  }
  return controls;
}
function writeChannels(target:HTMLElement,mode:import('./contracts').CollectionMode):void{target.replaceChildren(channelControls(mode));}
function readChannels(target:Element):import('./contracts').CollectionMode{return {
 duration:Boolean(target.querySelector<HTMLInputElement>('[data-channel="duration"]')?.checked),
 screenshots:Boolean(target.querySelector<HTMLInputElement>('[data-channel="screenshots"]')?.checked),
 structured:Boolean(target.querySelector<HTMLInputElement>('[data-channel="structured"]')?.checked),
};}
byId('add-custom-app-rule').addEventListener('click', () => {
  const input=byId<HTMLInputElement>('custom-app-id'),id=input.value.trim();
  try{normalizeAppCollectionRules({[id]:{duration:true,screenshots:false,structured:false}});}
  catch{feedback(moteText('请输入有效的应用 Bundle ID'));input.focus();return;}
  const existing=appCaptureUi.readRules()[id];appCaptureUi.addOverride(id,existing??{duration:true,screenshots:false,structured:false});input.value='';
});
byId('chrome-origins').addEventListener('input',()=>appCaptureUi.setOrigins(readInput('chrome-origins').split('\n').map(value=>value.trim()).filter(Boolean)));

// Friendly controls write the same validated configuration as the custom fields.
const syncModeLabels: Record<import('./contracts').SyncMode, string> = { get realtime() { return moteText("实时"); }, get interval() { return moteText("定时"); }, get batch() { return moteText("积攒一批"); }, get manual() { return moteText("仅手动"); } };
function selectedSyncMode(): import('./contracts').SyncMode {
  return (document.querySelector<HTMLInputElement>('[name=sync-mode]:checked')?.value || 'realtime') as import('./contracts').SyncMode;
}
function updateSyncOptions(): void {
  const mode = selectedSyncMode();
  byId('sync-interval-field').hidden = mode !== 'interval' && mode !== 'batch';
  byId('sync-batch-field').hidden = mode !== 'batch';
  byId('sync-interval-label').textContent = mode === 'batch' ? moteText("最长等待（分钟）") : moteText("上传间隔（分钟）");
  const descriptions = {
    realtime: moteText("记录保存后尽快发送。断网或失败时仍留在本机，稍后自动重试。"),
    interval: moteText("每 {0} 分钟检查并上传待传记录。休眠期间顺延，唤醒后继续。", readInput('sync-interval')),
    batch: moteText("攒够 {0} 条，或最早记录等待 {1} 分钟后发送，以先达到的条件为准。每条记录单独确认接收。", readInput('sync-batch'), readInput('sync-interval')),
    manual: moteText("不自动上传记录或发送设备状态。点击概览的“立即上传”或来源页的“立即检查并上传”时发送；下次仍由你手动触发。"),
  };
  byId('sync-policy-help').textContent = descriptions[mode];
}
for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[name=sync-mode], #sync-interval, #sync-batch'))) input.addEventListener('input', updateSyncOptions);
function updateLocalBacklog(): void {
  if (!currentStatus) return;
  byId('local-backlog-confirmation').hidden = !currentStatus.sync.localBacklogUnbound;
  let destination = moteText("你填写的节点");
  try { destination = new URL(readInput('server-url')).origin; } catch { /* Blank means local-only. */ }
  byId('local-backlog-copy').textContent = moteText("本机有 {0} 条尚未绑定节点的待传记录，及可能尚未完成保存的随手记。确认后将归属 {1}，按上传策略发送。", currentStatus.sync.pendingRecords, destination);
}
function updateTokenField(): void {
  byId('node-token-field').hidden = Boolean(currentStatus?.config.tokenConfigured && readInput('server-url').trim().replace(/\/$/, '') === currentStatus.config.serverUrl.replace(/\/$/, ''));
}
byId('server-url').addEventListener('input', updateTokenField);
for (const id of ['server-url', 'token']) byId(id).addEventListener('input', () => { byId<HTMLInputElement>('confirm-local-backlog').checked = false; updateLocalBacklog(); });

const presetFields: Record<string, [number, string][]> = {
  interval: [[10, moteText("每 10 秒 · 更细致")], [15, moteText("每 15 秒 · 默认")], [30, moteText("每 30 秒 · 日常")], [60, moteText("每分钟 · 轻量")], [300, moteText("每 5 分钟 · 低频")]],
  idle: [[60, moteText("空闲 1 分钟后")], [300, moteText("空闲 5 分钟后")], [900, moteText("空闲 15 分钟后")], [0, moteText("不检测空闲")]],
  'battery-pause-below': [[0, moteText("不按电量暂停")], [10, moteText("低于 10%")], [20, moteText("低于 20%")], [30, moteText("低于 30%")]],
  'queue-mb': [[256, moteText("256 MiB · 轻量")], [512, moteText("512 MiB · 默认")], [1024, moteText("1 GiB · 日常")], [5120, moteText("5 GiB · 更多离线记录")], [20480, moteText("20 GiB · 长期离线")]],
  'queue-events': [[1000, moteText("1,000 条")], [10000, moteText("10,000 条")], [50000, moteText("50,000 条")], [100000, moteText("100,000 条")]],
  'sync-interval': [[1, '1 min'], [15, moteText("15 分钟")], [30, moteText("30 分钟")], [60, moteText("1 小时")], [360, moteText("6 小时")], [1440, moteText("1 天")]],
  'sync-batch': [[10, moteText("10 条")], [20, moteText("20 条")], [50, moteText("50 条")], [100, moteText("100 条")], [500, moteText("500 条")]],
  'source-interval': [[60, moteText("每分钟")], [300, moteText("每 5 分钟")], [900, moteText("每 15 分钟")], [3600, moteText("每小时")]],
  'jpeg-quality': [[65, moteText("65 · 节省空间")], [75, moteText("75 · 默认")], [80, moteText("80 · 均衡")], [90, moteText("90 · 清晰")]],
  'capture-max-side': [[1280, '1280 px'], [1600, moteText("1600 px · 默认")], [1920, '1920 px'], [2560, '2560 px']],
  'diagnostic-interval': [[15, moteText("每 15 秒")], [60, moteText("每分钟")], [300, moteText("每 5 分钟")]],
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
  select.setAttribute('aria-label', (input.parentElement?.firstChild?.textContent || moteText("配置")).trim() + moteText("预设"));
  for (const [value, label] of [...choices, ['custom', moteText("自定义…")]] as [number | string, string][]) select.add(new Option(label, String(value)));
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

let installedApps: { appId: string; appName: string; appVersion?:string }[] = [];
byId('add-app-rule').addEventListener('click', () => void perform(async () => {
  byId('app-picker').hidden = false;
  await appCaptureUi.refreshApplications();
  installedApps = appCaptureUi.installedApplications();
  const select = byId<HTMLSelectElement>('installed-app-choice');
  select.replaceChildren(...installedApps.map(app => new Option(`${app.appName} · ${app.appId}`, app.appId)));
  byId('app-picker-hint').textContent = installedApps.length ? moteText("找到 {0} 个应用；选择后可调整采集级别。应用列表仅用于本机设置。", installedApps.length) : moteText("暂未找到应用，可在下方“手动输入 ID”中添加。");
  byId<HTMLButtonElement>('use-installed-app').disabled = !installedApps.length;
  byId<HTMLButtonElement>('exclude-installed-app').disabled = !installedApps.length;
  select.focus();
}));
function useInstalledApp(exclude: boolean): void {
  const id = readInput('installed-app-choice'); if (!id) return;
  const existing=appCaptureUi.readRules()[id];
  appCaptureUi.addOverride(id,exclude?{duration:false,screenshots:false,structured:false}:existing??{duration:true,screenshots:false,structured:false});
  byId('app-picker-hint').textContent = exclude ? moteText("{0} 已加入完全排除列表，保存设置后生效。",installedApps.find(app=>app.appId===id)?.appName||id) : moteText("已添加为仅记录时长。可在规则中分别选择截图与结构化，保存设置后生效。");
  markSettingsDirty();
}
byId('use-installed-app').addEventListener('click', () => useInstalledApp(false));
byId('exclude-installed-app').addEventListener('click', () => useInstalledApp(true));

type Mask = import('./contracts').Rectangle;
function masksForEditor(): Mask[] {
  const masks: unknown = JSON.parse(readInput('masks') || '[]');
  if (!Array.isArray(masks) || masks.length > 100 || masks.some(mask => !mask || ['x', 'y', 'width', 'height'].some(key => typeof mask[key] !== 'number' || !Number.isFinite(mask[key])) || mask.x < 0 || mask.y < 0 || mask.width <= 0 || mask.height <= 0 || mask.x + mask.width > 1 || mask.y + mask.height > 1)) throw new Error(moteText("最多 100 个遮挡区域，需要位于屏幕以内，宽高大于 0。请检查高级 JSON。"));
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
  if (!masks.length) { const p = document.createElement('p'); p.className = 'helper'; p.textContent = moteText("尚未设置固定遮挡。选择上方预设即可添加。"); editor.append(p); }
  masks.forEach((mask, index) => {
    const card = document.createElement('div'); card.className = 'mask-control';
    const heading = document.createElement('div'); heading.className = 'section-heading';
    const title = document.createElement('strong'); title.textContent = moteText("区域 {0}", index + 1);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = moteText("移除遮挡区域 {0}", index + 1); remove.setAttribute('aria-label', moteText("移除遮挡区域 {0}", index + 1));
    remove.addEventListener('click', () => { masks.splice(index, 1); writeMasks(masks); renderMaskEditor(); }); heading.append(title, remove); card.append(heading);
    const grid = document.createElement('div'); grid.className = 'form-grid';
    const controls = new Map<keyof Mask, { input: HTMLInputElement; output: HTMLOutputElement }>();
    for (const [key, title] of [['x', moteText("距左侧")], ['y', moteText("距顶部")], ['width', moteText("宽度")], ['height', moteText("高度")]] as const) {
      const label = document.createElement('label'), output = document.createElement('output'), input = document.createElement('input');
      input.type = 'range'; input.min = key === 'width' || key === 'height' ? '0.1' : '0'; input.max = '100'; input.step = '0.1'; input.setAttribute('aria-label', moteText("区域 {0} {1}", index + 1, title));
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
  try { const masks = masksForEditor(); if (masks.length >= 100) { feedback(moteText("最多可设置 100 个遮挡区域，请先移除不需要的区域。")); return; } masks.push({ ...maskPresets[button.dataset.mask!] }); writeMasks(masks); renderMaskEditor(); }
  catch (error) { revealField(byId('masks')); feedback((error as Error).message); }
});
byId('masks').addEventListener('change', renderMaskEditor);

const extensionChoices = [['.md', 'Markdown'], ['.txt', moteText("纯文本")], ['.json', 'JSON'], ['.csv', moteText("CSV 表格")], ['.ics', moteText("日历文件")]] as const;
function refreshExtensionChoices(): void {
  const selected = new Set(readInput('source-extensions').split(',').map(value => value.trim()));
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[data-source-extension]'))) input.checked = selected.has(input.value);
}
const extensionInput = byId<HTMLInputElement>('source-extensions');
const extensionBox = document.createElement('div'); extensionBox.className = 'extension-choices'; extensionBox.setAttribute('role', 'group'); extensionBox.setAttribute('aria-label', moteText("常用文件类型"));
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

let compressionRevision=0, compressionWidth=2560;
function compressionZoom():void {
  const zoom=readInput('compression-zoom');
  for(const id of ['compression-before','compression-after']){const img=byId<HTMLImageElement>(id);img.style.width=zoom==='fit'?'100%':`${compressionWidth*Number(zoom)}px`;img.style.maxWidth='none';}
}
async function refreshCompression():Promise<void>{
  const revision=++compressionRevision,quality=numberInput('compression-quality');
  byId('compression-quality-label').textContent=String(quality);byId('compression-stats').textContent=moteText("正在生成压缩预览…");byId<HTMLButtonElement>('compression-apply').disabled=true;
  try{const result=await desktopApi.compressionPreview(quality,numberInput('compression-side'));if(revision!==compressionRevision)return;
    byId<HTMLImageElement>('compression-before').src=result.original;byId<HTMLImageElement>('compression-after').src=result.compressed;compressionWidth=result.originalWidth;compressionZoom();
    const ratio=result.compressedBytes/result.originalBytes;
    byId('compression-stats').textContent=moteText("{0} × {1} → {2} × {3} · 边长缩放 {4}% · PNG {5} KB → JPEG {6} KB · 文件大小为原图的 {7}%（{8} {9}%）", result.originalWidth, result.originalHeight, result.width, result.height, (result.width/result.originalWidth*100).toFixed(1), (result.originalBytes/1024).toFixed(1), (result.compressedBytes/1024).toFixed(1), (ratio*100).toFixed(1), ratio<=1?moteText("减少"):moteText("增加"), (Math.abs(1-ratio)*100).toFixed(1));
    byId<HTMLButtonElement>('compression-apply').disabled=false;
  }catch(error){if(revision===compressionRevision)byId('compression-stats').textContent=error instanceof Error?error.message:moteText("预览失败，请调整参数重试");}
}
let compressionTimer:ReturnType<typeof setTimeout>|undefined;
for(const id of ['compression-quality','compression-side'])byId(id).addEventListener('input',()=>{clearTimeout(compressionTimer);compressionRevision++;byId<HTMLButtonElement>('compression-apply').disabled=true;compressionTimer=setTimeout(()=>void refreshCompression(),180);});
byId('compression-zoom').addEventListener('change',compressionZoom);
for(const [source,target] of [['compression-before-pane','compression-after-pane'],['compression-after-pane','compression-before-pane']])byId(source).addEventListener('scroll',()=>{const a=byId(source),b=byId(target);if(b.scrollLeft!==a.scrollLeft)b.scrollLeft=a.scrollLeft;if(b.scrollTop!==a.scrollTop)b.scrollTop=a.scrollTop;});
byId('compression-apply').addEventListener('click',()=>{const quality=readInput('compression-quality'),side=readInput('compression-side');showPage('capture');byId<HTMLInputElement>('jpeg-quality').value=quality;byId<HTMLInputElement>('capture-max-side').value=side;markSettingsDirty();feedback(moteText("压缩参数已带回设置，请点击保存后应用。"),true);});

async function loadStorageStatistics(): Promise<void> {
 const target=byId('storage-statistics');target.textContent=moteText("正在读取…");
 try {const report=await desktopApi.storageStatistics();target.replaceChildren();
 const total=document.createElement('h2');total.textContent=moteText("存储空间")+': '+(report.bytes/1048576).toFixed(2)+' MiB · '+report.files+' '+moteText("文件");target.append(total);
 if(report.skipped){const warning=document.createElement('p');warning.textContent=moteText("部分文件无法读取，统计可能不完整。");target.append(warning);}
 for(const [title,rows] of [[moteText("按文件类型"),report.types],[moteText("按日期"),report.days]] as const){const section=document.createElement('section');section.className='panel';const heading=document.createElement('h2');heading.textContent=title;section.append(heading);const max=Math.max(1,...rows.map(r=>r.bytes));
 for(const row of rows){const line=document.createElement('div');line.className='storage-bar';const label=document.createElement('span');label.textContent=row.key;const bar=document.createElement('meter');bar.min=0;bar.max=max;bar.value=row.bytes;const value=document.createElement('span');value.textContent=(row.bytes/1048576).toFixed(2)+' MiB';line.append(label,bar,value);section.append(line);}target.append(section);}
 }catch{target.textContent=moteText("统计读取失败，请重试。");}
}
byId('storage-refresh').addEventListener('click',()=>void loadStorageStatistics());

async function refreshPermissions(): Promise<void> {
  try {
    const status = await desktopApi.permissionStatus();
    for (const kind of ['screen', 'accessibility', 'calendar'] as const) {
      const element = byId('permission-' + kind), granted = status[kind] === 'granted';
      const unknown = ['unknown', 'unsupported'].includes(status[kind]);
      element.className = 'permission-badge ' + (granted ? 'granted' : unknown ? 'unknown' : 'denied');
      element.textContent = (granted ? '✓ ' : unknown ? '? ' : '! ') + (({granted: moteText("已授权"), denied: moteText("未授权"), 'not-determined': moteText("尚未授权"), unsupported: moteText("当前平台不支持"), unknown: moteText("无法确认，请检查系统设置")} as Record<string,string>)[status[kind]] ?? status[kind]);
    }
    setText('permission-identity', `${status.bundleId ?? 'unknown'}\n${status.appPath ?? ''}`);

  } catch { feedback(moteText("权限状态读取失败，请重试。")); }
}
byId('permissions-refresh').addEventListener('click', () => void refreshPermissions());
window.addEventListener('focus', () => { if (currentPage === 'permissions') void refreshPermissions(); });
for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-permission]'))) button.addEventListener('click', () => void perform(() => desktopApi.permissionSettings(button.dataset.permission as 'screen' | 'accessibility' | 'calendar' | 'files')));
byId('notification-collection').addEventListener('change', () => {
  if (!byId<HTMLInputElement>('notification-collection').checked) return;
  void desktopApi.permissionStatus().then(status => {
    if (status.accessibility !== 'granted') { byId<HTMLInputElement>('notification-collection').checked = false; window.alert(moteText("读取通知需要辅助功能权限，请先授权后再启用。")); showPage('permissions'); }
  }).catch(() => feedback(moteText("权限检查失败，请重试。")));
});

byId('review-refresh').addEventListener('click', async()=>{
 const items=await window.mote.reviewPending(),root=byId('review-pending');root.replaceChildren();
 for(const item of items){const row=document.createElement('div'),label=document.createElement('span'),button=document.createElement('button');const previewButton=document.createElement('button');previewButton.type='button';previewButton.textContent=moteText("查看原图");previewButton.onclick=async()=>{const img=document.createElement('img');img.alt=moteText("本机待复核截图");img.style.maxWidth='100%';img.src=await desktopApi.captureImage('local',item.id,false);row.append(img);previewButton.disabled=true;};label.textContent=`${item.capturedAt} · ${item.appName} · ${item.id}`;button.type='button';button.textContent=moteText("复核后允许上传此记录");button.onclick=async()=>{await window.mote.approveReview(item.id);row.remove();};const discard=document.createElement('button');discard.type='button';discard.textContent=moteText("丢弃，不上传");discard.onclick=async()=>{await desktopApi.rejectReview(item.id);row.remove();};row.append(label,previewButton,button,discard);root.append(row);}
 if(!items.length)root.textContent=moteText("没有待复核记录");
});
let askRun: import('./ask').AskRun | undefined;
let askConversation: import('./ask').AskConversation | undefined;
let askBusy = false, askGeneration = 0, askCursor: string | undefined;
let askPendingInput: {id: string; question: string; conversationId?: string} | undefined;
let askTimer: ReturnType<typeof setTimeout> | undefined;
const askCall = <T>(command: import('./ask').AskCommand, input?: Parameters<typeof desktopApi.ask>[1]) => desktopApi.ask(command, input) as Promise<T>;
function askControls(): void {
  const running = askRun?.status === 'running';
  byId<HTMLButtonElement>('ask-send').disabled = askBusy || running;
  byId<HTMLButtonElement>('ask-new').disabled = askBusy || running;
  byId<HTMLButtonElement>('ask-login').disabled = askBusy;
  byId<HTMLButtonElement>('ask-logout').disabled = askBusy;
  byId('ask-stop').hidden = !running;
  byId<HTMLButtonElement>('ask-turns-more').disabled = askBusy || running;
  byId('ask-turns-more').hidden = !askConversation?.nextCursor;
  for (const button of Array.from(byId('ask-history').querySelectorAll('button'))) button.disabled = askBusy || running;
}
function renderAsk(): void {
  const messages = byId('ask-messages'); messages.replaceChildren();
  for (const turn of askConversation?.turns ?? []) {
    const article = document.createElement('article'), question = document.createElement('h3');
    question.textContent = turn.question;
    const openEvidence = (id: string) => void askAction(() => desktopApi.openCentral('ask', id));
    article.append(question, renderAskAnswer(document, turn.result?.answer ?? turn.error?.message ?? moteText('回答未完成'), turn.result?.citations ?? [], openEvidence));
    for (const citation of turn.result?.citations ?? []) article.append(renderAskCitation(document, citation, openEvidence));
    messages.append(article);
  }
  if (askConversation?.turns.some(turn => turn.result?.citations?.length)) {
    const hint = document.createElement('p'); hint.className = 'helper';
    hint.textContent = moteText('中央仓库将在浏览器中打开，并接续客户端的登录。');
    messages.append(hint);
  }
  const last = askRun?.events?.at(-1);
  setText('ask-progress', !askRun ? '' : askRun.status === 'running' ? last?.message ?? (last?.tool ? `${moteText('正在读取资料')} · ${last.tool}` : moteText('中央节点正在回答…')) : askRun.status === 'cancelled' ? moteText('已停止回答') : askRun.status === 'failed' ? askRun.error?.message ?? moteText('回答未完成') : moteText('回答已完成'));
  askControls();
}
async function loadAskConversation(id: string): Promise<void> {
  const generation = askGeneration;
  const conversation = await askCall<import('./ask').AskConversation>('conversation', {id});
  if (generation !== askGeneration) return;
  askConversation = conversation; renderAsk();
}
async function olderAskTurns(): Promise<void> {
  const current = askConversation, generation = askGeneration;
  if (!current?.nextCursor) return;
  const page = await askCall<import('./ask').AskConversation>('conversation', {id: current.id, cursor: current.nextCursor});
  if (generation !== askGeneration || askConversation !== current) return;
  askConversation = prependConversationTurns(current, page); renderAsk();
}
async function askHistory(append = false): Promise<void> {
  const generation = askGeneration;
  const page = await askCall<{items: {id: string; title: string}[]; nextCursor?: string}>('history', append && askCursor ? {cursor: askCursor} : undefined);
  if (generation !== askGeneration) return;
  const history = byId('ask-history'); if (!append) history.replaceChildren();
  for (const item of page.items) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = item.title;
    button.addEventListener('click', () => { if (!askBusy && askRun?.status !== 'running') void askAction(async () => { askConversation = undefined; askRun = undefined; renderAsk(); await loadAskConversation(item.id); }); });
    history.append(button);
  }
  askCursor = page.nextCursor; byId('ask-more').hidden = !askCursor; askControls();
}
async function askAction(action: () => Promise<void>): Promise<void> {
  if (askBusy) return; askBusy = true; askControls(); setText('ask-error', '');
  try { await action(); } catch (error) { setText('ask-error', error instanceof Error ? error.message : moteText('请求失败，请重试')); }
  finally { askBusy = false; askControls(); }
}
async function refreshAsk(): Promise<void> {
  const connected = askConnectionState();
  if (!connected) {
    clearTimeout(askTimer);
    setText('ask-login-status', ''); setText('ask-error', '');
    return;
  }
  await askAction(async () => {
    setText('ask-login-status', moteText('正在连接中央节点…'));
    try { await askHistory(); } catch (error) { setText('ask-login-status', moteText('请求失败，请重试')); throw error; }
    setText('ask-login-status', moteText('已登录 · {0}', currentStatus.config.serverUrl));
    const page = await askCall<{items: import('./ask').AskRun[]}>('runs');
    askRun = page.items.find(item => item.status === 'running') ?? askRun;
    if (askRun?.conversationId) await loadAskConversation(askRun.conversationId);
    else if (askConversation) await loadAskConversation(askConversation.id);
    renderAsk(); if (askRun?.status === 'running') scheduleAskPoll();
  });
}
function askConnectionState(): boolean {
  const connected = Boolean(currentStatus?.config.serverUrl);
  byId('ask-disconnected').hidden = connected;
  byId('ask-workspace').hidden = !connected;
  byId('node-login-panel').hidden = !connected || currentStatus.config.tokenConfigured;
  byId('ask-logout').hidden = !connected || !currentStatus.config.tokenConfigured;
  byId('ask-new').hidden = !connected;
  return connected;
}
function scheduleAskPoll(): void {
  clearTimeout(askTimer); const generation = askGeneration;
  askTimer = setTimeout(async () => {
    if (currentPage !== 'ask' || !askRun || generation !== askGeneration) return;
    try {
      const run = await askCall<import('./ask').AskRun>('run', {id: askRun.id});
      if (generation !== askGeneration) return; askRun = run;
      if (run.status !== 'running' && run.conversationId) {
        const conversation = await askCall<import('./ask').AskConversation>('conversation', {id: run.conversationId});
        if (generation !== askGeneration) return; askConversation = conversation; await askHistory();
      }
      setText('ask-error', ''); renderAsk();
      if (run.status === 'running') scheduleAskPoll();
    } catch (error) { if (generation !== askGeneration) return; setText('ask-error', `${error instanceof Error ? error.message : ''} · ${moteText('请刷新检查结果，避免重复发送。')}`); if (askRun?.status === 'running') scheduleAskPoll(); }
  }, 1000);
}
byId('ask-form').addEventListener('submit', event => {
  event.preventDefault(); if (askBusy || askRun?.status === 'running') return;
  const question = readInput('ask-question').trim(); if (!question) return;
  void askAction(async () => {
    const input = askPendingInput?.question === question && askPendingInput.conversationId === askConversation?.id ? askPendingInput : {id: crypto.randomUUID(), question, ...(askConversation ? {conversationId: askConversation.id} : {})};
    askPendingInput = input;
    try { askRun = await askCall('start', input); }
    catch { askRun = await askCall('start', input); } // Same admission ID after an ambiguous network response.
    askPendingInput = undefined; byId<HTMLTextAreaElement>('ask-question').value = ''; renderAsk(); scheduleAskPoll();
  });
});
byId('ask-refresh').addEventListener('click', () => void refreshAsk());
byId('ask-more').addEventListener('click', () => void askAction(() => askHistory(true)));
byId('ask-turns-more').addEventListener('click', () => void askAction(olderAskTurns));
byId('ask-stop').addEventListener('click', () => void askAction(async () => { if (askRun) { askRun = await askCall('cancel', {id: askRun.id}); renderAsk(); scheduleAskPoll(); } }));
byId('ask-new').addEventListener('click', () => { if (askBusy || askRun?.status === 'running') return; askGeneration++; clearTimeout(askTimer); askRun = undefined; askConversation = undefined; renderAsk(); });
byId('ask-login').addEventListener('click', () => { const token = readInput('ask-token'); byId<HTMLInputElement>('ask-token').value = ''; void askAction(async () => { setText('ask-login-status', moteText('正在连接中央节点…')); try { await askCall('login', {token,durationMs:Number(readInput('ask-lifetime'))}); } catch (error) { setText('ask-login-status', moteText('请先登录中央节点，各页面会共用这次登录。')); throw error; } setText('ask-login-status', moteText('已登录 · {0}', currentStatus.config.serverUrl)); askGeneration++; askRun = undefined; askConversation = undefined; renderAsk(); await askHistory(); }); });
byId('ask-browser-login').addEventListener('click',()=>void askAction(async()=>{await askCall('login-browser',{durationMs:Number(readInput('ask-lifetime'))});await askHistory();setText('ask-login-status',moteText('已登录 · {0}',currentStatus.config.serverUrl));}));
byId('ask-logout').addEventListener('click', () => void askAction(async () => { await askCall('logout'); setText('ask-login-status', moteText('已退出中央登录')); askGeneration++; clearTimeout(askTimer); askRun = undefined; askConversation = undefined; byId('ask-history').replaceChildren(); renderAsk(); }));

byId('chrome-setup').addEventListener('click',()=>void perform(async()=>{const result=await desktopApi.setupChromeCapture();byId('chrome-setup-result').textContent=moteText('扩展目录：{0}；扩展 ID：{1}',result.extensionDirectory,result.extensionId);feedback(moteText('本机桥接已准备。请在 Chrome 扩展程序中加载该目录，并在扩展中授权所选站点。'),true);}));
