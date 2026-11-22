import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import ts from 'typescript';
import cssPolicy from './pf5-css-policy.cjs';

const {baseRuleInventory, baseRuleKeys, pageRulesInBase, retiredPageRules, selectors} = cssPolicy;
const source = new URL('../src/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, source), 'utf8');
const sourceFiles = readdirSync(source, {recursive: true});
const stylesheets = sourceFiles.filter(name => name.endsWith('.css'));

function templateText(node: ts.Node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(span => 'fixture-value' + span.literal.text).join('');
  }
}

function inlineStyles(file: string, text: string) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const values = new Map<string, string>();
  const expressions: ts.Expression[] = [];
  const styles: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = templateText(node.initializer);
      if (value !== undefined) values.set(node.name.text, value);
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'style') {
      for (const child of node.children) {
        if (ts.isJsxText(child)) styles.push(child.text);
        if (ts.isJsxExpression(child) && child.expression) expressions.push(child.expression);
      }
    }
    const literal = templateText(node);
    if (literal?.includes('<style')) {
      for (const match of literal.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styles.push(match[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const expression of expressions) {
    const css = ts.isIdentifier(expression) ? values.get(expression.text) : templateText(expression);
    assert.notEqual(css, undefined, `${file}: cannot inspect ${expression.getText(tree)}`);
    styles.push(css!);
  }
  return styles;
}

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

test('PF5-01 retired page classes are absent from authored inline styles', () => {
  const found = sourceFiles.filter(file => /\.[cm]?tsx?$/.test(file)).flatMap(file => {
    const text = read(file);
    if (!text.includes('<style')) return [];
    return inlineStyles(file, text).flatMap(retiredPageRules).map(rule => `${file}: ${rule}`);
  });
  assert.deepEqual(found, []);
});

test('PF5-01 retired classes are detected in selector lists, CSS escapes and scope boundaries', () => {
  assert.deepEqual(retiredPageRules(String.raw`
    @media (pointer:coarse) { .button, :is(.tabs, .\69 nsight-source) { color:red } }
    [class~="MODEL-USED" i] { color:red }
    .button[data-message=".insight-source"] { color:red }
    @scope (.utility-nav) to (:is(.open, .orbit-mark)) { .button { color:red } }
    .answer-label > .small { color:red }
    @scope (.source-item) to (.guide-grid) { .button { color:red } }
    @supports selector(.brand-dot) { .button { color:red } }
  `), [
    '.tabs in :is(.tabs, .\\69 nsight-source)',
    '.insight-source in :is(.tabs, .\\69 nsight-source)',
    '.model-used in [class~="MODEL-USED" i]',
    '.small in .answer-label > .small',
    '.utility-nav in (.utility-nav) to (:is(.open, .orbit-mark))',
    '.orbit-mark in (.utility-nav) to (:is(.open, .orbit-mark))',
    '.guide-grid in (.source-item) to (.guide-grid)',
    '.brand-dot in selector(.brand-dot)',
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
  const authored = new Set(baseStylesheets.flatMap(file => baseRuleKeys(read(file))));
  assert.deepEqual([...baseRuleInventory()].filter(key => !authored.has(key)), [], 'Unused base selector allowances');
});

test('PF5-02 shared classes cannot bring page-only variants or conditions into the base', () => {
  const reportChoice = '.report-more-menu > [role = "menuitemradio"]';
  const checkedMark = '.report-more-menu>:is([aria-checked=true], [role=menuitemradio])::before';
  const reportIcon = '.report-more-menu>[aria-checked=true]>.report-view-check';
  const pageLayout = '.content[data-page=about]';
  const questionSelected = '.conversation-item.active';
  const unscopedMenu = '.report-more-menu [role=menuitem]';
  assert.deepEqual(pageRulesInBase(`
    .reader-menu [role="menuitem"]:focus-visible, .app-shell[data-navigation] .sidebar [aria-current=page] { color:red }
    .topbar, ${reportChoice}, ${checkedMark}, ${reportIcon} { color:red }
    @media (pointer:coarse) { ${reportChoice} { min-height:44px } }
    ${pageLayout}, ${questionSelected}, ${unscopedMenu} { color:red }
    @container (max-width:260px) { .button { white-space:normal } }
    @media (max-width:760px) { .source-item form { grid-template-columns:1fr } }
    @media (max-width:760px) { .source-toolbar select { max-width:100% } }
    .file-row > svg, .workflow-line > svg, .policy-card summary { flex-shrink:0 }
    .source-item .metadata-details { margin-top:18px }
    @scope (.source-item) { .button { flex-shrink:0 } }
  `), [
    '.report-more-menu>[role=menuitemradio]',
    '.report-more-menu>:is([aria-checked=true],[role=menuitemradio]):before',
    reportIcon,
    '@media (pointer:coarse) | .report-more-menu>[role=menuitemradio]',
    pageLayout, questionSelected, unscopedMenu,
    '@container (max-width:260px) | .button',
    '@media (max-width:760px) | .source-item form',
    '@media (max-width:760px) | .source-toolbar select',
    '.file-row>svg', '.workflow-line>svg', '.policy-card summary',
    '.source-item .metadata-details',
    '@scope (.source-item) | .button',
  ]);
});

test('PF5-02 page selectors live with the stylesheet loaded by their surfaces', () => {
  const sources = read('plugins/sources/Sources.tsx');
  assert.match(sources, /sourceWorkspaceStyleHref=new URL\('\.\.\/\.\.\/source-workspace\.css\?no-inline'/);
  assert.match(sources, /mode==='library'&&<link rel="stylesheet" href=\{sourceWorkspaceStyleHref\}/);
  const pageStyles = {
    'activity-final.css': ['.activity-detail .page-heading h1', '.settings-heading'],
    'discovery-final.css': ['.insight-automatic-dialog .conversation-dialog', '.report-top-tools .report-more-menu',
      ':where(.insight-report) .run-details pre', ':where(.final-insights) .field-label>select',
      '.report-more-menu>[role=menuitemradio]', '.report-more-menu>[role=menuitemradio]:hover',
      '.report-more-menu>[role=menuitemradio]:focus-visible', '.report-view-check',
      '.report-more-menu>[aria-checked=true]>.report-view-check'],
    'discovery-ui.css': ['.discovery-inline-guidance .text-button'],
    'home-search-questions.css': ['.search-workspace .library-record'],
    'imports-final.css': [':where(.final-imports) .workflow-line>svg', ':where(.final-imports) .file-row>svg',
      ':where(.final-imports) .field-label>input',
      ':where(.final-imports) .file-row>span:not(.archived-download)'],
    'library.css': ['.capture-card', '.library-record', '.material-reader-ask'],
    'library-final.css': [':where(.library-archive) .source-toolbar select'],
    'material-processing.css': ['.policy-card summary'],
    'memory-presentation.css': ['.memory-actions', '.execution-queue-overview p'],
    'model-settings.css': ['.model-settings-fields', '.model-settings-editor .preference-field textarea'],
    'notes.css': ['.notes-grid', '.notes-history'],
    'owner-maintenance.css': ['.log-pagination', '.diagnostics-panel', '.transfer-panel input.hidden'],
    'owner-question-final.css': ['.conversation-item.active'],
    'plugin-center.css': ['.feature-inventory code', '.provider-list'],
    'processing.css': ['.processing-list', '.processing-row'],
    'recording-final.css': ['.file-detail.recording-view', '.recording-dialog', '.recording-raw-line', '.file-diarization-selection'],
    'settings-surface.css': ['.settings-surface .panel'],
    'settings-ui.css': ['.content[data-page=about]', '.final-settings-directory .settings-directory-group', '.settings-directory-rows>button', '.settings-heading', '.settings-locations', '.settings-destinations', '.web-preferences select', '.preference-toggle input:checked'],
    'source-connectors-final.css': ['.lark-settings', '.lark-range'],
    'source-final.css': ['.source-final-originals .source-item .badge',
      '.source-final-originals .source-item .metadata-details'],
    'source-workspace.css': ['.connections', '.sources-page .source-item form'],
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
