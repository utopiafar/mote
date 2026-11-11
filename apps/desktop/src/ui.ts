import {createUpdateInstallUi} from './update-install-ui';
import {renderStorageLocation} from './storage-location-ui';
import {appendDiagnostic,renderReadableFailure} from './ui-diagnostic';
import {sourceSelectionResult} from './source-selection-result';
import {keepLanguageAskDraft,takeLanguageAskDraft,dropLanguageAskDraft} from './language-draft';
import {AskDraftScopes} from './ask-draft-scope';
import {createWorkPendingUi} from './work-pending-ui';
import {queueImportPresentation} from './queue-import-presentation';
import {createChromeCaptureUi} from './chrome-capture-ui';
import {createCaptureContextUi} from './capture-context-ui';
import {renderSettingsWorkspace,beginDiagnosticFactsRefresh} from './settings-workspace';
import {createBackupOperationUi} from './backup-operation-ui';
import {createMemoryTopicsUi} from './memory-topics-ui';
import {desktopAppearance} from './appearance';
import {createContentLibraryUi} from './content-library-ui';
import {createSourceWorkspaceUi} from './source-workspace-ui';
import {normalizeSourceOptions} from './source-types';
import {createWorkbenchUi, type RecentConversation} from './workbench-ui';
import {createSyncHistoryUi} from './sync-history-ui';
import {createDesktopPresentation} from './presentation';
import {createWorkActivityUi} from './work-activity-ui';
import {createPermissionsUi} from './permissions-ui';
import {createCaptureSyncUi} from './capture-sync-ui';
import {nativeStatusSummary} from './native-status';
import { renderAskAnswer, renderAskCitation, renderAskScope } from './ask-presentation';
import {currentTurnCites,prependConversationTurns} from './ask-conversation';
import { moteText, getLocale } from '@mote/shared/i18n';
import {builtinUiRules} from '@mote/shared';
import {createAppCaptureUi,describeCaptureSelection} from './app-capture-ui';
import {normalizeAppCollectionRules} from './app-collection';
import { DesktopNavigation, desktopPages, needsCollectionSetup, type DesktopPage } from './navigation';
const desktopApi = window.mote;
const captureContextUi=createCaptureContextUi(desktopApi,document,markSettingsDirty);
document.getElementById('ui-page-builtins')!.addEventListener('click',()=>{byId<HTMLTextAreaElement>('ui-page-rules').value=JSON.stringify(builtinUiRules,null,2);appCaptureUi.refreshRules();markSettingsDirty();});
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let currentStatus: import('./contracts').Status;
let initialized = false;
let busy = false;
let statusReadEpoch = 0;
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
let skipNextAskRefresh=false;
let askReadingOnLeave:AskReadingPosition|undefined;
const settingsPages = new Set<Page>(['screen','connection', 'sync', 'capture', 'privacy', 'developer','storage','chrome']);
const memoryTopicsUi=createMemoryTopicsUi(desktopApi,document.getElementById('memory-topics-dialog') as HTMLDialogElement);
const workbenchUi=createWorkbenchUi(desktopApi,{question:openWorkbenchQuestion,conversation:openWorkbenchConversation,content:item=>void libraryUi.open(item),contents:()=>showPage('records')});
let contentOrigin:Page='records';
const libraryUi=createContentLibraryUi(desktopApi,()=>memoryTopicsUi.open(),(hasContent,rows,archiveDenied)=>{workbenchUi.setArchiveAuthorizationDenied(archiveDenied);workbenchUi.setHasContent(hasContent);workbenchUi.setHomeRows(rows);},{
  open(){contentOrigin=currentPage;const title=document.querySelector<HTMLElement>(`[data-page="${currentPage}"] [data-page-title]`)?.textContent?.trim()??moteText('内容');byId('content-detail-close').textContent='← '+title;showPage('content-reader');},
  close(){if(currentPage==='content-reader')showPage(contentOrigin,true,false,true,true);},
});
function refreshContent():Promise<void>{return libraryUi.refresh();}
const sourceWorkspace=createSourceWorkspaceUi(desktopApi,{openDetail:()=>showPage('source-detail'),edit:id=>void editSource(id),toggle:row=>sourceAction(()=>desktopApi.updateSource(row.source.id,{...row.source,enabled:!row.source.enabled})),content:()=>{byId<HTMLSelectElement>('content-scope').value='local';showPage('records');},read:item=>libraryUi.open(item)});
const workPendingUi=createWorkPendingUi(desktopApi,item=>void libraryUi.open(item),()=>showPage('uploads'));
const chromeCaptureUi=createChromeCaptureUi(desktopApi);
const syncHistoryUi = createSyncHistoryUi(desktopApi, page => showPage(page));
const workActivityUi=createWorkActivityUi(desktopApi,page=>showPage(page));
const permissionsUi=createPermissionsUi(desktopApi);
const captureSyncUi=createCaptureSyncUi(desktopApi,{
  start:()=>byId('start').click(),
  stop:()=>void desktopApi.stop().then(render).catch(error=>feedback((error as Error).message)),
  addSource:()=>byId('source-add').click(),
  openChrome:()=>showPage('chrome'),
  openCalendar:()=>byId('source-calendar-choice-open').click(),
  openSources:()=>showPage('sources'),
  sendNow:()=>void perform(async()=>{render(await desktopApi.retry());feedback(currentStatus.sync.message,currentStatus.sync.state!=='error'&&currentStatus.sync.state!=='unconfigured');}),
  setPaused:paused=>void perform(async()=>{render(await desktopApi.setSyncPaused(paused));}),
  failure:message=>feedback(message),
});
const presentation=createDesktopPresentation({root:document.body,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:byId('main-content'),navigate:page=>{showPage(page);}},desktopAppearance);
window.addEventListener('beforeunload',()=>{workActivityUi.dispose();permissionsUi.dispose();presentation.dispose();},{once:true});
let setupReviewed = false;
try { setupReviewed = localStorage.getItem('mote-desktop-collection-reviewed') === '1'; } catch { /* Collection remains usable without local storage. */ }

function showPage(page: Page, focus = true, preserveSettingsDraft = false, refreshAskOnEntry = true, preserveContentPosition = false): boolean {
  if(page==='compression'&&currentPage==='capture')preserveSettingsDraft=true;
  if (page === 'notes' && !quickNote && desktopApi.openQuickNote) { void desktopApi.openQuickNote(); return false; }
  if (quickNote && page !== 'notes') return false;
  if(page!==currentPage&&currentPage==='preferences'&&document.querySelector<HTMLElement>('[data-page=preferences]')?.dataset.dirty==='true'){if(!window.confirm(moteText('有未保存的修改。离开并丢弃修改？')))return false;byId('preferences-reset').click();}
  if (!navigation.navigate(page, () => preserveSettingsDraft || !settingsDirty || !settingsPages.has(currentPage) || window.confirm(moteText("有未保存的修改。离开并丢弃修改？")))) return false;
  if(currentPage==='ask'&&page!=='ask')askReadingOnLeave=captureAskReading();
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
  if(currentPage==='chrome'&&page!=='chrome')chromeCaptureUi.hide();
  if(currentPage==='source-editor'&&page!=='source-editor')invalidateSourceEditor();
  if (currentPage === 'uploads' && page !== 'uploads') syncHistoryUi.hide();
  if (currentPage === 'work' && page !== 'work') {workActivityUi.hide();workPendingUi.hide();}
  if (currentPage === 'permissions' && page !== 'permissions') permissionsUi.hide();
  if (currentPage === 'content-reader' && page !== 'content-reader') libraryUi.close(false);
  workbenchUi.leave(page);
  currentPage = page;document.body.dataset.workspacePage=page;
  if(initialized) renderOperations(currentStatus.operations??[]);
  if(page==='chrome')chromeCaptureUi.refresh();
  if (page === 'uploads') syncHistoryUi.show();
  if (page === 'work') {workActivityUi.show();workPendingUi.show();}
  const selected = navigation.section;
  presentation.update({section:selected});
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-page]'))) element.hidden = element.dataset.page !== page;
  for (const button of Array.from(document.querySelectorAll<HTMLElement>('aside [data-nav]'))) {
    const active = button.dataset.nav === selected;
    button.classList.toggle('selected', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  const heading = (target: Page) => document.querySelector<HTMLElement>(`[data-page="${target}"] [data-page-title]`)?.textContent?.trim() ?? '';
  const title = heading(page), sectionTitle = heading(page==='connection'&&navigation.backTarget==='ask'?'ask':selected);
  byId('workspace-location').textContent = page==='ask'?moteText('问一问'):page==='content-reader'?moteText('内容详情'):page === selected ? title : `${sectionTitle} / ${title}`;
  byId('workspace-back').hidden = !navigation.canGoBack||['content-reader','source-detail','source-editor','source-connect'].includes(page);
  byId('source-feedback').hidden=!['sources','source-detail','source-editor','source-connect'].includes(page)||!byId('source-feedback').textContent;
  updateNoteAction();
  byId('workspace-back').setAttribute('aria-label', moteText("返回{0}", heading(navigation.backTarget)));
  updateSettingsHint();
  if (focus) document.querySelector<HTMLElement>(`[data-page="${page}"] [data-page-title]`)?.focus({ preventScroll: true });
  window.scrollTo({ top: pageScroll.get(page) || 0, behavior: 'instant' });
  if (page === 'compression') {for(const [id,value] of [['compression-quality',currentStatus.config.jpegQuality],['compression-side',currentStatus.config.captureMaxSide]] as const){const select=byId<HTMLSelectElement>(id);if(!Array.from(select.options).some(option=>option.value===String(value)))select.add(new Option(String(value),String(value)));select.value=String(value);}invalidateCompression();}
  if (page === 'ask' && refreshAskOnEntry) {if(skipNextAskRefresh){skipNextAskRefresh=false;if(askConversation&&askReadingOnLeave)restoreAskReadingPosition(askReadingOnLeave,askConversation,askGeneration);}else void refreshAsk();}
  if (page === 'capture-sync') captureSyncUi.show();
  if (page === 'permissions') permissionsUi.show();
  if (page === 'privacy'||page==='screen') void appCaptureUi.refreshApplications();
  if (page === 'statistics') void loadStorageStatistics();
  if (page === 'records' && !preserveContentPosition) { void loadRecords(); void refreshContent(); }
  if (page === 'overview' && initialized && !preserveContentPosition) { void libraryUi.refreshHome(); void refreshSources(); void workbenchUi.refresh(); }
  if (page === 'sources') void refreshSources();
  if (page === 'meeting') void refreshMeeting();
  if (page === 'overview' && initialized) { const epoch=statusReadEpoch; void desktopApi.status().then(status=>{if(epoch===statusReadEpoch&&!busy)render(status);}).catch(() => {if(epoch===statusReadEpoch&&!busy)feedback(moteText("状态读取失败。"));}); }
  return true;
}
for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-nav]:not([data-presentation-nav])'))) button.addEventListener('click', () => {
  const page = button.dataset.nav as Page;
  if (pageNames.includes(page)) showPage(page);
});
byId('connection-central-content').addEventListener('click',()=>{byId<HTMLSelectElement>('content-scope').value='received';showPage('records');});
byId('settings-central-models').addEventListener('click',()=>void perform(()=>desktopApi.openCentral('models')));
byId('chrome-back').addEventListener('click',()=>showPage(navigation.backTarget));
byId('workspace-back').addEventListener('click', () => showPage(navigation.backTarget));
function updateNoteAction(): void {
  const action = byId('note-action');
  action.classList.add('secondary');
  action.hidden = quickNote;
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
  else if(action==='folder'||action==='file')void beginSourceSelection(action==='folder'?'directory':'files',Boolean(button.closest('#home-onboarding')));
  else if(action==='lark'){
    if(!currentStatus?.config.serverUrl){showPage('connection');feedback(moteText('先连接你的中央，即可打开中央仓库。'));return;}
    void perform(()=>desktopApi.openCentral('lark'));
  }
});
function reviewCollectionSetup(): void {
  setupReviewed = true;
  try { localStorage.setItem('mote-desktop-collection-reviewed', '1'); } catch { /* This preference is not required for capture. */ }
  if (currentStatus) render(currentStatus);
}
byId('setup-primary').addEventListener('click', () => {if(showPage('screen')){reviewCollectionSetup();byId('default-collection').closest<HTMLDetailsElement>('details')!.open=true;byId('default-collection').querySelector<HTMLInputElement>('input')?.focus();}});
byId('setup-current').addEventListener('click', () => { reviewCollectionSetup(); byId('start').focus(); });
byId('pause-sending').addEventListener('click',()=>void perform(async()=>{ const updated=await desktopApi.setSyncPaused(!currentStatus.config.syncPaused); render(updated); }));
function updateSettingsHint(): void {
  byId('settings-save-bar').hidden = currentPage==='sync'||!settingsPages.has(currentPage)||currentPage==='chrome'||currentPage==='developer'||currentPage==='screen'&&!settingsDirty;
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
function markSettingsDirty(): void { settingsDirty = true;byId('capture-default-summary').textContent=describeCaptureSelection(readChannels(byId('default-collection')));updateSettingsHint(); }
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
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!quickNote&&!document.querySelector('dialog[open]')){event.preventDefault();if(showPage('records'))byId('content-search').focus();}
  if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); showPage('settings'); }
  if(event.key==='Escape'&&currentPage==='content-reader'){event.preventDefault();libraryUi.close();return;}
  if (event.key === 'Escape' && document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && currentPage === 'records' && !byId('record-detail').hidden) closeRecordDetail();
  else if (event.key === 'Escape' && navigation.canGoBack) showPage(navigation.backTarget);
});
desktopApi.onNavigate?.(page => {
  if(page==='capture-start'){if(showPage('screen',true,true))byId('start').click();}
  else if (page === 'central') openCentral('overview');
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
      caption.append(title, time, state); if(item.hasImage)card.append(image);card.append(caption); card.addEventListener('click', () => {
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
  captureContextUi.reset();
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
    idle: config.idlePauseSeconds,
    'sync-interval': config.syncIntervalMinutes, 'sync-batch': config.syncBatchSize,
    masks: JSON.stringify(config.masks, null, 2),
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
  byId<HTMLInputElement>('token').placeholder = config.tokenConfigured ? moteText("已安全保存；留空保留已有令牌") : moteText("输入中央访问令牌");
  byId<HTMLSelectElement>('sync-mode').value=config.syncMode;
  byId<HTMLInputElement>('confirm-local-backlog').checked = false;
  refreshPresets(); updateSyncOptions(); renderMaskEditor(); updateLocalBacklog();
  updateTokenField();
  settingsDirty = false; updateSettingsHint();chromeCaptureUi.refresh();
}
function renderStorage(): void { renderStorageLocation(document,currentStatus,captureStorageDirectory); }
byId('storage-restart').addEventListener('click', () => void desktopApi.restartForStorageRecovery());
byId('capture-directory-choose').addEventListener('click', () => void perform(async () => {
  const revision = pageRevision;
  const result = await desktopApi.chooseCaptureDirectory();
  if (revision === pageRevision && !result.canceled && result.directory) { captureStorageDirectory = result.directory; markSettingsDirty(); renderStorage(); }
}));
byId('capture-directory-default').addEventListener('click', () => { captureStorageDirectory = ''; markSettingsDirty(); renderStorage(); });
byId('capture-directory-open').addEventListener('click', () => void perform(() => desktopApi.openCaptureDirectory()));
let connectionPreview: import('./connection').ConnectionPreview | undefined;
const backupOperationUi=createBackupOperationUi();
function renderOperations(jobs:NonNullable<import('./contracts').Status['operations']>):void {
  backupOperationUi.update(jobs);
  // Completed work belongs to the page where it began; active work and failures remain global.
  const operations=jobs.filter(job=>job.state!=='completed'||currentPage!=='overview'&&job.startedAt>=pageEnteredAt);
  byId('background-progress').hidden = !operations.length;
  byId('background-progress').textContent = operations.map(job => job.state === 'running' ? `${job.message}${job.total !== undefined ? ` · ${job.completed ?? 0}/${job.total}` : ''}${moteText(" · 已用 {0} 秒", Math.floor((Date.now() - job.startedAt) / 1000))}` : job.state === 'failed' ? moteText('操作未完成，请检查权限与配置后重试') : moteText('处理结束')).join('；');
}
function render(status: import('./contracts').Status): void {
  syncHistoryUi.update(status);libraryUi.update(status);memoryTopicsUi.update(status);workActivityUi.update(status);
  if(currentStatus&&(currentStatus.authorizationGeneration!==status.authorizationGeneration||currentStatus.config.serverUrl!==status.config.serverUrl||currentStatus.config.tokenConfigured!==status.config.tokenConfigured||currentStatus.config.authSignedOut!==status.config.authSignedOut||currentStatus.config.authExpiresAt!==status.config.authExpiresAt)){
    sourceWorkspace.clear();localSourceRows=[];invalidateSourceEditor();byId<HTMLTextAreaElement>('source-initial-description').value='';byId<HTMLTextAreaElement>('source-initial-description').disabled=true;sourceReadGeneration++;recordsRevision++;closeRecordDetail();byId('records-grid').replaceChildren();byId('record-detail-title').textContent='';byId('record-detail-meta').textContent='';byId('record-detail-text').textContent='';
    const retained=askDraftScopes.switch(currentStatus,status,snapshotAskDraft());
    askGeneration++;clearTimeout(askTimer);askConversation=undefined;askCursor=undefined;skipNextAskRefresh=false;byId('ask-more').hidden=true;byId('ask-history').replaceChildren();restoreScopedAskDraft(retained);renderAsk();setText('ask-login-status','');setText('ask-error','');
  }
  currentStatus = status;workPendingUi.update(status);chromeCaptureUi.update(status);captureContextUi.update(status);renderSettingsWorkspace(status);sourceWorkspace.status(status);captureSyncUi.update(status,localSourceRows);renderStorage();appCaptureUi.setStatus(status);if(!quickNote)workbenchUi.update(status);
  askConnectionState();
  maybeRestoreAskConversation();
  updateTokenField();
  renderOperations(status.operations??[]);
  byId('connection-device').textContent = moteText("设备：{0} · ID {1}。迁移已有设备时，请在中央邀请中选择此 ID。", status.config.deviceName, status.config.deviceId);
  byId('environment').textContent = status.environment ? moteText("环境：{0}{1} · {2}", status.environment.profile, status.environment.defaultProfile ? moteText("（原日常目录）") : moteText(" · 独立数据"), status.environment.dataDirectory) : '';
  const names = { stopped: moteText("采集已停止"), capturing: moteText("正在采集"), paused: moteText("采集已暂停"), permission_required: moteText("需要屏幕录制权限"), error: moteText("采集已停止 · 需要处理") };
  setText('state', names[status.state]);
  const hasCentralConnection = Boolean(status.config.serverUrl && status.config.tokenConfigured);
  const centralState = !hasCentralConnection ? 'unconfigured' : status.sync.state === 'uploading' ? 'syncing' : status.sync.state === 'error' ? 'error' : 'connected';
  const centralTitle = !hasCentralConnection
    ? moteText("未连接中央")
    : centralState === 'syncing'
      ? moteText("正在同步中央")
      : centralState === 'error'
        ? moteText("连接需要处理")
        : moteText("已连接中央");
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
  setText('pause-sending',status.config.syncPaused?moteText('恢复全部发送'):moteText('暂停全部发送'));
  byId<HTMLButtonElement>('retry').disabled=busy||Boolean(status.config.syncPaused);
  updateNoteAction();
  byId('central-status').className = `central-status ${centralState}`;
  byId('central-status-icon').className = `central-status-icon ${centralState}`;
  setText('central-status-title', centralTitle);
  setText('central-status-message', centralMessage);
  setText('central-status-origin', hasCentralConnection ? `${status.config.deviceName} · ${status.config.serverUrl}` : moteText("连接后，采集记录会按同步设置发送"));
  setText('central-status-action', hasCentralConnection ? moteText("连接详情") : moteText("连接节点"));
  byId('settings-connection-summary').textContent = status.config.tokenConfigured ? moteText("{0} · 已保存连接", status.config.deviceName) : moteText("连接你的中央，让记录开始同步");
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
  byId<HTMLButtonElement>('retry').disabled = busy || Boolean(status.config.syncPaused) || (status.facts ? !status.facts.sync.allowedActions.includes('retry_sync') : status.sync.state === 'uploading' || status.sync.state === 'unconfigured');
  byId('retry').textContent = status.sync.state === 'error' ? moteText("重试上传") : moteText("立即发送");
  fields.disabled = busy;for(const control of Array.from(document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('[form=settings]')))control.disabled=busy;
  byId<HTMLInputElement>('device-name').disabled = busy;
  for (const id of ['connection-preview', 'connection-json', 'connection-qr', 'connection-test']) byId<HTMLButtonElement>(id).disabled = busy;
  byId<HTMLButtonElement>('connection-cancel').disabled = busy;
  byId<HTMLTextAreaElement>('connection-input').disabled = busy;
  byId<HTMLInputElement>('connection-confirm-origin').disabled = busy;
  byId<HTMLButtonElement>('connection-connect').disabled = busy || !connectionPreview || Date.parse(connectionPreview.expiresAt) <= Date.now() || !byId<HTMLInputElement>('connection-confirm-origin').checked;
  updateSettingsHint();
  const syncNames = { unconfigured: moteText("仅保存在本机"), idle: moteText("已同步"), waiting: moteText("等待同步条件"), uploading: moteText("正在上传"), error: moteText("上传需要处理"), manual: moteText("等待手动上传") };
  const syncStateLabel = status.sync.state === 'idle' && status.sync.pendingRecords > 0 ? moteText("记录已保存 · 准备上传") : syncNames[status.sync.state];
  setText('sync-state',status.config.syncPaused?moteText('发送已暂停'):syncStateLabel);
  setText('sync-policy-label', syncModeLabels[status.sync.mode]);
  setText('upload-speed', status.sync.state === 'uploading' ? `${((status.sync.uploadBytesPerSecond ?? 0) / 1024).toFixed(1)} KiB/s` : '0 KiB/s');
  setText('sync-upload-speed', byId('upload-speed').textContent ?? '0 KiB/s');
  setText('sync-message', moteText("{0} · 共 {1} 条待传（含本地来源）", status.sync.message, status.sync.pendingRecords.toLocaleString(getLocale())) + (status.facts ? `\n${nativeStatusSummary(status.facts)}` : ''));
  updateLocalBacklog();
  const uploadInfo = [];
  if (status.sync.nextUploadAt) uploadInfo.push(`${status.sync.state === 'error' ? moteText("计划重试") : moteText("计划上传")} ${new Date(status.sync.nextUploadAt).toLocaleString(getLocale(), { hour12: false })}`);
  if (status.lastUploadError) uploadInfo.push(status.lastUploadError);
  if (status.lastUploadAt) uploadInfo.push(moteText("最近上传 {0}", new Date(status.lastUploadAt).toLocaleTimeString(getLocale(), { hour12: false })));
  setText('upload-info', uploadInfo.join(' · '));
  byId('token-hint').textContent = status.credentialStorage === 'json'
    ? moteText("开发环境使用权限受限的本机 JSON 保存凭据，不使用系统密钥存储。")
    : status.encryptedTokenStorage ? moteText("使用系统密钥存储加密；不会展示已有令牌。") : moteText("系统加密存储不可用，无法保存令牌。");

  byId<HTMLButtonElement>('diagnostics-sample').disabled=busy||!status.diagnostics?.enabled;
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
  if (!initialized) { fillConfig(status.config); initialized = true;void refreshContent();restoreLanguageAskDraft(); }
}
async function perform(action: () => Promise<unknown>,localFailure=false): Promise<void> {
  if (busy) return;
  statusReadEpoch++; busy = true; if(!localFailure)feedback(moteText("正在处理，请稍候…")); byId('feedback').setAttribute('aria-busy', 'true'); if (currentStatus) render(currentStatus);
  try { await action(); } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : moteText("操作失败");
    if(!localFailure)renderReadableFailure(byId('feedback'),moteText('操作未完成，请检查权限与配置后重试'),message);
  } finally {
    // Read the operation's settled state before enabling a subsequent mutation.
    let settled: import('./contracts').Status | undefined;
    try { settled = await desktopApi.status(); } catch { /* Keep the last confirmed status on a read failure. */ }
    busy = false; byId('feedback').setAttribute('aria-busy', 'false');
    if (byId('feedback').textContent === moteText("正在处理，请稍候…")) feedback('');
    statusReadEpoch++;
    if (settled ?? currentStatus) render(settled ?? currentStatus);
  }
}
byId('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !initialized) return;
  for (const element of Array.from(settingsForm.elements)) {
    if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && !element.checkValidity()) {
      revealField(element); element.reportValidity(); return;
    }
  }
  if(captureStorageDirectory!==(currentStatus.config.captureStorageDirectory||'')&&!window.confirm(moteText('复制并验证本机待发送内容后切换保存位置。\n从：{0}\n到：{1}',currentStatus.storage?.directory||'',captureStorageDirectory||currentStatus.storage?.defaultDirectory||'')))return;
  let masks: import('./contracts').Rectangle[];
  let appCollectionRules: Record<string, import('./contracts').CollectionMode>;
  try { masks = masksForEditor(); }
  catch { revealField(byId('masks')); feedback(moteText("遮挡区域格式无效，或超出了屏幕范围。请检查高级 JSON。")); return; }
  try { appCollectionRules = appCaptureUi.readRules(); }
  catch (error) { feedback((error as Error).message); return; }
  void perform(async () => {
    const token = readInput('token').trim();
    settingsApplying = true; wasRunningBeforeSave = currentStatus.running; render(currentStatus);
    const captureSave=captureContextUi.prepareSave();
    try {
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
    render(updated); await captureSave.persist(); fillConfig(updated.config); feedback(updated.running ? moteText("设置已保存并立即生效，采集已恢复。") : moteText("设置已保存并立即生效，采集保持停止。"), true);
    } finally {captureSave.release();}
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
  if (settingsDirty) { feedback(moteText("请先保存或还原修改，再开始采集。")); return; }
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
byId('restore-pause').addEventListener('click',()=>void perform(async()=>render(await desktopApi.setSyncPaused(true))));
byId('export').addEventListener('click',()=>void perform(async()=>{
  showPage('export-result');
  const visit=backupOperationUi.begin('export',moteText('正在处理，请稍候…'),currentStatus.operations);
  try {const result=await desktopApi.exportQueue();backupOperationUi.finish(visit,result.canceled?'canceled':'complete',result.canceled?moteText('已取消'):moteText('队列备份已保存至 {0}',result.path),result.canceled?undefined:result.file);}
  catch(error){backupOperationUi.finish(visit,'error',moteText('导出未完成，请重试'),undefined,error instanceof Error?error.message:String(error));throw error;}
}));
byId('import').addEventListener('click',()=>void perform(async()=>{
  showPage('restore');
  const visit=backupOperationUi.begin('import',moteText('正在处理，请稍候…'),currentStatus.operations);
  if(!window.confirm(moteText('恢复到当前本机队列，继续按当前发送设置处理。是否继续？'))){backupOperationUi.finish(visit,'canceled',moteText('已取消'));return;}
  try {const outcome=await desktopApi.importQueue(),result=queueImportPresentation(outcome);backupOperationUi.finish(visit,result.phase,result.message,outcome.canceled?undefined:outcome.file,!outcome.canceled&&outcome.state==='incomplete'?outcome.error:undefined);}
  catch(error){backupOperationUi.finish(visit,'error',moteText('导入未完成，可能已有记录保存在本机。请检查本机内容后重试所选备份。'),undefined,error instanceof Error?error.message:String(error));throw error;}
}));
desktopApi.onStatus(render);
void desktopApi.status().then(render).catch(() => feedback(moteText("无法连接采集器进程，请重新打开 Mote。")));

byId('note-attachments').addEventListener('click',()=>void perform(()=>desktopApi.openCentral('notes')));
function openCentral(page: string): void {
  if (!currentStatus?.config.serverUrl) { showPage('connection'); feedback(moteText("先连接你的中央，即可打开中央仓库。")); return; }
  void perform(() => desktopApi.openCentral(page));
}
byId('home-feature-guide').addEventListener('click', () => openCentral('guide'));
let draft: import('./note-draft').NoteDraft | undefined;
let noteSaving = false;
let noteComposing = false;
const noteFields = ['note-text', 'note-description', 'save-note'];
byId<HTMLDetailsElement>('note-description-panel').addEventListener('toggle', () => {
  if (quickNote) void desktopApi.resizeQuickNote?.(byId<HTMLDetailsElement>('note-description-panel').open);
});
let noteLocked=true;
function noteControls():void {byId<HTMLButtonElement>('save-note').disabled=noteLocked||!readInput('note-text').trim();}
function lockNote(locked: boolean): void {noteLocked=locked;for (const id of noteFields) (byId(id) as HTMLInputElement).disabled = locked;noteControls();}
lockNote(true);
function renderDraft(value: import('./note-draft').NoteDraft): void {
  draft = value; byId<HTMLTextAreaElement>('note-text').value = value.text;byId<HTMLTextAreaElement>('note-description').value=value.description;byId<HTMLDetailsElement>('note-description-panel').open=Boolean(value.description);
  for(const id of ['note-text','note-description'])byId<HTMLTextAreaElement>(id).readOnly=Boolean(value.prepared);
}
void desktopApi.noteDraft().then(value => { renderDraft(value); lockNote(false); if (value.prepared) {byId('note-feedback').classList.remove('visually-hidden');byId('note-feedback').textContent = moteText("发现上次未完成的保存，点击保存可用原 ID 重试。");} }).catch(() => feedback(moteText("无法恢复记录草稿，请重启应用。")));
for (const id of ['note-text','note-description']) {
  byId(id).addEventListener('compositionstart', () => { noteComposing = true; });
  byId(id).addEventListener('compositionend', () => { noteComposing = false; });
}
for (const id of ['note-text','note-description']) byId(id).addEventListener('input', () => {
  noteControls();
  if (!draft || noteSaving) return;
  draft = { ...draft, text: readInput('note-text'), description:readInput('note-description'), mood: draft?.mood??'', revision: draft.revision + 1 };
  const changed = draft;
  void desktopApi.updateNoteDraft(changed).then(() => { if (draft?.id === changed.id && draft.revision === changed.revision) {byId('note-feedback').classList.add('visually-hidden');byId('note-feedback').textContent = moteText("草稿已保存到本机。");} }).catch(() => { byId('note-feedback').classList.remove('visually-hidden');byId('note-feedback').textContent = moteText("草稿暂未保存，请保留正文并重试；如上次保存未完成，请重新打开窗口恢复原稿。"); });
});
for(const id of ['note-dismiss','note-collapse'])byId(id).addEventListener('click',()=>{if(quickNote)window.close();else showPage(navigation.backTarget);});
byId('note-form').addEventListener('submit', event => {
  event.preventDefault(); if (!draft || noteSaving || noteComposing || busy) return;
  const input = { ...draft, text: readInput('note-text'), description:readInput('note-description'), mood: draft?.mood??'', revision: draft.revision + 1 };
  noteSaving = true; lockNote(true);
  document.body.classList.remove('note-save-failed');
  byId('note-feedback').replaceChildren();byId('note-feedback').classList.add('visually-hidden');
  void perform(async () => {
    try {
      const result = await desktopApi.saveNote(input); renderDraft(result.draft);void refreshContent();
      if (quickNote) window.close();
      byId('note-feedback').textContent = currentStatus.sync.state === 'unconfigured' ? moteText("已保存到本机。连接节点并确认后，再按你的策略同步。") : moteText("已保存到本机 · {0}上传。中央确认后清理待传记录。", syncModeLabels[currentStatus.config.syncMode]);
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : moteText("保存未完成，请重试");
      renderReadableFailure(byId('note-feedback'),moteText('保存未完成，请重试'),message);
      document.body.classList.add('note-save-failed');
      const persisted = await desktopApi.noteDraft();
      if (persisted.prepared || persisted.id !== input.id) renderDraft(persisted);
      else draft = { ...input, revision: Math.max(input.revision, persisted.revision) }; // Keep unsaved text visible if disk persistence failed.
      throw error;
    }
    finally { noteSaving = false; lockNote(false); }
  },true);
});

byId('open-feedback').addEventListener('click', () => void perform(() => desktopApi.openFeedback()));
byId('diagnostics-sample').addEventListener('click', () => void perform(async () => {const accept=beginDiagnosticFactsRefresh();const next=await desktopApi.sampleDiagnostics();render(next);accept(next);}));
byId('diagnostics-export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportDiagnostics(); if (!result.canceled) feedback(moteText("数值诊断已导出。"), true); }));
let logText = '';
let logWrap = true;
function renderLogs(): void {
  const viewer = byId('events-viewer'); viewer.replaceChildren();
  const actions = document.createElement('div'); actions.className = 'actions';
  const output = document.createElement('textarea'); output.readOnly = true;
  output.setAttribute('aria-label', moteText("原始日志")); output.spellcheck = false;
  output.className = 'raw-log-output'; output.wrap = logWrap ? 'soft' : 'off'; output.value = logText;
  output.placeholder = moteText("暂无日志。");
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

async function loadLogSettings(): Promise<void> {
  const settings = await desktopApi.logSettings();
  byId<HTMLInputElement>('runtime-log-enabled').checked = settings.enabled;
  byId<HTMLSelectElement>('runtime-log-level').value = settings.level;
  byId('runtime-log-directory').textContent = `${moteText('日志目录')}: ${settings.directory}`;
  for (const id of ['runtime-log-enabled','runtime-log-level','runtime-log-save','runtime-log-open','runtime-log-export']) byId<HTMLInputElement>(id).disabled = false;
}
void loadLogSettings().catch(() => feedback(moteText('日志读取失败，请重试；原文件保留。')));
byId('runtime-log-save').addEventListener('click', () => void perform(async () => {
  await desktopApi.saveLogSettings({enabled:byId<HTMLInputElement>('runtime-log-enabled').checked,level:byId<HTMLSelectElement>('runtime-log-level').value as import('./contracts/settings').RuntimeLogLevel});
  feedback(moteText('已保存，立即生效。'), true);
}));
byId('runtime-log-open').addEventListener('click', () => void perform(() => desktopApi.openLogDirectory()));
byId('runtime-log-export').addEventListener('click', () => void perform(async () => {const result=await desktopApi.exportLogs();if(!result.canceled)feedback(moteText('日志已导出。'),true);}));

byId('support-export').addEventListener('click', () => void perform(async () => { const result = await desktopApi.exportSupport(Number(byId<HTMLSelectElement>('log-export-hours').value)); if (!result.canceled) feedback(moteText("支持包已导出；只含数值、配置开关和固定阶段事件。"), true); }));

let localSourceRows: import('./source-types').SourceStatus[] = [];
let sourceEditingId: string | undefined;
let sourceEditingEpoch=0;
function invalidateSourceEditor():void {sourceEditingEpoch++;sourceEditingId=undefined;sourceEditingContext=undefined;}
function sourceEditorRequest(){return {epoch:sourceEditingEpoch,id:sourceEditingId,scope:sourceReadGeneration};}
function sourceEditorCurrent(request:ReturnType<typeof sourceEditorRequest>):boolean{return request.epoch===sourceEditingEpoch&&request.id===sourceEditingId&&request.scope===sourceReadGeneration;}
let sourceBusy = false;
let sourceSelection:{id:string;mode:'files'|'directory';names:string[]}|undefined;
const sourceRules=byId<HTMLDetailsElement>('source-rules');
const sourceRulesHome=sourceRules.parentElement!;
function restoreSourceRuleFields():void{sourceRules.prepend(byId('source-initial-description-row'));sourceRules.insertBefore(byId('source-destination').closest('label')!,byId('source-advanced'));}

function refreshSourcePolicySummaries():void {
  for(const [fieldId,summaryId] of [['source-initial-sync','source-history-value'],['source-retention','source-retention-value']]) byId(summaryId).textContent=byId<HTMLSelectElement>(fieldId).selectedOptions[0]?.textContent??'';
}
function restoreSourceRules():void {restoreSourceRuleFields();sourceRulesHome.append(sourceRules);sourceRules.open=false;byId<HTMLSelectElement>('source-initial-sync').disabled=false;refreshSourcePolicySummaries();}
function updateSourceHistoryChoice():void {const field=byId<HTMLSelectElement>('source-initial-sync'),once=sourceMode==='files'&&!byId<HTMLInputElement>('source-continuous').checked;field.disabled=Boolean(once);byId('source-initial-sync-row').hidden=once;byId('source-once-row').hidden=!once;if(once)field.value='all';refreshSourcePolicySummaries();}
byId('source-initial-sync').addEventListener('change',refreshSourcePolicySummaries);
refreshSourcePolicySummaries();
byId('source-continuous').addEventListener('change',updateSourceHistoryChoice);
let sourceMode:'files'|'directory'='directory';
function sourceDescriptionPlaceholder(kind:'files'|'agent'|'calendar'):string{
  return kind==='agent'?moteText('例如：这是我与 Coding Agent 的项目开发对话，包含工具执行记录。'):kind==='calendar'?moteText('例如：这是我的工作日历，日程不代表实际参加。'):moteText('例如：这是我的日记，文件名是日期。');
}
let sourceEditingContext:import('./source-context-outbox').SourceContextState|undefined;
const sourceAddDialog=byId<HTMLDialogElement>('source-add-dialog');
byId('source-add').addEventListener('click',()=>sourceAddDialog.showModal());
byId('source-add-close').addEventListener('click',()=>sourceAddDialog.close());
for(const id of ['source-central','source-cloud-choice'])byId(id).addEventListener('click',()=>{sourceAddDialog.close();if(!currentStatus?.config.serverUrl){showPage('connection');feedback(moteText('先连接你的中央，即可打开中央仓库。'));return;}void perform(()=>desktopApi.openCentral('sources'));});
function renderSourceDestination():void {
  const config=currentStatus?.config;byId('source-destination').textContent=config?.serverUrl||moteText('尚未连接中央，先保存在本机');
  byId('source-destination-state').textContent=!config?.tokenConfigured?moteText('未连接'):config.syncPaused?moteText('发送已暂停'):moteText('已连接');
}
function configureSourceEditor(mode:'files'|'directory'):void{
  restoreSourceRuleFields();sourceMode=mode;invalidateSourceEditor();byId('source-existing-selection').hidden=true;byId('source-editor-subtitle').hidden=true;byId('source-edit-footer').hidden=true;
  for(const kind of ['files','directory'])byId('source-mode-'+kind).setAttribute('aria-pressed',String(mode===kind));
  byId('source-selection-hint').textContent=mode==='directory'?moteText('以后修改，也自动同步'):moteText('保存当前文件一次');byId('source-continuous-row').hidden=mode!=='files';
  byId('source-confirm').textContent=mode==='directory'?moteText('添加并同步'):moteText('导入文件');byId('source-confirm-policy').textContent=currentStatus?.config.syncPaused?moteText('添加后先保存在本机'):moteText('按当前发送设置同步');
  byId('source-confirmation').hidden=false;byId('source-initial-description-row').hidden=false;byId<HTMLTextAreaElement>('source-initial-description').disabled=false;
  byId('source-editor-heading').textContent=mode==='directory'?moteText('同步文件夹'):moteText('导入文件');byId('source-confirm-title').hidden=true;
  byId('source-selected-names').textContent=sourceSelection?.names.join('\n')||(mode==='directory'?moteText('选择这台 Mac 上的文件夹'):moteText('选择这台 Mac 上的文件'));
  byId('source-change-selection').textContent=sourceSelection?moteText('更换'):moteText('选择…');
  if(mode==='directory')byId<HTMLInputElement>('source-continuous').checked=true;byId<HTMLInputElement>('source-continuous').disabled=mode==='directory';
  renderSourceDestination();
  byId('source-description-scope').textContent=mode==='directory'?moteText('适用于这个来源的已有与后续资料。'):moteText('仅适用于这次导入的文件。');
  byId('source-edit-continuous-row').hidden=true;byId('source-save-edit').hidden=true;byId('source-cancel-edit').hidden=true;
  byId('source-confirm-rules').append(sourceRules);sourceRules.open=true;byId<HTMLButtonElement>('source-confirm').disabled=!sourceSelection;updateSourceHistoryChoice();refreshSourceTextOptions();
}
async function beginSourceSelection(mode:'files'|'directory',pick=false):Promise<void>{
  if(sourceBusy)return;sourceAddDialog.close();
  byId<HTMLTextAreaElement>('source-initial-description').placeholder=sourceDescriptionPlaceholder('files');
  if(mode!==sourceMode||sourceEditingId){byId<HTMLInputElement>('source-continuous').checked=mode==='directory';if(sourceSelection)await desktopApi.cancelSourceFiles(sourceSelection.id);sourceSelection=undefined;byId<HTMLInputElement>('source-name').value='';byId<HTMLTextAreaElement>('source-initial-description').value='';byId<HTMLSelectElement>('source-initial-sync').value='all';byId<HTMLSelectElement>('source-retention').value='snapshot';}
  configureSourceEditor(mode);if(!showPage('source-editor'))return;if(!pick)return;
  await sourceAction(async()=>{const result=await desktopApi.selectSourceFiles(mode);if(result.canceled||!result.selectionId){if(!sourceSelection&&workbenchUi.cancelFirstFile())showPage('overview');return;}sourceSelection={id:result.selectionId,mode,names:result.names??[]};byId<HTMLInputElement>('source-name').value=sourceSelection.names.length===1?sourceSelection.names[0]:'';configureSourceEditor(mode);});
}
for(const mode of ['files','directory'] as const)byId('source-mode-'+mode).addEventListener('click',()=>void beginSourceSelection(mode));
byId('source-change-selection').addEventListener('click',()=>void beginSourceSelection(sourceMode,true));
byId('source-selection-cancel').addEventListener('click',()=>{if(sourceSelection)void desktopApi.cancelSourceFiles(sourceSelection.id);sourceSelection=undefined;byId('source-confirmation').hidden=true;restoreSourceRules();showPage(workbenchUi.cancelFirstFile()?'overview':'sources');});
function sourceSaveScope():string{return JSON.stringify([currentStatus.authorizationGeneration,currentStatus.config.serverUrl,currentStatus.config.deviceId,currentStatus.config.authSourceBinding??null,currentStatus.config.tokenConfigured]);}
byId('source-confirm').addEventListener('click',()=>void sourceAction(async()=>{
  if(!sourceSelection)return;const selected=sourceSelection,scope={selectionId:selected.id,scope:sourceSaveScope()},oneTime=selected.mode==='files'&&!byId<HTMLInputElement>('source-continuous').checked;const result=await desktopApi.confirmSourceFiles(selected.id,{...sourceOptions(),initialSync:oneTime?'all':sourceOptions().initialSync,syncContinuously:byId<HTMLInputElement>('source-continuous').checked});
  const sourceIds=sourceSelectionResult(result,scope,sourceSelection&&currentPage==='source-editor'?{selectionId:sourceSelection.id,scope:sourceSaveScope()}:undefined);if(!sourceIds)return;
  const firstRoute=oneTime?workbenchUi.sourcesSaved(sourceIds):undefined;
  sourceSelection=undefined;byId('source-confirmation').hidden=true;restoreSourceRules();byId<HTMLTextAreaElement>('source-initial-description').value='';await refreshContent();showPage(firstRoute??(oneTime?'records':'sources'));
}));
function sourceOptions(): import('./source-types').SourceOptions {
  return normalizeSourceOptions({name:readInput('source-name').trim()||undefined, ...(!sourceEditingId?{description:readInput('source-initial-description')}:{}),syncContinuously:sourceEditingId?byId<HTMLInputElement>('source-edit-continuous').checked:sourceSelection?byId<HTMLInputElement>('source-continuous').checked:true,centralProcessingConsent:true, initialSync: readInput('source-initial-sync') as 'all' | 'new_only', allowRead:readInput('source-retention')==='snapshot'&&byId<HTMLInputElement>('source-allow-read').checked,retention: readInput('source-retention') as 'snapshot' | 'reference' | 'archive', intervalSeconds: numberInput('source-interval'), trackDeletions: byId<HTMLInputElement>('source-deletions').checked, extensions: readInput('source-extensions').split(',').map(s => s.trim()).filter(Boolean), excludedPaths: readInput('source-excludes').split('\n').map(s => s.trim()).filter(Boolean), redactLiterals: readInput('source-redacts').split('\n').filter(Boolean) });
}
async function editSource(id?: string): Promise<void> {
  if(sourceSelection){void desktopApi.cancelSourceFiles(sourceSelection.id);sourceSelection=undefined;}byId('source-confirmation').hidden=true;restoreSourceRules();
  invalidateSourceEditor();sourceEditingId = id;const request=sourceEditorRequest();
  const source = localSourceRows.find(s => s.source.id === id)?.source;
  byId('source-editor-title').textContent = source ? moteText("编辑：") + source.name : moteText("新来源的保留与过滤规则");
  byId('source-edit-continuous-row').hidden=!source||source.kind!=='local-files';byId<HTMLInputElement>('source-edit-continuous').checked=source?.syncContinuously!==false;
  byId('source-save-edit').hidden = !source; byId('source-cancel-edit').hidden = !source;
  if (!source) { refreshSourceTextOptions();showPage('sources'); return; }
  byId('source-existing-selection').hidden=false;byId('source-existing-name').textContent=source.name;byId('source-existing-path').textContent=source.path||moteText('所选系统日历');byId('source-editor-subtitle').textContent=source.name;byId('source-editor-subtitle').hidden=false;byId('source-edit-footer').hidden=false;byId('source-continuous-row').hidden=true;byId('source-initial-sync-row').hidden=false;byId('source-once-row').hidden=true;byId<HTMLInputElement>('source-name').value=source.name;renderSourceDestination();
  byId('source-editor-heading').textContent=moteText('编辑来源');byId('source-initial-description-row').hidden=false;byId<HTMLTextAreaElement>('source-initial-description').placeholder=sourceDescriptionPlaceholder(source.kind==='coding-agent'?'agent':source.kind==='local-calendar'?'calendar':'files');byId<HTMLTextAreaElement>('source-initial-description').value=sourceWorkspaceDescription(id!);byId<HTMLTextAreaElement>('source-initial-description').disabled=true;showPage('source-editor');
  const editor = byId('source-editor-title').closest('details');
  if (editor) editor.open = true;
  byId<HTMLDetailsElement>('source-advanced').open=false;
  byId<HTMLSelectElement>('source-initial-sync').disabled=true;byId<HTMLSelectElement>('source-initial-sync').value=source.initialSync??'all'; byId<HTMLSelectElement>('source-retention').value = source.retention;byId<HTMLInputElement>('source-allow-read').checked=source.allowRead??false; byId<HTMLInputElement>('source-interval').value = String(source.intervalSeconds);
  byId<HTMLInputElement>('source-deletions').checked = source.trackDeletions; byId<HTMLInputElement>('source-extensions').value = source.extensions.join(',');
  byId<HTMLTextAreaElement>('source-excludes').value = source.excludedPaths.join('\n'); byId<HTMLTextAreaElement>('source-redacts').value = source.redactLiterals.join('\n'); refreshPresets();
  refreshSourceTextOptions();
  try{const value=await desktopApi.sourceContext(id!);if(sourceEditorCurrent(request)){sourceEditingContext=value;byId<HTMLTextAreaElement>('source-initial-description').value=value.pending?.description??value.snapshot.description;byId<HTMLTextAreaElement>('source-initial-description').disabled=value.error==='denied'||Boolean(value.error)&&!value.pending;byId('source-description-scope').textContent=value.error?moteText('暂时无法核对中央说明。输入保留在这里，可稍后重试。'):value.conflict?moteText('中央说明已改变，请核对后保存。'):moteText('适用于这个来源的已有与后续资料。');}}catch{/* Local rules remain editable when Central is unavailable. */}
}
function sourceWorkspaceDescription(id:string):string{const row=localSourceRows.find(row=>row.source.id===id);return row?.context?.pending?.description??row?.context?.snapshot.description??'';}
function refreshSourceTextOptions(): void {
  refreshSourcePolicySummaries();
  const source=localSourceRows.find(row=>row.source.id===sourceEditingId)?.source;
  const fileSource=currentPage!=='source-connect'&&(!source||source.kind==='local-files'),visible=fileSource&&readInput('source-retention')==='snapshot';
  const archive=byId<HTMLSelectElement>('source-retention').querySelector<HTMLOptionElement>('option[value=archive]');if(archive){archive.disabled=!fileSource;archive.hidden=!fileSource;}
  byId('source-file-text-options').hidden=!visible;
  byId<HTMLInputElement>('source-allow-read').disabled=!visible;
  byId('source-retention-hint').hidden=!fileSource;
  byId('source-retention-hint').textContent=readInput('source-retention')==='snapshot'?moteText('完整文件发往中心解析；处理后删除中心临时原件。'):readInput('source-retention')==='archive'?moteText('完整文件发往中心解析，并保留原件。'):moteText('只记录文件信息，不读取正文，也不上传文件内容。');
  byId('source-content-transfer-note').hidden=!fileSource;
  byId('source-content-transfer-note').textContent=readInput('source-retention')==='reference'?moteText('只记录文件信息，不读取正文，也不上传文件内容。'):moteText('完整文件会发送到所示中央进行处理；提取正文不代表只上传摘要。未连接时先保存本机任务，首次连接须确认发送范围。');
}
byId('source-retention').addEventListener('change',refreshSourceTextOptions);
let sourcesReading = false;let sourceReadGeneration=0,sourceConnectGeneration=0;
async function refreshSources(): Promise<void> {
  if (sourcesReading) return;
  sourcesReading = true;const generation=sourceReadGeneration;
  try {
  const rows = await desktopApi.sources();if(generation!==sourceReadGeneration)return;localSourceRows = rows;
  sourceWorkspace.update(rows);if(currentStatus)captureSyncUi.update(currentStatus,rows);workbenchUi.setHasSource(rows.some(row=>row.source.syncContinuously!==false));
  } finally { sourcesReading = false; }
}
async function sourceAction(action: () => Promise<void>): Promise<void> {
  if (sourceBusy) return; sourceBusy = true;byId('source-feedback').hidden=false; byId('source-feedback').textContent = moteText("正在处理，请稍候…");
  for (const id of ['calendar-actions-connect', 'source-agent-discover', 'source-agent-add', 'source-files', 'source-directory', 'source-calendar-connect', 'source-calendar-add', 'source-calendar-cancel', 'source-save-edit', 'source-sync', 'source-confirm']) byId<HTMLButtonElement>(id).disabled = true;
  try { await action(); byId('source-feedback').textContent='';byId('source-feedback').hidden=true; }
  catch (error) { renderReadableFailure(byId('source-feedback'),moteText('操作未完成，请检查权限与配置后重试'),error instanceof Error?error.message:String(error)); }
  finally { sourceBusy = false; for (const id of ['calendar-actions-connect', 'source-agent-discover', 'source-agent-add', 'source-files', 'source-directory', 'source-calendar-connect', 'source-calendar-add', 'source-calendar-cancel', 'source-save-edit', 'source-sync', 'source-confirm']) byId<HTMLButtonElement>(id).disabled = false; await refreshSources().catch(() => {});byId<HTMLButtonElement>('source-confirm').disabled=!sourceSelection;byId<HTMLButtonElement>('source-calendar-add').disabled=!readInput('source-calendar-choice');byId<HTMLButtonElement>('source-agent-add').disabled=!readInput('source-agent-choice'); }
}
for(const kind of ['agent','calendar'] as const)byId('source-'+kind+'-choice-open').addEventListener('click',()=>{sourceConnectGeneration++;byId<HTMLSelectElement>('source-agent-choice').replaceChildren();byId<HTMLSelectElement>('source-calendar-choice').replaceChildren();byId('source-agent-choice').hidden=true;byId('source-agent-add').hidden=true;byId('source-calendars').hidden=true;byId<HTMLButtonElement>('source-calendar-add').disabled=true;byId<HTMLButtonElement>('source-agent-add').disabled=true;sourceAddDialog.close();invalidateSourceEditor();if(sourceSelection)void desktopApi.cancelSourceFiles(sourceSelection.id);sourceSelection=undefined;byId<HTMLInputElement>('source-name').value='';byId('source-edit-footer').hidden=true;byId('source-continuous-row').hidden=true;byId('source-edit-continuous-row').hidden=true;byId('source-initial-sync-row').hidden=false;byId('source-once-row').hidden=true;byId<HTMLSelectElement>('source-initial-sync').disabled=false;renderSourceDestination();byId('source-agent-panel').hidden=kind!=='agent';byId('source-calendar-panel').hidden=kind!=='calendar';byId('source-calendar-footer').hidden=kind!=='calendar';byId('source-calendar-connect').hidden=false;byId('source-calendar-permission').textContent=moteText('无法确认，请检查系统设置');byId('source-agent-statuses').replaceChildren();byId<HTMLTextAreaElement>('source-initial-description').placeholder=sourceDescriptionPlaceholder(kind);byId('source-connect-title').textContent=kind==='agent'?moteText('本机 Coding Agent'):moteText('本机日历');byId('source-editor-title').textContent=moteText('同步详情');byId('source-connect-rules').append(byId('source-initial-description-row'),byId('source-destination').closest('label')!,sourceRules);sourceRules.open=false;byId('source-initial-description-row').hidden=false;byId<HTMLTextAreaElement>('source-initial-description').disabled=false;byId('source-save-edit').hidden=true;byId('source-cancel-edit').hidden=true;byId<HTMLSelectElement>('source-retention').value='snapshot';showPage('source-connect');refreshSourceTextOptions();});
for (const mode of ['files','directory'] as const)byId('source-'+mode).addEventListener('click',()=>void beginSourceSelection(mode));
byId('source-calendar-connect').addEventListener('click', () => void sourceAction(async () => {
  const current=sourceConnectRequest();
  const permissions = await desktopApi.permissionStatus();if(!current())return;
  byId('source-calendar-permission').textContent=permissions.calendar==='granted'?moteText('已允许'):permissions.calendar==='denied'?moteText('未授权'):moteText('无法确认，请检查系统设置');
  if (permissions.calendar === 'denied') { window.alert(moteText("日历访问尚未授权，请在权限管理中开启。")); showPage('permissions'); return; }
  const calendars = await desktopApi.authorizeCalendar();if(!current())return; const select = byId<HTMLSelectElement>('source-calendar-choice'); select.replaceChildren();
  for (const calendar of calendars) { const option = document.createElement('option'); option.value = calendar.id; option.textContent = calendar.title; select.append(option); }
  byId('source-calendars').hidden = !calendars.length;byId('source-calendar-connect').hidden=calendars.length>0;byId('source-calendar-permission').textContent=moteText('已允许');
  if (!calendars.length) throw new Error(moteText("已授权，但系统中没有可选日历；请在系统日历中添加后重试"));
}));
byId('source-agent-discover').addEventListener('click', () => void sourceAction(async () => {
  const current=sourceConnectRequest(),agents = await desktopApi.codingAgents();if(!current())return; const select = byId<HTMLSelectElement>('source-agent-choice'); select.replaceChildren();
  const statuses=byId('source-agent-statuses');statuses.replaceChildren();
  for(const agent of agents){const row=document.createElement('div');row.className='source-provider-row';const name=document.createElement('strong'),state=document.createElement('span');name.textContent=agent.name;const connected=localSourceRows.find(item=>item.source.agent===agent.provider);state.textContent=connected?moteText('已连接'):agent.available?moteText('发现本机目录'):moteText('未发现本机目录');row.append(name,state);if(connected){const open=document.createElement('button');open.type='button';open.className='text-button';open.textContent=moteText('查看来源');open.addEventListener('click',()=>{if(!sourceBusy)sourceWorkspace.open(connected.source.id);});row.append(open);}statuses.append(row);}
  for (const agent of agents.filter(a => a.available)) { const option = document.createElement('option'); option.value = agent.provider; option.textContent = agent.name; select.append(option); }
  select.hidden = !select.options.length; byId('source-agent-add').hidden = !select.options.length;
  if (!select.options.length) throw new Error(moteText("本机默认目录中尚未发现受支持的 Agent 会话"));
}));
function sourceConnectRequest():()=>boolean{const generation=sourceConnectGeneration,scope=sourceSaveScope(),revision=pageRevision;return ()=>generation===sourceConnectGeneration&&scope===sourceSaveScope()&&revision===pageRevision&&currentPage==='source-connect';}
async function connectLocalSource(save:()=>Promise<string>):Promise<void>{
  const generation=sourceConnectGeneration,scope=sourceSaveScope(),revision=pageRevision,id=await save();
  if(generation!==sourceConnectGeneration||scope!==sourceSaveScope()||revision!==pageRevision||currentPage!=='source-connect')return;
  sourceSelectionResult({sourceIds:[id]},{selectionId:'connect',scope},{selectionId:'connect',scope:sourceSaveScope()});
  await refreshSources();if(generation!==sourceConnectGeneration||scope!==sourceSaveScope()||revision!==pageRevision||currentPage!=='source-connect')return;
  byId<HTMLTextAreaElement>('source-initial-description').value='';sourceWorkspace.open(id);
}
byId('source-agent-add').addEventListener('click', () => void sourceAction(()=>connectLocalSource(()=>desktopApi.addCodingAgent(readInput('source-agent-choice') as import('./coding-agents').CodingProvider,sourceOptions()))));
byId('source-calendar-add').addEventListener('click', () => void sourceAction(()=>connectLocalSource(()=>desktopApi.addCalendarSource(readInput('source-calendar-choice'),sourceOptions()))));
byId('source-calendar-cancel').addEventListener('click',()=>{if(sourceBusy)return;sourceConnectGeneration++;byId<HTMLTextAreaElement>('source-initial-description').value='';showPage('sources');});
byId('source-calendar-choice').addEventListener('change',()=>{byId<HTMLButtonElement>('source-calendar-add').disabled=sourceBusy||!readInput('source-calendar-choice');});
byId('source-agent-choice').addEventListener('change',()=>{byId<HTMLButtonElement>('source-agent-add').disabled=sourceBusy||!readInput('source-agent-choice');});
byId('source-sync').addEventListener('click', () => void sourceAction(() => desktopApi.syncSources()));
byId('calendar-actions-connect').addEventListener('click', () => void sourceAction(async()=>{await desktopApi.connectActionCalendar();await desktopApi.openCentral('actions');}));
byId('source-calendar-permissions').addEventListener('click', () => void sourceAction(() => desktopApi.openCalendarPermissions()));
byId('source-cancel-edit').addEventListener('click',()=>{if(sourceEditingId)sourceWorkspace.open(sourceEditingId);else showPage('sources');});
byId('source-save-edit').addEventListener('click', () => void sourceAction(async () => {
  const source = localSourceRows.find(s => s.source.id === sourceEditingId)?.source; if (!source) throw new Error(moteText("请先选择要编辑的来源"));
  const request=sourceEditorRequest(),options=sourceOptions(),description=readInput('source-initial-description');
  if(sourceEditingContext&&!byId<HTMLTextAreaElement>('source-initial-description').disabled&&description!==(sourceEditingContext.pending?.description??sourceEditingContext.snapshot.description))await desktopApi.saveSourceContext(source.id,{expectedVersion:sourceEditingContext.snapshot.version,description});
  if(!sourceEditorCurrent(request))return;
  await desktopApi.updateSource(source.id, { ...options, enabled: source.enabled });if(!sourceEditorCurrent(request))return;await refreshSources();if(!sourceEditorCurrent(request))return;sourceWorkspace.open(source.id);invalidateSourceEditor();
}));
void refreshSources().catch(() => { byId('source-feedback').textContent = moteText("来源状态暂不可用，请重新打开应用"); });
setInterval(() => { void refreshSources().catch(() => {}); }, 3000);

let meetingStatus: import('./contracts/sources').MeetingRecordingStatus | undefined;
let meetingBusy = false;
function meetingPermissionText(value: import('./contracts/sources').MeetingRecordingStatus): string {
  const missing = [
    value.permissions.microphone === 'granted' ? '' : moteText('麦克风'),
    value.permissions.systemAudio === 'granted' ? '' : moteText('系统音频'),
  ].filter(Boolean);
  return missing.length ? moteText('尚未允许：{0}', missing.join('、')) : moteText('麦克风与系统音频已允许');
}
function meetingTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocale()); }
function renderMeeting(value: import('./contracts/sources').MeetingRecordingStatus): void {
  meetingStatus = value;
  const session = value.lastSession;
  byId('meeting-state').textContent = value.recording ? moteText('正在录音') : moteText('未在录音');
  byId('meeting-dot').dataset.state = value.recording ? 'syncing' : 'paused';
  byId('meeting-permission').textContent = meetingPermissionText(value);
  byId('meeting-permission').dataset.state = value.permissions.microphone === 'granted' && value.permissions.systemAudio === 'granted' ? 'granted' : 'missing';
  const message = value.recording && value.startedAt
    ? moteText('已于 {0} 开始。仅在你点击结束后生成并上传一场会议的音频。', meetingTime(value.startedAt))
    : value.error ?? moteText('只有点击开始后才会录音；不会按日历或日程自动开始。');
  byId('meeting-message').textContent = message;
  byId('meeting-summary').textContent = value.pendingUploads
    ? moteText('{0} 场会议录音保存在本机，连接中央后自动上传。', String(value.pendingUploads))
    : moteText('一场会议对应一份音频；结束后进入中央已有转写。');
  byId<HTMLButtonElement>('meeting-start').disabled = meetingBusy || value.recording;
  byId<HTMLButtonElement>('meeting-stop').disabled = meetingBusy || !value.recording;
  byId('source-meeting-summary').textContent = value.recording ? moteText('正在录音 · 点击结束') : session
    ? session.state === 'uploaded' ? moteText('最近一场已入库') : session.state === 'completed' ? moteText('最近一场待上传') : moteText('最近一场未完成')
    : moteText('开始一场会议录音');
  byId('source-meeting-state').textContent = value.recording ? moteText('录音中') : moteText('已停止');
  byId('source-meeting-state').dataset.state = value.recording ? 'syncing' : 'paused';
  byId('meeting-last').textContent = !session ? moteText('尚无会议录音。') : [
    meetingTime(session.startedAt),
    session.durationMs ? moteText('{0} 分钟', String(Math.max(1, Math.round(session.durationMs / 60000)))) : '',
    session.state === 'uploaded' ? moteText('已进入中央转写') : session.state === 'completed' ? moteText('保存在本机，等待上传') : session.state === 'failed' ? moteText('未完成') : moteText('正在录音'),
    !session.microphone && session.state !== 'recording' ? moteText('仅系统音频') : !session.systemAudio && session.state !== 'recording' ? moteText('仅麦克风') : '',
    session.error ?? '',
  ].filter(Boolean).join(' · ');
}
async function refreshMeeting(): Promise<void> {
  if (meetingBusy || document.hidden) return;
  try { renderMeeting(await desktopApi.meetingRecordingStatus()); }
  catch (error) { byId('meeting-message').textContent = error instanceof Error ? error.message : moteText('会议录音状态暂不可用。'); }
}
async function startMeeting(): Promise<void> {
  if (meetingBusy) return;
  meetingBusy = true; if (meetingStatus) renderMeeting(meetingStatus);
  try { renderMeeting(await desktopApi.startMeetingRecording()); feedback(moteText('会议录音已开始。'), true); }
  catch (error) { byId('meeting-message').textContent = error instanceof Error ? error.message : moteText('会议录音没有开始。'); }
  finally { meetingBusy = false; await refreshMeeting(); }
}
byId('meeting-start').addEventListener('click', () => {
  if (meetingStatus?.recording) return;
  if (!meetingStatus?.noticeAcknowledged) byId<HTMLDialogElement>('meeting-notice-dialog').showModal();
  else void startMeeting();
});
byId('meeting-notice-cancel').addEventListener('click', () => byId<HTMLDialogElement>('meeting-notice-dialog').close());
byId('meeting-notice-confirm').addEventListener('click', () => void (async () => {
  if (meetingBusy) return;
  meetingBusy = true;
  try {
    renderMeeting(await desktopApi.acknowledgeMeetingNotice());
    byId<HTMLDialogElement>('meeting-notice-dialog').close();
    meetingBusy = false;
    await startMeeting();
  } catch (error) {
    byId('meeting-message').textContent = error instanceof Error ? error.message : moteText('未能保存告知确认。');
  } finally { meetingBusy = false; await refreshMeeting(); }
})());
byId('meeting-stop').addEventListener('click', () => void (async () => {
  if (meetingBusy || !meetingStatus?.recording) return;
  meetingBusy = true; renderMeeting(meetingStatus);
  try { renderMeeting(await desktopApi.stopMeetingRecording()); feedback(moteText('会议录音已结束，正在进入中央转写。'), true); }
  catch (error) { byId('meeting-message').textContent = error instanceof Error ? error.message : moteText('会议录音没有正常结束。'); }
  finally { meetingBusy = false; await refreshMeeting(); }
})());
byId('meeting-sync').addEventListener('click', () => void (async () => {
  try { await desktopApi.syncMeetingRecordings(); await refreshMeeting(); feedback(moteText('已尝试上传本机会议录音。'), true); }
  catch (error) { byId('meeting-message').textContent = error instanceof Error ? error.message : moteText('会议录音上传未完成。'); }
})());
byId('meeting-permissions').addEventListener('click', () => void perform(() => desktopApi.openPermissions()));
setInterval(() => { void refreshMeeting(); }, 2500);

let updateState: import('./updater').UpdateStatus | undefined;
const updateInstallUi=createUpdateInstallUi(document,{
  status:()=>desktopApi.updateStatus(),
  allowed(){
    if(settingsDirty){feedback(moteText('请先保存或还原设置修改，再安装更新。'));return false;}
    if(noteSaving||noteComposing){feedback(moteText('请先完成当前记录输入，再安装更新。'));return false;}
    return true;
  },
  async install(){await perform(async()=>{
    lockNote(true);byId('local-sources').inert=true;
    try{
      if(draft&&!draft.prepared)draft=await desktopApi.updateNoteDraft({...draft,text:readInput('note-text'),description:readInput('note-description'),mood:draft.mood??'',revision:draft.revision+1});
      await desktopApi.installUpdate();
    }finally{lockNote(false);byId('local-sources').inert=false;}
  });},
  failed(){feedback(moteText('更新未完成，现有 App 与资料保持不变。请检查网络、磁盘空间后重试。'));},
});
function renderUpdate(value: import('./updater').UpdateStatus): void {
  updateState = value;updateInstallUi.update(value);
  byId('about-client').textContent='Mote for Mac · '+(value.manualDownload?'Dev':'Prod');byId('about-version').textContent=value.currentVersion;byId('about-update-heading').textContent=value.manualDownload?moteText('Dev 构建'):moteText('应用更新');
  for (const id of ['update-channel','update-check','update-download','update-cancel','update-install','update-reveal','update-progress']) byId(id).hidden=!!value.manualDownload;
  byId('update-channel').closest('label')!.hidden=!!value.manualDownload;
  byId('app-updates').querySelector('details')!.hidden=!!value.manualDownload;
  byId('update-notes').classList.toggle('secondary',!!value.manualDownload);byId('update-notes').classList.toggle('text-button',!value.manualDownload);
  byId('update-notes').textContent=value.manualDownload?moteText('查看 Dev 构建产物'):moteText('查看版本说明与安装包');
  byId('update-version').textContent = moteText("当前 {0}{1}", value.currentVersion, value.availableVersion ? moteText(" · 发布 ") + value.availableVersion : '');
  byId<HTMLSelectElement>('update-channel').value = value.channel;
  byId('update-message').textContent = value.manualDownload?moteText('从构建产物页面手动下载安装包，同包覆盖安装。'):value.message; byId('update-install-reason').textContent = value.installReason;
  byId<HTMLProgressElement>('update-progress').value = value.total ? value.received / value.total : 0;
  byId('update-bytes').textContent = value.total ? `${(value.received / 1048576).toFixed(1)} / ${(value.total / 1048576).toFixed(1)} MiB` : '';
  const working = ['checking', 'downloading', 'verifying', 'installing'].includes(value.state);
  byId('update-progress').hidden=!!value.manualDownload||!['downloading','verifying'].includes(value.state);byId('update-cancel').hidden=!!value.manualDownload||!working;
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
byId('update-install').addEventListener('click',()=>updateInstallUi.open());
void desktopApi.updateStatus().then(renderUpdate).catch(() => {});
// One polling request at a time, even if a slow disk or worker delays a reply.
let statusReading = false;
setInterval(() => {
  if (statusReading || document.hidden || busy) return;
  statusReading = true; const epoch = statusReadEpoch;
  void Promise.allSettled([desktopApi.status().then(status => { if (epoch === statusReadEpoch && !busy) render(status); }), desktopApi.updateStatus().then(renderUpdate)])
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
  byId('connection-resume').textContent = value.serverUrl === currentStatus?.config.serverUrl ? moteText("同一节点重新授权后，现有待传截图、记录和来源版本将继续发往此地址。节点身份以此地址和 HTTPS 证书为准；请确认它仍由你控制。") : moteText("更换节点时，本机必须没有待传截图、记录或来源版本；设备 ID、隐私设置和本地模型将保留。");
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
  return (readInput('sync-mode') || 'realtime') as import('./contracts').SyncMode;
}
function updateSyncOptions(): void {
  const mode = selectedSyncMode();
  byId('sync-interval-field').hidden = mode !== 'interval' && mode !== 'batch';
  byId('sync-batch-field').hidden = mode !== 'batch';
  byId('sync-interval-label').textContent = mode === 'batch' ? moteText("最长等待（分钟）") : moteText("发送间隔（分钟）");
  const descriptions = {
    realtime: moteText("记录保存后尽快发送。断网或失败时仍留在本机，稍后自动重试。"),
    interval: moteText("每 {0} 分钟检查并上传待传记录。休眠期间顺延，唤醒后继续。", readInput('sync-interval')),
    batch: moteText("攒够 {0} 条，或最早记录等待 {1} 分钟后发送，以先达到的条件为准。每条记录单独确认接收。", readInput('sync-batch'), readInput('sync-interval')),
    manual: moteText("不自动上传记录或发送设备状态。点击概览的“立即上传”或来源页的“立即检查并上传”时发送；下次仍由你手动触发。"),
  };
  byId('sync-policy-help').textContent = descriptions[mode];
  byId('sync-save-hint').textContent=currentStatus?.config.syncPaused?moteText('保存后仍保持发送暂停'):moteText('保存后应用于后续发送');
}
for (const input of Array.from(document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('#sync-mode, #sync-interval, #sync-batch'))) {input.addEventListener('input', updateSyncOptions);input.addEventListener('change',updateSyncOptions);}
byId('sync-cancel').addEventListener('click',()=>{if(busy)return;fillConfig(currentStatus.config);showPage('work');});
function updateLocalBacklog(): void {
  if (!currentStatus) return;
  byId('local-backlog-confirmation').hidden = !currentStatus.sync.localBacklogUnbound;
  let destination = moteText("你填写的节点");
  try { destination = new URL(readInput('server-url')).origin; } catch { /* Blank means local-only. */ }
  byId('local-backlog-copy').textContent = moteText("本机有 {0} 条尚未绑定节点的待传记录，及可能尚未完成保存的记录。确认后将归属 {1}，按上传策略发送。", currentStatus.sync.pendingRecords, destination);
}
function updateTokenField(): void {
  byId('node-token-field').hidden = Boolean(currentStatus?.config.tokenConfigured && readInput('server-url').trim().replace(/\/$/, '') === currentStatus.config.serverUrl.replace(/\/$/, ''));
}
byId('server-url').addEventListener('input', updateTokenField);
for (const id of ['server-url', 'token']) byId(id).addEventListener('input', () => { byId<HTMLInputElement>('confirm-local-backlog').checked = false; updateLocalBacklog(); });

const presetFields: Record<string, [number, string][]> = {
  'source-interval': [[60, moteText("每分钟")], [300, moteText("每 5 分钟")], [900, moteText("每 15 分钟")], [3600, moteText("每小时")]],
  'capture-max-side': [[640, '640 px'], [960, '960 px'], [1280, '1280 px'], [1600, '1600 px'], [1920, '1920 px'], [2560, '2560 px']],
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

let compressionRevision=0, compressionWidth=2560, compressionBusy=false;
function compressionZoom():void {
  const zoom=readInput('compression-zoom');
  for(const id of ['compression-before','compression-after']){const img=byId<HTMLImageElement>(id);img.parentElement!.dataset.zoomed=String(zoom!=='fit');img.style.width=zoom==='fit'?'100%':`${compressionWidth*Number(zoom)}px`;img.style.maxWidth='none';}
}
async function refreshCompression():Promise<void>{
  const revision=++compressionRevision,quality=numberInput('compression-quality');
  for(const id of ['compression-before','compression-after']){const image=byId<HTMLImageElement>(id);image.hidden=true;image.removeAttribute('src');}
  compressionBusy=true;byId<HTMLButtonElement>('compression-refresh').disabled=true;byId('compression-stats').textContent=moteText("正在生成压缩预览…");byId<HTMLButtonElement>('compression-apply').disabled=true;
  try{const result=await desktopApi.compressionPreview(quality,numberInput('compression-side'));if(revision!==compressionRevision||currentPage!=='compression')return;
    byId<HTMLImageElement>('compression-before').src=result.original;byId<HTMLImageElement>('compression-after').src=result.compressed;byId('compression-before').hidden=false;byId('compression-after').hidden=false;compressionWidth=result.originalWidth;compressionZoom();
    const ratio=result.compressedBytes/result.originalBytes;
    byId('compression-stats').textContent='';byId('compression-result-caption').textContent='JPEG · '+quality+' · '+numberInput('compression-side')+' px · '+result.compressedBytes.toLocaleString(getLocale())+' bytes';byId('compression-metrics').textContent=moteText("{0} × {1} → {2} × {3} · 边长缩放 {4}% · PNG {5} KB → JPEG {6} KB · 文件大小为原图的 {7}%（{8} {9}%）", result.originalWidth, result.originalHeight, result.width, result.height, (result.width/result.originalWidth*100).toFixed(1), (result.originalBytes/1024).toFixed(1), (result.compressedBytes/1024).toFixed(1), (ratio*100).toFixed(1), ratio<=1?moteText("减少"):moteText("增加"), (Math.abs(1-ratio)*100).toFixed(1));
    byId<HTMLButtonElement>('compression-apply').disabled=false;
  }catch(error){if(revision===compressionRevision&&currentPage==='compression')renderReadableFailure(byId('compression-stats'),moteText('预览失败，请调整参数重试'),error instanceof Error?error.message:String(error));}
  finally{compressionBusy=false;byId<HTMLButtonElement>('compression-refresh').disabled=false;}
}
function invalidateCompression():void{compressionRevision++;byId('compression-metrics').textContent='';byId('compression-result-caption').textContent='JPEG';byId<HTMLButtonElement>('compression-apply').disabled=true;byId<HTMLButtonElement>('compression-refresh').disabled=compressionBusy;for(const id of ['compression-before','compression-after']){const image=byId<HTMLImageElement>(id);image.hidden=true;image.removeAttribute('src');}byId('compression-stats').textContent=moteText('调整参数后比较清晰度。');}
for(const id of ['compression-quality','compression-side']){byId(id).addEventListener('input',invalidateCompression);byId(id).addEventListener('change',invalidateCompression);}
byId('compression-refresh').addEventListener('click',()=>{if(!compressionBusy)void refreshCompression();});
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
let askScopeUnavailable = false;
let askView:'history'|'conversation'='history';
let askSubmittedQuestion='',askStopPending=false,askRunLookupPending=false,askPendingMessage='';
let askBusy = false, askGeneration = 0, askCursor: string | undefined;
type AskPendingInput = {id: string; question: string; conversationId?: string};
let askPendingInput: AskPendingInput | undefined;
let askTimer: ReturnType<typeof setTimeout> | undefined;
type AskReadingPosition = {oldestTurnId?:string;scrollY:number;anchor?:{turnId:string;top:number}};
type AskWindowDraft = {question:string;view:'history'|'conversation';conversationId?:string;reading?:AskReadingPosition;pending?:AskPendingInput;running?:{id:string;conversationId?:string;stopPending:boolean};submittedQuestion:string;pendingMessage:string};
const askDraftScopes=new AskDraftScopes<AskWindowDraft>();
let askRestoringConversationId:string|undefined,askRestoreAttempt=-1;
let askRestoringReading:AskReadingPosition|undefined;
function captureAskReading():AskReadingPosition|undefined {
  if(!askConversation)return undefined;
  const visible=Array.from(byId('ask-messages').querySelectorAll<HTMLElement>('[data-ask-turn]')).find(node=>{const rect=node.getBoundingClientRect();return rect.bottom>0&&rect.top<window.innerHeight;});
  return {oldestTurnId:askConversation.turns[0]?.id,scrollY:window.scrollY,...(visible?.dataset.askTurn?{anchor:{turnId:visible.dataset.askTurn,top:visible.getBoundingClientRect().top}}:{})};
}
function restoreAskReadingPosition(reading:AskReadingPosition,conversation:import('./ask').AskConversation,generation:number):void {
  requestAnimationFrame(()=>{if(generation!==askGeneration||askConversation!==conversation||currentPage!=='ask')return;const anchor=reading.anchor&&Array.from(byId('ask-messages').querySelectorAll<HTMLElement>('[data-ask-turn]')).find(node=>node.dataset.askTurn===reading.anchor!.turnId);if(anchor&&reading.anchor)window.scrollBy({top:anchor.getBoundingClientRect().top-reading.anchor.top,behavior:'instant'});else window.scrollTo({top:reading.scrollY,behavior:'instant'});});
}
function snapshotAskDraft():AskWindowDraft|undefined {
  const question=readInput('ask-question'),conversationId=askConversation?.id??askRestoringConversationId??askPendingInput?.conversationId??askRun?.conversationId;
  const running=askRun?.status==='running'?{id:askRun.id,...(askRun.conversationId?{conversationId:askRun.conversationId}:{}),stopPending:askStopPending}:undefined;
  if(!question&&!conversationId&&!askPendingInput&&!running)return undefined;
  const reading=askConversation?(currentPage==='ask'?captureAskReading():askReadingOnLeave):askRestoringReading;
  return {question,view:askView,...(conversationId?{conversationId}:{}),...(reading?{reading}:{}),...(askPendingInput?{pending:{...askPendingInput}}:{}),...(running?{running}:{}),submittedQuestion:askSubmittedQuestion,pendingMessage:askPendingMessage};
}
function restoreScopedAskDraft(saved:AskWindowDraft|undefined):void {
  byId<HTMLTextAreaElement>('ask-question').value=saved?.question??'';
  askView=saved?.view??'history';askPendingInput=saved?.pending;askSubmittedQuestion=saved?.submittedQuestion??'';askPendingMessage=saved?.pendingMessage??'';
  askRestoringConversationId=saved?.conversationId;askRestoringReading=saved?.reading;askReadingOnLeave=saved?.reading;askRestoreAttempt=-1;askScopeUnavailable=Boolean(askRestoringConversationId);
  askRun=saved?.running?{id:saved.running.id,status:'running',events:[],...(saved.running.conversationId?{conversationId:saved.running.conversationId}:{})}:undefined;
  askStopPending=Boolean(saved?.running?.stopPending);askRunLookupPending=Boolean(saved?.running);
}
function maybeRestoreAskConversation():void {
  const id=askRestoringConversationId;
  if(!id||askBusy||!currentStatus?.config.tokenConfigured||currentStatus.config.authSignedOut||askRestoreAttempt===askGeneration)return;
  askRestoreAttempt=askGeneration;
  void askAction(()=>loadAskConversation(id));
}
function languageDraftScope():string{return JSON.stringify([currentStatus.config.serverUrl,currentStatus.config.deviceId,currentStatus.config.authSourceBinding??null]);}
window.addEventListener('mote-language-changing',event=>{const draft=snapshotAskDraft();if(!draft)return;try{keepLanguageAskDraft(sessionStorage,{scope:languageDraftScope(),question:draft.question,view:draft.view,...(draft.conversationId?{conversationId:draft.conversationId}:{}),...(draft.reading?{reading:draft.reading}:{}),...(draft.submittedQuestion?{submittedQuestion:draft.submittedQuestion}:{}),...(draft.running?{unresolvedRun:{id:draft.running.id,...(draft.running.conversationId?{conversationId:draft.running.conversationId}:{}),...(draft.running.stopPending?{stopPending:true as const}:{})}}:{}),...(draft.pending?{pendingRequest:draft.pending}:{})});}catch{event.preventDefault();}});
window.addEventListener('mote-language-change-failed',()=>{try{dropLanguageAskDraft(sessionStorage);}catch{}});
function restoreLanguageAskDraft():void{try{const saved=takeLanguageAskDraft(sessionStorage,languageDraftScope());if(!saved)return;restoreScopedAskDraft({question:saved.question,view:saved.pendingRequest||saved.unresolvedRun?'conversation':saved.view,...(saved.conversationId?{conversationId:saved.conversationId}:{}),...(saved.reading?{reading:saved.reading}:{}),...(saved.pendingRequest?{pending:saved.pendingRequest}:{}),...(saved.unresolvedRun?{running:{id:saved.unresolvedRun.id,...(saved.unresolvedRun.conversationId?{conversationId:saved.unresolvedRun.conversationId}:{}),stopPending:Boolean(saved.unresolvedRun.stopPending)}}:{}),submittedQuestion:saved.submittedQuestion??'',pendingMessage:''});renderAsk();maybeRestoreAskConversation();}catch{/* No unrelated session may be restored. */}}

function mayReplaceAskDraft(next:string):boolean {
  const draft=readInput('ask-question');
  return !draft.trim()||draft===next||window.confirm(moteText('还有未发送的问题。舍弃原输入并新建对话？'));
}
function openWorkbenchQuestion(question:string):boolean {
  if(askBusy||askPendingInput||askRun?.status==='running'||!mayReplaceAskDraft(question))return false;
  if(!showPage('ask',true,false,false))return false;
  askGeneration++;clearTimeout(askTimer);askRun=undefined;askConversation=undefined;askRestoringConversationId=undefined;askRestoringReading=undefined;askReadingOnLeave=undefined;skipNextAskRefresh=false;askScopeUnavailable=false;askPendingInput=undefined;
  askView='conversation';askSubmittedQuestion='';byId<HTMLTextAreaElement>('ask-question').value=question;renderAsk();void refreshAsk();
  byId('ask-question').focus();return true;
}
function openWorkbenchConversation(id:string):void {
  if(askBusy||askPendingInput||askRun?.status==='running')return;
  const switching=(askConversation?.id??askRestoringConversationId)!==id;
  if(switching&&!mayReplaceAskDraft(''))return;
  if(!showPage('ask',true,false,false))return;
  if(switching)byId<HTMLTextAreaElement>('ask-question').value='';
  askGeneration++;clearTimeout(askTimer);askRun=undefined;askConversation=undefined;askRestoringConversationId=id;askRestoringReading=undefined;askReadingOnLeave=undefined;skipNextAskRefresh=false;askScopeUnavailable=true;askPendingInput=undefined;
  askView='conversation';askSubmittedQuestion='';renderAsk();void askAction(()=>loadAskConversation(id));
}
const askCall = async <T>(command: import('./ask').AskCommand, input?: Parameters<typeof desktopApi.ask>[1]): Promise<T> => {
  const generation = askGeneration;
  try { return await desktopApi.ask(command, input) as T; }
  catch (error) {
    if (generation === askGeneration && ['conversation', 'history', 'runs', 'run'].includes(command)) { askScopeUnavailable = true; renderAsk(); }
    throw error;
  }
};
function failedAskQuestion():string|undefined{const last=askConversation?.turns.at(-1);return askRun?.status==='failed'&&askSubmittedQuestion?askSubmittedQuestion:last?.status==='failed'?last.question:undefined;}
function askControls(): void {
  const running = askRun?.status === 'running';
  workbenchUi.setBusy(askBusy||Boolean(running)||Boolean(askPendingInput));
  byId<HTMLButtonElement>('ask-send').disabled = askBusy || running || Boolean(askPendingInput) || Boolean(askRestoringConversationId) || !currentStatus?.config.tokenConfigured || Boolean(currentStatus.config.authSignedOut) || !readInput('ask-question').trim();
  byId('ask-draft-state').textContent=readInput('ask-question').trim()?moteText('未发送 · 此窗口中的草稿'):'';
  byId('ask-resume-current').hidden=askView!=='history'||!askPendingInput&&!running;
  byId('ask-refresh').hidden=askView==='history'&&!byId('ask-error').textContent;
  byId<HTMLButtonElement>('ask-new').disabled = askBusy || running || Boolean(askPendingInput);
  byId<HTMLButtonElement>('ask-login').disabled = askBusy;
  byId<HTMLButtonElement>('ask-logout').disabled = askBusy;
  byId('ask-edit-failed').hidden=askBusy||running||Boolean(askPendingInput)||!failedAskQuestion();
  byId('ask-stop').hidden = !running;byId<HTMLButtonElement>('ask-stop').disabled=askBusy||askStopPending;
  byId('ask-pending').hidden=!askPendingInput&&!askStopPending&&!askRunLookupPending;
  byId('ask-pending-original').textContent=askPendingInput?.question??'';
  byId('ask-pending-message').textContent=askPendingMessage||(askRunLookupPending?moteText('请刷新检查结果，避免重复发送。'):askStopPending?moteText('停止结果尚未确认。'):moteText('结果尚未确认，请检查或重试原请求。'));
  byId<HTMLButtonElement>('ask-check-existing').disabled=askBusy;byId<HTMLButtonElement>('ask-retry-existing').disabled=askBusy;byId('ask-retry-existing').hidden=!askPendingInput;
  byId<HTMLButtonElement>('ask-turns-more').disabled = askBusy || running;
  byId('ask-turns-more').hidden = !askConversation?.nextCursor;
  for (const button of Array.from(byId('ask-history').querySelectorAll('button'))) button.disabled = askBusy || running || Boolean(askPendingInput);
}
function renderAsk(): void {
  byId('ask-title').hidden=askView!=='history';byId('ask-back').hidden=askView==='history';
  byId('ask-history-panel').hidden=askView!=='history';byId('ask-conversation-panel').hidden=askView==='history';
  byId('ask-conversation-title').textContent=askConversation?.title??'';byId('ask-conversation-title').hidden=!askConversation;
  byId('ask-fresh').hidden=Boolean(askConversation||askRun);
  byId<HTMLTextAreaElement>('ask-question').placeholder=askConversation?moteText('接着问…'):moteText('想找回什么？');
  const renderedConversation=askConversation;
  const referenceTitles=new Map((renderedConversation?.turns??[]).flatMap(turn=>turn.evidenceDeleted?[]:turn.result?.citations??[]).map(citation=>[citation.id,citation.appName]));
  byId('ask-scope').replaceChildren(renderAskScope(document, renderedConversation?.scope, id => void askAction(() => openAskEvidence(id,renderedConversation)), askScopeUnavailable,referenceTitles));
  const messages = byId('ask-messages'); messages.replaceChildren();
  for (const [index,turn] of (askConversation?.turns ?? []).entries()) {
    const article = document.createElement('article'), question = document.createElement('h3');
    article.dataset.askTurn=turn.id;
    question.textContent = turn.question;question.hidden=index===0&&askConversation?.title===turn.question;
    const openEvidence = (id: string) => void askAction(() => openAskEvidence(id,renderedConversation,turn.id));
    const citations=turn.evidenceDeleted?[]:turn.result?.citations??[];
    article.append(question, renderAskAnswer(document, turn.evidenceDeleted?moteText('内容已按隐私要求清除。'):turn.result?.answer ?? moteText('回答未完成'),citations,openEvidence));
    if(!turn.evidenceDeleted&&turn.error)appendDiagnostic(article,JSON.stringify(turn.error,null,2));
    if(!turn.evidenceDeleted&&(turn.evidenceUnavailable||turn.evidenceStale)){const notice=document.createElement('p');notice.className='ask-history-note';notice.textContent=turn.evidenceUnavailable?moteText('引用原文已删除，历史问答仍保留。'):moteText('这是历史版本，当前资料已更新。');article.append(notice);}
    if(citations.length){const list=document.createElement('div');list.className='ask-references';const label=document.createElement('p');label.textContent=moteText('依据');list.append(label);citations.forEach((citation,index)=>list.append(renderAskCitation(document,citation,openEvidence,index+1)));article.append(list);}
    messages.append(article);
  }
  if(askRun?.status==='running'&&askSubmittedQuestion){const pending=document.createElement('article'),question=document.createElement('h3');question.textContent=askSubmittedQuestion;pending.append(question);messages.append(pending);}
  setText('ask-progress', !askRun ? '' : askRun.status === 'running'&&askRunLookupPending?moteText('请刷新检查结果，避免重复发送。'):askRun.status === 'running'&&askStopPending?moteText('正在停止，等待中央确认…'):askRun.status === 'running' ? moteText('正在读取资料') : askRun.status === 'cancelled' ? moteText('已停止回答') : askRun.status === 'failed' ? moteText('回答未完成') : moteText('回答已完成'));
  if(askRun&&(askRun.error||askRun.events?.length))appendDiagnostic(byId('ask-progress'),JSON.stringify({id:askRun.id,status:askRun.status,error:askRun.error,events:askRun.events},null,2));
  askControls();
}
function askFailure(error:unknown):void{const message=askView==='history'?moteText('对话暂不可读取，请稍后重试。'):askPendingInput||askRunLookupPending||askStopPending?moteText('请刷新检查结果，避免重复发送。'):moteText('请求失败，请重试');renderReadableFailure(byId('ask-error'),message,error instanceof Error?error.message:String(error));}
async function loadAskConversation(id: string): Promise<void> {
  const generation = askGeneration;
  const reading=askRestoringConversationId===id?askRestoringReading:undefined;
  let conversation = await askCall<import('./ask').AskConversation>('conversation', {id});
  if(generation!==askGeneration)return;
  if(conversation.id!==id)throw Error(moteText('对话状态已变化，请重新读取后继续。'));
  const seen=new Set<string>();
  while(reading?.oldestTurnId&&!conversation.turns.some(turn=>turn.id===reading.oldestTurnId)&&conversation.nextCursor){
    if(generation!==askGeneration)return;
    const cursor=conversation.nextCursor;if(seen.has(cursor))throw Error(moteText('对话状态已变化，请重新读取后继续。'));seen.add(cursor);
    const older=await askCall<import('./ask').AskConversation>('conversation',{id,cursor});
    if(generation!==askGeneration)return;
    conversation=prependConversationTurns(conversation,older);
  }
  if (generation !== askGeneration) return;
  if(reading?.oldestTurnId&&!conversation.turns.some(turn=>turn.id===reading.oldestTurnId))throw Error(moteText('对话状态已变化，请重新读取后继续。'));
  askConversation = conversation;if(askRestoringConversationId===id){askRestoringConversationId=undefined;askRestoringReading=undefined;}askScopeUnavailable = false; renderAsk();
  if(reading){
    pageScroll.set('ask',reading.scrollY);askReadingOnLeave=reading;
    if(currentPage!=='ask')skipNextAskRefresh=true;
    else restoreAskReadingPosition(reading,conversation,generation);
  }
}
async function olderAskTurns(): Promise<void> {
  const current = askConversation, generation = askGeneration;
  if (!current?.nextCursor) return;
  const page = await askCall<import('./ask').AskConversation>('conversation', {id: current.id, cursor: current.nextCursor});
  if (generation !== askGeneration || askConversation !== current) return;
  try { askConversation = prependConversationTurns(current, page); }
  catch (error) { askScopeUnavailable = true; renderAsk(); throw error; }
  askScopeUnavailable = false; renderAsk();
}
async function askHistory(append = false): Promise<void> {
  const generation = askGeneration;
  const page = await askCall<{items: RecentConversation[]; nextCursor?: string}>('history', append && askCursor ? {cursor: askCursor} : undefined);
  if (generation !== askGeneration) return;
  if(!append)workbenchUi.setHistory(page.items);
  const history = byId('ask-history'); if (!append) history.replaceChildren();
  for (const item of page.items) {
    const button=document.createElement('button');button.type='button';button.className='home-conversation';button.dataset.conversationId=item.id;
    const icon=document.createElement('span');icon.className='home-conversation-icon';icon.setAttribute('aria-hidden','true');icon.textContent='◌';
    const copy=document.createElement('span'),title=document.createElement('strong'),meta=document.createElement('small'),arrow=document.createElement('span');title.textContent=item.title;const details:string[]=[];
    if(item.turnCount!==undefined)details.push(moteText('{0} 轮对话',item.turnCount));if(item.updatedAt&&Number.isFinite(Date.parse(item.updatedAt)))details.push(new Date(item.updatedAt).toLocaleString(getLocale(),{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}));
    meta.textContent=details.join(' · ');copy.append(title,meta);arrow.className='chevron';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';button.append(icon,copy,arrow);
    button.addEventListener('click',()=>{if(askBusy||askPendingInput||askRun?.status==='running')return;const switching=(askConversation?.id??askRestoringConversationId)!==item.id;if(switching&&!mayReplaceAskDraft(''))return;if(switching){byId<HTMLTextAreaElement>('ask-question').value='';askPendingInput=undefined;askSubmittedQuestion='';askRestoringReading=undefined;}askView='conversation';void askAction(async()=>{if(switching){askConversation=undefined;askRun=undefined;}askRestoringConversationId=item.id;askScopeUnavailable=true;renderAsk();await loadAskConversation(item.id);});});
    history.append(button);
  }
  if(!history.children.length){const empty=document.createElement('p');empty.className='home-empty';empty.textContent=moteText('还没有对话');history.append(empty);}
  askCursor = page.nextCursor; byId('ask-more').hidden = !askCursor; askControls();
}
async function askAction(action: () => Promise<void>): Promise<void> {
  if (askBusy) return; const generation=askGeneration;askBusy = true; askControls(); setText('ask-error', '');
  try { await action(); } catch (error) { if(generation===askGeneration){if(askPendingInput)askPendingMessage='';askFailure(error);} }
  finally { askBusy = false; askControls();maybeRestoreAskConversation(); }
}
async function refreshAsk(): Promise<void> {
  if(askPendingInput){askView='conversation';renderAsk();await askAction(checkPendingAsk);return;}
  const connected = askConnectionState();
  if (!connected) {
    clearTimeout(askTimer);
    setText('ask-login-status', ''); setText('ask-error', '');
    return;
  }
  if(askRestoringConversationId){const id=askRestoringConversationId;await askAction(()=>loadAskConversation(id));return;}
  await askAction(async () => {
    const generation=askGeneration;
    setText('ask-login-status', moteText('正在连接中央…'));
    try { await askHistory(); } catch (error) { if(generation===askGeneration)setText('ask-login-status', moteText('请求失败，请重试')); throw error; }
    if(generation!==askGeneration)return;
    setText('ask-login-status', moteText('已登录 · {0}', currentStatus.config.serverUrl));
    const page = await askCall<{items: import('./ask').AskRun[]}>('runs');
    if(generation!==askGeneration)return;
    if(!askRun)askRun=page.items.find(item=>item.status==='running');
    if (askRun?.status==='running'&&askRun.conversationId) {askView='conversation';await loadAskConversation(askRun.conversationId);}
    else if (askConversation) await loadAskConversation(askConversation.id);
    if(generation!==askGeneration)return;
    renderAsk(); if (askRun?.status === 'running') scheduleAskPoll();
  });
}
async function refreshAskStatus():Promise<void>{const previous=currentStatus;const next=await desktopApi.status();if(currentStatus===previous)render(next);}
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
      if (generation !== askGeneration) return;if(run.notFound){askRunLookupPending=true;askPendingMessage=moteText('请刷新检查结果，避免重复发送。');renderAsk();return;}askRun = run;askRunLookupPending=false;if(run.status!=='running')askStopPending=false;
      if (run.status !== 'running' && run.conversationId) {
        const conversation = await askCall<import('./ask').AskConversation>('conversation', {id: run.conversationId});
        if (generation !== askGeneration) return; askConversation = conversation; askScopeUnavailable = false; await askHistory();if(generation!==askGeneration)return;
      }
      setText('ask-error', ''); renderAsk();
      if (run.status === 'running') scheduleAskPoll();
    } catch (error) { if (generation !== askGeneration) return; askFailure(error); if (askRun?.status === 'running') scheduleAskPoll(); }
  }, 1000);
}
byId('ask-form').addEventListener('submit', event => {
  event.preventDefault(); if (askBusy || askPendingInput || askRun?.status === 'running' || askRestoringConversationId || !currentStatus?.config.tokenConfigured || currentStatus.config.authSignedOut) return;
  const question = readInput('ask-question').trim(); if (!question) return;
  void askAction(async () => {
    const generation=askGeneration;
    const input = askPendingInput?.question === question && askPendingInput.conversationId === askConversation?.id ? askPendingInput : {id: crypto.randomUUID(), question, ...(askConversation ? {conversationId: askConversation.id} : {})};
    askPendingInput = input;askPendingMessage=moteText('正在提交问题…');askSubmittedQuestion=question;askRun=undefined;askStopPending=false;askRunLookupPending=false;renderAsk();
    let admitted:import('./ask').AskRun;try { admitted = await askCall('start', input); }
    catch (error) { if(generation!==askGeneration)throw error;admitted = await askCall('start', input); } // Same admission ID after an ambiguous network response.
    if(generation!==askGeneration)return;
    await acceptPendingAsk(input,admitted);
  });
});
byId('ask-refresh').addEventListener('click', () => void refreshAsk());
byId('ask-more').addEventListener('click', () => void askAction(() => askHistory(true)));
byId('ask-turns-more').addEventListener('click', () => void askAction(olderAskTurns));
async function acceptPendingAsk(input:NonNullable<typeof askPendingInput>,run:import('./ask').AskRun):Promise<void>{
  const generation=askGeneration;
  if(askPendingInput!==input)return;askRun=run;askSubmittedQuestion=input.question;askPendingInput=undefined;askPendingMessage='';askStopPending=false;askRunLookupPending=false;
  if(readInput('ask-question').trim()===input.question)byId<HTMLTextAreaElement>('ask-question').value='';
  renderAsk();if(run.conversationId)await loadAskConversation(run.conversationId);if(generation!==askGeneration)return;if(run.status==='running')scheduleAskPoll();else await askHistory();
}
async function checkPendingAsk():Promise<void>{
  const input=askPendingInput,id=input?.id??(askStopPending||askRunLookupPending?askRun?.id:undefined),generation=askGeneration;if(!id)return;
  askPendingMessage=moteText('正在检查结果…');askControls();const run=await askCall<import('./ask').AskRun>('run',{id});if(generation!==askGeneration||input&&askPendingInput!==input)return;
  if(run.notFound){askRunLookupPending=!input;askPendingMessage=input?moteText('尚未找到这次提交；可以用原请求重试。'):moteText('请刷新检查结果，避免重复发送。');askControls();return;}
  if(input)await acceptPendingAsk(input,run);else if(askRun?.id===id){askRun=run;askStopPending=false;askRunLookupPending=false;askPendingMessage='';renderAsk();if(run.conversationId)await loadAskConversation(run.conversationId);if(generation!==askGeneration)return;if(run.status==='running')scheduleAskPoll();}
}
byId('ask-edit-failed').addEventListener('click',()=>{const question=failedAskQuestion();if(!question||askBusy||askPendingInput||askRun?.status==='running')return;if(readInput('ask-question').trim()&&readInput('ask-question')!==question&&!window.confirm(moteText('将失败问题带回输入框，会替换当前草稿。继续？')))return;byId<HTMLTextAreaElement>('ask-question').value=question;askControls();byId('ask-question').focus();});
byId('ask-check-existing').addEventListener('click',()=>void askAction(checkPendingAsk));
byId('ask-retry-existing').addEventListener('click',()=>void askAction(async()=>{const input=askPendingInput,generation=askGeneration;if(input){const run=await askCall<import('./ask').AskRun>('start',input);if(generation===askGeneration)await acceptPendingAsk(input,run);}}));
byId('ask-stop').addEventListener('click', () => void askAction(async () => { if(!askRun||askStopPending)return;const id=askRun.id,generation=askGeneration;askStopPending=true;askPendingMessage='';renderAsk();const run=await askCall<import('./ask').AskRun>('cancel',{id});if(generation!==askGeneration||askRun?.id!==id)return;askRun=run;askRunLookupPending=false;askStopPending=run.status==='running';renderAsk();scheduleAskPoll(); }));
byId('ask-new').addEventListener('click', () => { if (askBusy || askPendingInput || askRun?.status === 'running'||!mayReplaceAskDraft('')) return; askGeneration++; clearTimeout(askTimer); askRun = undefined; askConversation = undefined;askRestoringConversationId=undefined;askRestoringReading=undefined; askScopeUnavailable = false;askPendingInput=undefined;askSubmittedQuestion='';askView='conversation';byId<HTMLTextAreaElement>('ask-question').value='';renderAsk();byId('ask-question').focus(); });
byId('ask-resume-current').addEventListener('click',()=>{askView='conversation';renderAsk();});
byId('ask-back').addEventListener('click',()=>{askView='history';renderAsk();void askAction(()=>askHistory());});
byId('ask-question').addEventListener('input',askControls);
const askReferenceDialog=byId<HTMLDialogElement>('ask-reference-dialog');
byId('ask-reference-back').addEventListener('click',()=>askReferenceDialog.close());
async function openAskEvidence(id:string,rendered:import('./ask').AskConversation|undefined,turnId?:string):Promise<void>{
  if(!rendered||askConversation!==rendered||currentPage!=='ask')return;
  const conversationId=rendered.id,generation=askGeneration;
  const current=()=>generation===askGeneration&&askConversation===rendered&&currentPage==='ask';
  if(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/.test(id)){await desktopApi.openCentral('ask',id,conversationId);return;}
  const unavailable=(message:string)=>{byId('ask-reference-message').textContent=message;if(!askReferenceDialog.open)askReferenceDialog.showModal();};
  const result=await askCall<{id:string;available:boolean}>('reference',{id,conversationId});
  if(!current())return;
  if(result.id!==id)throw Error(moteText('对话状态已变化，请重新读取后继续。'));
  if(!result.available){unavailable(moteText('引用原文已删除，历史问答仍保留。'));return;}
  if(turnId){
    const retained=await currentTurnCites(conversationId,turnId,id,cursor=>askCall('conversation',{id:conversationId,...(cursor?{cursor}:{})}),current);
    if(!current())return;
    if(!retained){unavailable(moteText('原始轮次暂不可读。'));return;}
  }
  await desktopApi.openCentral('ask',id,conversationId);
}
byId('ask-login').addEventListener('click', () => { const token = readInput('ask-token'); byId<HTMLInputElement>('ask-token').value = ''; void askAction(async () => { setText('ask-login-status', moteText('正在连接中央…')); try { await askCall('login', {token,durationMs:Number(readInput('ask-lifetime'))}); } catch (error) { setText('ask-login-status', moteText('先登录中央，各页面会共用这次登录')); throw error; } await refreshAskStatus();setText('ask-login-status', moteText('已登录 · {0}', currentStatus.config.serverUrl));if(!askRestoringConversationId&&!askPendingInput&&!askRun)await askHistory(); }); });
byId('ask-browser-login').addEventListener('click',()=>void askAction(async()=>{await askCall('login-browser',{durationMs:Number(readInput('ask-lifetime'))});await refreshAskStatus();if(!askRestoringConversationId&&!askPendingInput&&!askRun)await askHistory();setText('ask-login-status',moteText('已登录 · {0}',currentStatus.config.serverUrl));}));
byId('ask-logout').addEventListener('click', () => void askAction(async () => { await askCall('logout');await refreshAskStatus();setText('ask-login-status', moteText('已退出中央登录')); }));
