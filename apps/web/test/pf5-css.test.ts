import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import cssPolicy from './pf5-css-policy.cjs';

const {classNames, pageRulesInBase, selectors} = cssPolicy;
const source = new URL('../src/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, source), 'utf8');
const stylesheets = readdirSync(source, {recursive: true}).filter(name => name.endsWith('.css'));

// Rendered class names from the Home, feature directory, old Ask and dialogue
// history, including older revisions before removal. Classes with live render
// sites (for example those in AssistantGuide or the new chat) are excluded.
const retiredClasses = new Set([
  // Home (Overview, FirstUseHome and plug-in contributions)
  `art-center art-desktop art-file art-node art-phone
  central-first-actions central-first-data central-first-original central-first-steps central-first-use
  central-issue central-onboarding central-overview central-status-grid compact-stats completed
  device-icon discovery-ai-actions discovery-intake discovery-intake-card discovery-intake-grid
  discovery-intake-heading discovery-source-boundary discovery-spinner discovery-workspace-hints
  first-device first-device-actions first-record first-use-actions first-use-failure first-use-heading
  first-use-kicker first-use-later first-use-original first-use-received first-use-record
  first-use-record-meta first-use-stages ghost greeting-mark home-action home-action-entry home-actions
  home-agent-icon home-agent-layers home-agent-view home-archive-intro home-assistant
  home-assistant-actions home-assistant-activity-note home-assistant-body home-assistant-card
  home-assistant-conversation home-assistant-destination home-assistant-destination-link
  home-assistant-entry home-assistant-goal home-assistant-group home-assistant-history
  home-assistant-meta home-assistant-overview home-assistant-proof home-assistant-status-list
  home-assistant-task home-assistant-tools home-conversation-row home-conversations home-device-link
  home-discovery home-discovery-copy home-discovery-label home-empty home-extensions home-find
  home-heading home-heading-meta home-insight home-library-layout home-material-copy
  home-material-excerpt home-material-icon home-material-list home-material-row home-owner-question
  home-page home-purpose-actions home-question home-read-error home-recent home-record-list
  home-retrieval home-run-link home-secondary home-section-actions home-side home-source-issue
  home-summary initial-loading library-home onboarding-panel orbit orbit-one orbit-two primary-action
  recent-section run-link-label setup-steps stat-link step-number welcome-art`,
  // FeatureGuide and its former shell entries
  `feature-guide guide-actions guide-advanced guide-condition guide-empty guide-footer guide-group
  guide-group-details guide-group-heading guide-group-links guide-groups guide-heading guide-index-number
  guide-model-start guide-model-steps guide-model-terms guide-notes guide-path guide-primary-link
  guide-quick-links guide-related guide-return guide-search guide-section guide-section-heading
  guide-section-nav guide-setting-note guide-setup guide-start guide-text-link guide-unit-links
  guide-unit-purpose guide-where node-button node-state settings-nav sidebar-bottom workspace-node-menu`,
  // Ask, the multi-conversation list and the former reference picker
  `answer-panel chat-section-icon chat-section-title composer-hint conversation-add-reference
  conversation-delete-confirm conversation-fresh conversation-history conversation-history-heading
  conversation-item-meta conversation-item-row conversation-more conversation-more-list
  conversation-page-status conversation-toolbar conversation-turn-error evidence-conversations failed
  failed-answer failed-answer-icon final-conversation first-question-duplicate history-open model-notice
  new-conversation-button query-admission-status query-unconfirmed suggestions`,
].flatMap(group => group.split(/\s+/)));

function imports(css: string) {
  return [...css.matchAll(/^@import\s+['"]([^'"]+)['"];\s*$/gm)].map(match => match[1]);
}

const baseStylesheets = ['styles.css', 'design-tokens.css'];
const chatStylesheet = 'chat-page.css';

test('PF5-01 retired page classes are absent from every stylesheet', () => {
  const found = stylesheets.flatMap(file => selectors(read(file)).flatMap(selector =>
    classNames(selector).filter(name => retiredClasses.has(name)).map(name => `${file}: .${name} in ${selector}`),
  ));
  assert.deepEqual(found, []);
  assert.equal(stylesheets.some(file => file.endsWith('feature-guide.css')), false);
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

test('PF5-02 page selectors live with the stylesheet loaded by their surfaces', () => {
  const pageStyles = {
    'activity-final.css': ['.activity-detail .page-heading h1', '.settings-heading'],
    'discovery-final.css': ['.insight-automatic-dialog .conversation-dialog'],
    'home-search-questions.css': ['.search-workspace .library-record'],
    'library.css': ['.capture-card', '.library-record', '.material-reader-ask'],
    'memory-presentation.css': ['.memory-actions', '.execution-queue-overview p'],
    'model-settings.css': ['.model-settings-fields', '.model-settings-editor .preference-field textarea'],
    'notes.css': ['.notes-grid', '.notes-history'],
    'owner-maintenance.css': ['.log-pagination', '.diagnostics-panel'],
    'plugin-center.css': ['.feature-inventory code', '.provider-list'],
    'processing.css': ['.processing-list', '.processing-row'],
    'settings-surface.css': ['.settings-surface .panel'],
    'settings-ui.css': ['.content[data-page=about]', '.final-settings-directory .settings-directory-group', '.settings-directory-rows>button', '.settings-heading', '.settings-locations', '.settings-destinations', '.web-preferences select'],
    'source-connectors-final.css': ['.lark-settings', '.lark-range'],
    'source-workspace.css': ['.connections'],
  };
  for (const [file, required] of Object.entries(pageStyles)) {
    const owned = new Set(selectors(read(file)));
    for (const selector of required) assert.ok(owned.has(selector), `${file}: ${selector}`);
  }
  assert.ok(selectors(read('library.css')).some(selector => selector.startsWith('.library-archive:has(')));
});

test('PF5-04 first-screen source CSS is below 40% of the pre-consolidation total', () => {
  const before = 581_677;
  const loadedSources = [...baseStylesheets, chatStylesheet, ...imports(read(chatStylesheet))];
  const after = loadedSources.reduce((total, name) => total + Buffer.byteLength(read(name)), 0);
  assert.ok(after < before, `${after} < ${before}`);
  assert.ok(after < before * 0.4, `${after} < 40% of ${before}`);
});
