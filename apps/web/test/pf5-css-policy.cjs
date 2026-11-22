const postcss = require('postcss');

// The base owns the app shell, shared controls and the evidence and quick-note
// surfaces that can open from anywhere. A new base class needs a shared owner.
const sharedClasses = new Set(`
  active amber answer answer-label app-shell archive-welcome archived-download back-link badge bare brand
  breadcrumb button capture-image checking citation citation-grid citation-number citations close connect-modal connection-help
  connection-pill connection-pill-dot content conversation-item conversation-list danger danger-text
  discovery-inline-guidance done dot download-error embedded-evidence empty empty-icon error error-banner
  evidence-aside evidence-ask evidence-back evidence-body evidence-body-heading evidence-canonical
  evidence-caption evidence-card evidence-description evidence-dock evidence-facts evidence-footer
  evidence-grid evidence-heading evidence-main evidence-modal evidence-number evidence-ocr-status
  evidence-processing-help evidence-reader evidence-reader-backdrop evidence-source-actions evidence-text
  eyebrow feature-json field-label field-note file-detail file-diarization-selection file-row file-text
  filter-bar fine-print footer form-footer full global-retrieval green greeting hidden icon-button
  image-failure image-skeleton library-original-text load-more loading loading-line loading-mark loading-ring
  loading-text login-endpoint main markdown material-detail media-image metadata-details modal modal-backdrop
  modal-icon model-selector-selection mote-mark muted muted-copy native-size note-attachment-boundary
  note-attachment-help note-attachments note-composer note-composer-actions note-composer-overlay
  note-description note-evidence note-more note-more-content note-pending note-storage-hint notice online
  open original-image original-image-controls original-image-viewport page-heading panel panel-pad
  pending-note period-select policy-card policy-grid preference-toggle presentation-content-outlet primary
  processing-actions quick-note quick-note-backdrop quick-note-dialog reader-menu reader-menu-note
  reader-menu-separator reader-more reader-more-button reader-source-details record-id recording-dialog
  recording-dialog-body recording-file recording-file-head recording-file-icon recording-file-name
  recording-more recording-more-menu recording-raw-line recording-segment recording-segments recording-speaker
  recording-state-note recording-time recording-toolbar recording-tools-backdrop recording-transcript
  recording-turn recording-turn-content recording-version recording-view report-more report-more-menu
  review-notes run-details run-id secondary section-heading section-tabs segmented-nav session-lifetime-control
  shell-menu shell-mobile-menu sidebar signed-out simple-values simple-welcome skeleton
  skeleton-row source-item source-toolbar spin split-heading subtle success text-button text-image topbar
  topbar-actions trace version visually-hidden welcome welcome-archive-flow welcome-values workflow-icon
  workflow-line workspace-back workspace-content workspace-context workspace-empty workspace-layout
  workspace-list workspace-list-heading workspace-range workspace-select workspace-tool-links workspace-tools
`.trim().split(/\s+/));

function classNames(selector) {
  const names = [...selector.matchAll(/\.([-_a-zA-Z][\w-]*)/g)].map(match => match[1]);
  for (const match of selector.matchAll(/\[\s*class\s*(?:~=|=)\s*(?:"([^"]*)"|'([^']*)'|([-\w]+))/gi)) {
    names.push(...(match[1] ?? match[2] ?? match[3]).trim().split(/\s+/));
  }
  return names;
}

function selectors(css) {
  const result = [];
  postcss.parse(css).walkRules(rule => {
    result.push(...rule.selectors);
  });
  return result;
}

function pageRulesInBase(css) {
  const unexpected = selectors(css).filter(selector =>
    /\[\s*data-page\b/i.test(selector) ||
    [...selector.matchAll(/#([-_a-zA-Z][\w-]*)/g)].some(match => match[1] !== 'note-text') ||
    classNames(selector).some(name => !sharedClasses.has(name)),
  );
  postcss.parse(css).walkAtRules('container', rule => {
    const name = rule.params.match(/^[-_a-zA-Z][\w-]*\s+(?=\()/)?.[0].trim();
    if (name && name !== 'model-selector') unexpected.push(`@container ${rule.params}`);
  });
  return unexpected;
}

module.exports = {classNames, pageRulesInBase, selectors, preConsolidationChatBytes: 491_895};
