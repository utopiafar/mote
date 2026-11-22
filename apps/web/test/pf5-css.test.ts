import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import cssPolicy from './pf5-css-policy.cjs';

const {pageRulesInBase, retiredPageRules, selectors} = cssPolicy;
const source = new URL('../src/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, source), 'utf8');
const stylesheets = readdirSync(source, {recursive: true}).filter(name => name.endsWith('.css'));

function imports(css: string) {
  return [...css.matchAll(/^@import\s+['"]([^'"]+)['"];\s*$/gm)].map(match => match[1]);
}

const baseStylesheets = ['styles.css', 'design-tokens.css'];
const chatStylesheet = 'chat-page.css';

test('PF5-01 retired page classes are absent from every stylesheet', () => {
  const found = stylesheets.flatMap(file => retiredPageRules(read(file)).map(rule => `${file}: ${rule}`));
  assert.deepEqual(found, []);
  assert.equal(stylesheets.some(file => file.endsWith('feature-guide.css')), false);
});

test('PF5-01 retired classes are detected in selector lists and CSS escapes', () => {
  assert.deepEqual(retiredPageRules(String.raw`
    @media (pointer:coarse) { .button, :is(.tabs, .\69 nsight-source) { color:red } }
    [class~="MODEL-USED" i] { color:red }
    .button[data-message="mote:insight-source"] { color:red }
  `), [
    '.tabs in :is(.tabs, .\\69 nsight-source)',
    '.insight-source in :is(.tabs, .\\69 nsight-source)',
    '.model-used in [class~="MODEL-USED" i]',
  ]);
});

test('PF5-02 the shell imports the base and loads one chat stylesheet on demand', () => {
  const main = read('main.tsx');
  const styleImports = [...main.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)].map(match => match[1]);
  assert.deepEqual(styleImports, ['./styles.css']);
  assert.deepEqual(imports(read('styles.css')), ['./design-tokens.css']);
  assert.match(main, /await import\('\.\/chat-page\.css'\)/);
  assert.match(main, /page==='ask'&&status&&<ChatStyles\/>/);
  assert.match(main, /await import\('\.\/settings-surface\.css'\)/);
  assert.match(main, /settingsContext&&<SettingsSurfaceStyles\/>/);
  assert.deepEqual(imports(read(chatStylesheet)), ['./conversation-final.css', './plugins/ask/chat.css']);
});

test('PF5-02 selectors in the base belong to the shell and shared components', () => {
  const found = baseStylesheets.flatMap(file => pageRulesInBase(read(file)).map(rule => `${file}: ${rule}`));
  assert.deepEqual(found, []);
});

test('PF5-02 a shared class cannot bring page-only roles, data attributes or states into the base', () => {
  const reportChoice = '.report-more-menu > [role = "menuitemradio"]';
  const checkedMark = '.report-more-menu>:is([aria-checked=true], [role=menuitemradio])::before';
  const pageLayout = '.content[data-page=about]';
  const questionSelected = '.conversation-item.active';
  const unscopedMenu = '.report-more-menu [role=menuitem]';
  assert.deepEqual(pageRulesInBase(`
    .reader-menu [role="menuitem"]:focus-visible, .sidebar [aria-current=page] { color:red }
    .topbar, ${reportChoice}, ${checkedMark} { color:red }
    @media (pointer:coarse) { ${reportChoice} { min-height:44px } }
    ${pageLayout}, ${questionSelected}, ${unscopedMenu} { color:red }
    @container (max-width:260px) { .button { white-space:normal } }
  `), [reportChoice, checkedMark, reportChoice, pageLayout, questionSelected, unscopedMenu, '@container (max-width:260px)']);
});

test('PF5-02 page selectors live with the stylesheet loaded by their surfaces', () => {
  const pageStyles = {
    'activity-final.css': ['.activity-detail .page-heading h1', '.settings-heading'],
    'discovery-final.css': ['.insight-automatic-dialog .conversation-dialog', '.report-top-tools .report-more-menu',
      '.report-more-menu>[role=menuitemradio]', '.report-more-menu>[role=menuitemradio]:hover',
      '.report-more-menu>[role=menuitemradio]:focus-visible', '.report-more-menu>[role=menuitemradio]:before',
      '.report-more-menu>[aria-checked=true]:before'],
    'discovery-ui.css': ['.discovery-inline-guidance .text-button'],
    'home-search-questions.css': ['.search-workspace .library-record'],
    'library.css': ['.capture-card', '.library-record', '.material-reader-ask'],
    'memory-presentation.css': ['.memory-actions', '.execution-queue-overview p'],
    'model-settings.css': ['.model-settings-fields', '.model-settings-editor .preference-field textarea'],
    'notes.css': ['.notes-grid', '.notes-history'],
    'owner-maintenance.css': ['.log-pagination', '.diagnostics-panel'],
    'owner-question-final.css': ['.conversation-item.active'],
    'plugin-center.css': ['.feature-inventory code', '.provider-list'],
    'processing.css': ['.processing-list', '.processing-row'],
    'recording-final.css': ['.file-detail.recording-view', '.recording-dialog', '.recording-raw-line', '.file-diarization-selection'],
    'settings-surface.css': ['.settings-surface .panel'],
    'settings-ui.css': ['.content[data-page=about]', '.final-settings-directory .settings-directory-group', '.settings-directory-rows>button', '.settings-heading', '.settings-locations', '.settings-destinations', '.web-preferences select', '.preference-toggle input:checked'],
    'source-connectors-final.css': ['.lark-settings', '.lark-range'],
    'source-workspace.css': ['.connections'],
  };
  for (const [file, required] of Object.entries(pageStyles)) {
    const owned = new Set(selectors(read(file)));
    for (const selector of required) assert.ok(owned.has(selector), `${file}: ${selector}`);
  }
  assert.ok(selectors(read('library.css')).some(selector => selector.startsWith('.library-archive:has(')));
  assert.match(read('discovery-final.css'), /@media\s*\(pointer:coarse\)\s*\{\s*\.report-more-menu>\[role=menuitemradio\]\s*\{min-height:44px\}/);
  const shared = new Set(selectors(read('styles.css')));
  for (const selector of ['.report-more-menu', '.reader-menu [role=menuitem]', '.conversation-dialog-backdrop', '.model-selector']) {
    assert.ok(shared.has(selector), `styles.css: ${selector}`);
  }
});

test('PF5-04 first-screen source CSS is below 40% of the pre-consolidation total', () => {
  const before = 581_677;
  const loadedSources = [...baseStylesheets, chatStylesheet, ...imports(read(chatStylesheet))];
  const after = loadedSources.reduce((total, name) => total + Buffer.byteLength(read(name)), 0);
  assert.ok(after < before, `${after} < ${before}`);
  assert.ok(after < before * 0.4, `${after} < 40% of ${before}`);
});
