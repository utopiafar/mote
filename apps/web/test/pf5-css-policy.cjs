const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const postcss = require('postcss');
const {tokenize, TokenType} = require('@csstools/css-tokenizer');

// Historical JSX and CSS for the pages retired by NV3, CH1 and CH3, including
// earlier versions in main.tsx and former shell entries. Preserve the audited
// class names here so this also works in shallow clones.
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
  // Former shell, reader and settings entrypoints with no mounted owner.
  `auxiliary-nav avatar brand-dot breadcrumb-workspace connection-pill connection-pill-dot
  discovery-nav-copy discovery-settings-boundary discovery-settings-grid dot footer local-note
  mobile-menu mobile-settings nav-glyph nav-group-label nav-spark orbit-mark private-label
  reader-top-actions session-settings settings-link-grid settings-scope settings-toolbar
  sidebar-scrim utility-nav version workspace-label workspace-tool-select`,
  // Earlier main.tsx renderers and the former login and status variants.
  `add-device-card backup-note connection-guide device-card device-grid device-note device-platform
  device-top guide-grid index-grid index-panel login-advanced node-avatar node-settings note-mood-tag
  online red small storage-note storage-number storage-track transfer-action transfer-icon vault-columns`,
].flatMap(group => group.split(/\s+/)));


function cssTokens(text) {
  return tokenize({css: text}).filter(([type]) => type !== TokenType.Comment && type !== TokenType.EOF);
}

function classesInSelector(selector) {
  const tokens = cssTokens(selector);
  const classes = new Set();
  for (let index = 0; index < tokens.length; index++) {
    const [type, raw] = tokens[index];
    const next = tokens[index + 1];
    if (type === TokenType.Delim && raw === '.' && next?.[0] === TokenType.Ident) {
      classes.add(next[4].value);
    }
    if (type !== TokenType.OpenSquare) continue;

    // Attribute values can contain literal periods that are not class selectors.
    const end = tokens.findIndex((token, offset) => offset > index && token[0] === TokenType.CloseSquare);
    if (end === -1) continue;
    const parts = tokens.slice(index + 1, end).filter(([kind]) => kind !== TokenType.Whitespace);
    const equals = parts.findIndex(([kind, value]) => kind === TokenType.Delim && value === '=');
    if (parts[0]?.[4]?.value?.toLowerCase() === 'class' && equals !== -1) {
      const value = parts[equals + 1]?.[4]?.value ?? '';
      const insensitive = parts[equals + 2]?.[4]?.value?.toLowerCase() === 'i';
      for (const name of (insensitive ? value.toLowerCase() : value).trim().split(/\s+/)) {
        if (name) classes.add(name);
      }
    }
    index = end;
  }
  return classes;
}

function isKeyframes(node) {
  return node.type === 'atrule' && /(?:^|-)keyframes$/i.test(node.name);
}

function* styleRules(parent, context = []) {
  for (const node of parent.nodes) {
    if (node.type === 'rule') {
      for (const selector of node.selectors) yield {selector, context};
      yield* styleRules(node, [...context, node]);
    } else if (node.type === 'atrule' && node.nodes && !isKeyframes(node)) {
      yield* styleRules(node, [...context, node]);
    }
  }
}

function selectors(css) {
  return [...styleRules(postcss.parse(css))].map(({selector}) => selector);
}

function retiredPageRules(css) {
  const root = postcss.parse(css);
  const candidates = [...styleRules(root)].map(({selector}) => selector);
  root.walkAtRules(rule => {
    if (['scope', 'supports', 'custom-selector'].includes(rule.name.toLowerCase())) {
      candidates.push(rule.params);
    }
  });
  return candidates.flatMap(selector => [...classesInSelector(selector)]
    .filter(name => retiredPageClasses.has(name))
    .map(name => '.' + name + ' in ' + selector));
}

// Source and Vite's minifier spell combinator spacing and attribute quotes
// differently. Keep descendant combinators and significant string contents.
function canonical(text, condition = false) {
  const tokens = cssTokens(text);
  const punctuators = condition ? /^[>+~=:,]$/ : /^[>+~=,]$/;
  return tokens.map(([type, raw, , , data], index) => {
    // esbuild collapses the CSS2 pseudo-elements and normalizes the even An+B form.
    const next = tokens[index + 1];
    if (type === TokenType.Colon && next?.[0] === TokenType.Colon &&
        ['before', 'after'].includes(tokens[index + 2]?.[1])) return '';
    if (raw === 'even' && ['nth-child(', 'nth-last-child('].includes(tokens[index - 1]?.[1]) &&
        next?.[0] === TokenType.CloseParen) return '2n';
    if (type === TokenType.String) {
      return /^-?[_a-z][_a-z0-9-]*$/i.test(data.value) ? data.value : JSON.stringify(data.value);
    }
    if (type !== TokenType.Whitespace) return raw;
    const before = tokens[index - 1]?.[1] ?? '';
    const after = tokens[index + 1]?.[1] ?? '';
    if (!before || !after || before.endsWith('(') || before === '[' || after === ')' || after === ']' ||
        (condition && before === ')' && (after === 'and' || after === 'or')) ||
        punctuators.test(before) || punctuators.test(after)) return '';
    return ' ';
  }).join('');
}

function baseRuleKeys(css) {
  return [...styleRules(postcss.parse(css))].map(({selector, context}) => [
    ...context.map(node => node.type === 'rule' ? canonical(node.selector) :
      '@' + node.name + ' ' + canonical(node.params, node.name !== 'scope')),
    canonical(selector),
  ].join(' | '));
}

// This inventory covers complete selectors under their actual conditions. A
// shared class can still acquire a page-only child, state or media override.
// Review the owner when adding a selector to the base or to this fixture.
function baseRuleInventory() {
  return new Set(readFileSync(join(__dirname, 'pf5-base-selectors.txt'), 'utf8').trim().split('\n'));
}

function pageRulesInBase(css) {
  const allowed = baseRuleInventory();
  return baseRuleKeys(css).filter(key => !allowed.has(key));
}

module.exports = {
  baseRuleInventory, baseRuleKeys, pageRulesInBase, retiredPageRules, selectors,
  preConsolidationChatBytes: 491_895,
};
