import { moteText } from '@mote/shared/i18n';

// The same loading language as Web: skeleton rows for content that is on its way, a short bar for a value
// inside a line, and a thin line while content already on screen refreshes. The words stay for VoiceOver.

function words(document: Document, label: string): HTMLElement {
  const hidden = document.createElement('span');
  hidden.className = 'visually-hidden';
  hidden.textContent = label;
  return hidden;
}

function ownerDocument(owner: Node): Document {
  return owner.ownerDocument ?? owner as Document;
}

/** Rows in the shape of the content that replaces them. */
export function skeleton(owner: Node, label = moteText('正在读取…'), rows = 3): HTMLElement {
  const document = ownerDocument(owner), root = document.createElement('span');
  root.className = 'loading skeleton';
  root.append(words(document, label));
  for (let index = 0; index < rows; index++) {
    const row = document.createElement('span');
    row.className = 'skeleton-row';
    row.setAttribute('aria-hidden', 'true');
    row.append(document.createElement('i'), document.createElement('i'));
    root.append(row);
  }
  return root;
}

/** A value still on its way inside a sentence or row: a short bar where its words will be. */
export function loadingText(owner: Node, label = moteText('正在读取…')): HTMLElement {
  const document = ownerDocument(owner), root = document.createElement('span');
  root.className = 'loading loading-text';
  root.append(words(document, label));
  return root;
}

/** Content already on screen is being refreshed in place. */
export function loadingLine(owner: Node, label = moteText('正在读取…')): HTMLElement {
  const document = ownerDocument(owner), root = document.createElement('span'), bar = document.createElement('i');
  root.className = 'loading loading-line';
  bar.setAttribute('aria-hidden', 'true');
  root.append(words(document, label), bar);
  return root;
}

export function showSkeleton(target: Element, label?: string, rows?: number): void {
  target.replaceChildren(skeleton(target, label, rows));
}

export function showLoadingText(target: Element, label?: string): void {
  target.replaceChildren(loadingText(target, label));
}

export function showLoadingLine(target: Element, label?: string): void {
  target.replaceChildren(loadingLine(target, label));
}
