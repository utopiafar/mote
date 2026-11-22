import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';

const source = new URL('../src/', import.meta.url).pathname;
const read = (name: string) => readFileSync(join(source, name), 'utf8');
function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const cssFiles = walk(source).filter(path => path.endsWith('.css'));
const allCss = cssFiles.map(path => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');

/** Class names used by the retired Home, feature directory, Ask page and
 * conversation list. The list is extracted from the JSX at the commits before
 * each page was removed (NV3 bdcc3c40, CH1 82c69431, CH3 d0d25517), then
 * filtered against current render points. The current source no longer renders
 * any of them; in particular `suggestions` survives only as a review data
 * field, not as a class name. `failed` was only applied to the retired
 * conversation list item and old conversation turn; the current chat reports
 * failures with `chat-message-status`. Keep this list complete when retiring a
 * page. */
const retiredClasses = `answer-panel central-first-actions central-first-data central-first-original central-first-steps central-first-use central-onboarding central-overview chat-section-icon chat-section-title composer-hint conversation-add-reference conversation-delete-confirm conversation-fresh conversation-history conversation-history-heading conversation-item-meta conversation-item-row conversation-more conversation-more-list conversation-page-status conversation-toolbar conversation-turn-error discovery-source-boundary discovery-spinner evidence-conversations failed failed-answer failed-answer-icon feature-guide final-conversation first-question-duplicate first-use-actions first-use-failure first-use-heading first-use-kicker first-use-later first-use-original first-use-received first-use-record first-use-record-meta first-use-stages ghost guide-empty guide-group guide-groups guide-heading guide-return guide-search history-open home-action-entry home-agent-icon home-agent-layers home-agent-view home-assistant home-assistant-actions home-assistant-activity-note home-assistant-body home-assistant-card home-assistant-conversation home-assistant-destination home-assistant-destination-link home-assistant-entry home-assistant-goal home-assistant-group home-assistant-history home-assistant-meta home-assistant-overview home-assistant-proof home-assistant-status-list home-assistant-task home-assistant-tools home-conversation-row home-conversations home-discovery home-discovery-copy home-discovery-label home-empty home-extensions home-find home-heading home-heading-meta home-insight home-material-copy home-material-excerpt home-material-icon home-material-list home-material-row home-owner-question home-page home-read-error home-recent home-run-link home-section-actions home-source-issue home-summary model-notice new-conversation-button node-button node-state query-admission-status query-unconfirmed run-link-label settings-nav sidebar-bottom step-number suggestions workspace-node-menu`.split(/\s+/);

test('PF5-01 retired page classes are absent from every stylesheet', () => {
  const found = retiredClasses.filter(name => new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(allCss));
  assert.deepEqual(found, []);
  assert.equal(cssFiles.some(path => path.endsWith('/feature-guide.css')), false);
});

test('PF5-02 the chat route imports the base and chat styles only', () => {
  const main = read('main.tsx');
  const styleImports = [...main.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)].map(match => match[1]);
  assert.deepEqual(styleImports, ['./styles.css']);
  const base = read('styles.css');
  const baseImports = [...base.matchAll(/^@import\s+['"]([^'"]+)['"];?$/gm)].map(match => match[1]);
  assert.deepEqual(baseImports, ['./design-tokens.css']);
  const ask = read('plugins/ask/index.tsx');
  assert.match(ask, /conversation-final\.css/);
  const chat = read('plugins/ask/Conversations.tsx');
  assert.match(chat, /chat\.css/);
  for (const name of ['library.css','settings-ui.css','plugin-center.css','discovery-ui.css','imports-final.css','activity-final.css','actions-final.css','device-workspace.css','agent-final.css','memory-presentation.css','source-workspace.css']) {
    assert.equal(ask.includes(name), false, name);
  }
});

test('PF5-02 page-specific rules stay out of the base package', () => {
  const base = read('styles.css');
  const retiredPageSelectors = /\[data-page=(?:about|localPreferences|help|overview|ask)\]/;
  assert.doesNotMatch(base, retiredPageSelectors);
  for (const marker of ['.final-settings-directory','.settings-directory-','.web-preference','.connections {','.connections{','.library-archive','.material-reader-ask','.insight-automatic-dialog']) {
    assert.equal(base.includes(marker), false, marker);
  }
  const settings = read('settings-ui.css');
  assert.match(settings, /\.content\[data-page=about\]/);
  assert.match(settings, /\.final-settings-directory \.settings-directory-group/);
  assert.match(settings, /\.settings-directory-rows>button/);
  assert.match(settings, /\.web-preferences select/);
  const library = read('library.css');
  assert.match(library, /\.library-archive:has\(/);
  assert.match(library, /\.material-reader-ask/);
  const discovery = read('discovery-final.css');
  assert.match(discovery, /\.insight-automatic-dialog \.conversation-dialog/);
  const sources = read('source-workspace.css');
  assert.match(sources, /\.connections \{/);
});

test('PF5-04 first-screen CSS source bytes are below the pre-consolidation total', () => {
  const before = 581677;
  const after = ['styles.css','design-tokens.css','conversation-final.css','plugins/ask/chat.css']
    .reduce((total, name) => total + Buffer.byteLength(read(name)), 0);
  assert.ok(after < before, `${after} < ${before}`);
  assert.ok(after < before * 0.4, `${after} < 40% of ${before}`);
});
