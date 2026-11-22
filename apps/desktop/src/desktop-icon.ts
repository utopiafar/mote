import type {ContentItem} from './contracts/content';

const svgNamespace = 'http://www.w3.org/2000/svg';

export function desktopIcon(document: Document, name: string, inline = false): SVGSVGElement {
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.setAttribute('class', inline ? 'icon icon-inline' : 'icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNamespace, 'use');
  use.setAttribute('href', '#icon-' + name);
  icon.append(use);
  return icon;
}

const contentIcons: Partial<Record<ContentItem['source'], string>> = {
  note: 'pencil',
  screen: 'screen',
  ui_page: 'file-text',
  activity: 'clock',
  notification: 'bell',
  media: 'music',
  file: 'file-text',
  calendar: 'calendar',
  coding: 'code',
};

export function desktopContentIcon(document: Document, source: ContentItem['source']): SVGSVGElement {
  return desktopIcon(document, contentIcons[source] ?? 'file-text');
}
