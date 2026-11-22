const postcss = require('postcss');
const {tokenize, TokenType} = require('@csstools/css-tokenizer');

// Historical JSX from before NV3, CH1 and CH3, including earlier renderers
// in main.tsx. Shared classes used by current surfaces are outside this inventory.
const retiredPageClasses = new Set([
  // Home (Overview, FirstUseHome and plug-in contributions)
  `app-row art-center art-desktop art-file art-node art-phone
  central-first-actions central-first-data central-first-original central-first-steps central-first-use
  central-issue central-onboarding central-overview central-status-grid compact-stats completed
  device-icon devices-strip discovery-ai-actions discovery-intake discovery-intake-card discovery-intake-grid
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
  home-summary initial-loading insight-history insight-history-heading insight-intro insight-panel
  insight-placeholder insight-preview insight-source library-home mote-symbol muted-icon onboarding-panel
  orbit orbit-one orbit-two overview-columns primary-action recent-section run-link-label setup-steps
  stat-link step-number time-track welcome-art`,
  // FeatureGuide and its former shell entries
  `feature-guide guide-actions guide-advanced guide-condition guide-empty guide-footer guide-group
  guide-group-details guide-group-heading guide-group-links guide-groups guide-heading guide-index-number
  guide-model-start guide-model-steps guide-model-terms guide-notes guide-path guide-primary-link
  guide-quick-links guide-related guide-return guide-search guide-section guide-section-heading
  guide-section-nav guide-setting-note guide-setup guide-start guide-text-link guide-unit-links
  guide-unit-purpose guide-where node-button node-state settings-nav sidebar-bottom workspace-node-menu`,
  // Ask, the multi-conversation list and the former reference picker
  `answer-panel chat-section-icon chat-section-title composer-hint conversation-add-reference
  conversation-delete-confirm conversation-details-question conversation-fresh conversation-history conversation-history-heading
  conversation-item-meta conversation-item-row conversation-more conversation-more-list
  conversation-page-status conversation-toolbar conversation-turn-error evidence-conversations failed
  failed-answer failed-answer-icon final-conversation first-question-duplicate history-open history-preview
  model-notice model-used new-conversation-button query-admission-status query-unconfirmed rotated
  suggestions tabs thinking-panel`,
  // Earlier shell chrome that no longer has a mount point.
  `connection-pill connection-pill-dot footer version`,
].flatMap(group => group.split(/\s+/)));

// The base owns the app shell, shared controls and the evidence and quick-note
// surfaces that can open from anywhere. A new base class needs a shared owner.
const sharedClasses = new Set(`
  active amber answer answer-label app-shell archive-welcome archived-download back-link badge bare brand
  breadcrumb button capture-image citation citation-grid citation-number citations close connect-modal connection-help
  content conversation-dialog conversation-dialog-backdrop conversation-dialog-body conversation-item conversation-list
  danger danger-text done dot download-error embedded-evidence empty empty-icon error error-banner
  evidence-aside evidence-ask evidence-back evidence-body evidence-body-heading evidence-canonical
  evidence-caption evidence-card evidence-description evidence-dock evidence-facts evidence-footer
  evidence-grid evidence-heading evidence-main evidence-modal evidence-number evidence-ocr-status
  evidence-processing-help evidence-reader evidence-reader-backdrop evidence-source-actions evidence-text
  eyebrow feature-json field-label field-note file-row file-text
  filter-bar fine-print form-footer full global-retrieval green greeting hidden icon-button
  image-failure image-skeleton library-original-text load-more loading loading-line loading-mark loading-ring
  loading-text login-endpoint main markdown material-detail media-image metadata-details modal modal-backdrop
  modal-icon model-selector model-selector-selection mote-mark muted muted-copy native-size note-attachment-boundary
  note-attachment-help note-attachments note-composer note-composer-actions note-composer-overlay
  note-description note-evidence note-more note-more-content note-pending note-storage-hint notice
  open original-image original-image-controls original-image-viewport page-heading panel panel-pad
  pending-note period-select policy-card policy-grid presentation-content-outlet primary
  processing-actions quick-note quick-note-backdrop quick-note-dialog reader-menu reader-menu-note
  reader-menu-separator reader-more reader-more-button reader-source-details record-id report-more report-more-menu
  review-notes run-details run-id secondary section-heading section-tabs segmented-nav session-lifetime-control
  shell-menu shell-mobile-menu sidebar simple-values simple-welcome skeleton
  skeleton-row source-item source-toolbar spin split-heading subtle success text-button text-image topbar
  topbar-actions trace visually-hidden welcome welcome-archive-flow welcome-values workflow-icon
  workflow-line workspace-back workspace-content workspace-context workspace-empty workspace-layout
  workspace-list workspace-list-heading workspace-range workspace-select workspace-tool-links workspace-tools
`.trim().split(/\s+/));

const globalAttributes = new Set([
  'data-color-scheme=dark', 'data-color-scheme=light', 'hidden', 'tabindex=-1',
  'type=checkbox', 'type=date', 'type=file', 'type=radio', 'type=range',
]);

// A shared class can still name a page-only variant. Check the role, data
// attribute or state too (the reader and report both use report-more-menu).
const sharedAttributeOwners = new Map([
  ['aria-current=page', ['section-tabs', 'sidebar', 'workspace-tool-links']],
  ['aria-expanded=true', ['reader-more-button']],
  ['aria-pressed=true', ['original-image-controls']],
  ['data-navigation', ['app-shell']],
  ['data-navigation=adaptive', ['app-shell']],
  ['data-navigation=sidebar', ['app-shell']],
  ['data-navigation=top', ['app-shell']],
  ['open', ['note-more']],
  ['role=menuitem', ['reader-menu']],
  ['role=status', ['note-composer']],
]);
const activeStateOwners = ['segmented-nav', 'sidebar', 'workspace-select'];

function selectorParts(selector) {
  const tokens = tokenize({css: selector}).filter(token => token[0] !== TokenType.Comment);
  const classes = new Set();
  const ids = [];
  const attributes = [];
  for (let i = 0; i < tokens.length; i++) {
    const [type, raw, , , data] = tokens[i];
    if (type === TokenType.Delim && raw === '.' && tokens[i + 1]?.[0] === TokenType.Ident) {
      classes.add(tokens[i + 1][4].value);
    }
    if (type === TokenType.Hash) ids.push(data.value);
    if (type !== TokenType.OpenSquare) continue;

    const end = tokens.findIndex((token, index) => index > i && token[0] === TokenType.CloseSquare);
    if (end === -1) continue;
    const parts = tokens.slice(i + 1, end).filter(token => token[0] !== TokenType.Whitespace);
    attributes.push(parts.map(token => token[4]?.value ?? token[1]).join(''));
    const equals = parts.findIndex(token => token[0] === TokenType.Delim && token[1] === '=');
    if (parts[0]?.[4]?.value?.toLowerCase() === 'class' && equals !== -1) {
      const value = parts[equals + 1]?.[4]?.value ?? '';
      const insensitive = parts[equals + 2]?.[4]?.value?.toLowerCase() === 'i';
      for (const name of (insensitive ? value.toLowerCase() : value).trim().split(/\s+/)) {
        if (name) classes.add(name);
      }
    }
    i = end;
  }
  return {classes, ids, attributes};
}

function* ruleSelectors(root) {
  for (const node of root.nodes) {
    if (node.type === 'rule') yield* node.selectors;
    if (node.nodes && !(node.type === 'atrule' && /(?:^|-)keyframes$/i.test(node.name))) {
      yield* ruleSelectors(node);
    }
  }
}

function selectors(css) {
  return [...ruleSelectors(postcss.parse(css))];
}

function retiredPageRules(css) {
  return selectors(css).flatMap(selector => [...selectorParts(selector).classes]
    .filter(name => retiredPageClasses.has(name))
    .map(name => `.${name} in ${selector}`));
}

function pageRulesInBase(css) {
  const root = postcss.parse(css);
  const unexpected = [...ruleSelectors(root)].filter(selector => {
    const {classes, ids, attributes} = selectorParts(selector);
    return [...classes].some(name => !sharedClasses.has(name)) ||
      (classes.has('active') && !activeStateOwners.some(name => classes.has(name))) ||
      ids.some(id => id !== 'note-text') ||
      attributes.some(attribute => !globalAttributes.has(attribute) &&
        !sharedAttributeOwners.get(attribute)?.some(name => classes.has(name)));
  });
  root.walkAtRules('container', rule => {
    if (!/^model-selector\s*\(/.test(rule.params)) unexpected.push(`@container ${rule.params}`);
  });
  return unexpected;
}

module.exports = {pageRulesInBase, retiredPageRules, selectors, preConsolidationChatBytes: 491_895};
