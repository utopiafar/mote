import { moteText } from '@mote/shared/i18n';
import type { AskConversation } from './ask';
export type AskCitation = NonNullable<AskConversation['turns'][number]['result']>['citations'][number];

/** A deliberately small Markdown display grammar. Evidence is always text, never HTML,
 * an image request or an executable/link destination. Only declared citations navigate. */
export function renderAskAnswer(document: Document, text: string, citations: AskCitation[], onOpen: (id: string) => void): HTMLElement {
  const root = document.createElement('div'); root.className = 'ask-answer';
  const refs = new Map(citations.map((citation, index) => [citation.id, index + 1]));
  function inline(parent: HTMLElement, value: string, depth = 0): void {
    if (depth > 8) { parent.append(document.createTextNode(value)); return; }
    const pattern = /(`[^`\n]+`|\*\*[^\n]+?\*\*|__[^\n]+?__|\*[^*\n]+\*|\[[^\]\n]+\](?:\([^\n)]*\))?)/g;
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      parent.append(document.createTextNode(value.slice(offset, match.index)));
      const token = match[0]; let node: HTMLElement | undefined;
      if (token.startsWith('`')) { node = document.createElement('code'); node.textContent = token.slice(1, -1); }
      else if (token.startsWith('**') || token.startsWith('__')) { node = document.createElement('strong'); inline(node, token.slice(2, -2), depth + 1); }
      else if (token.startsWith('*')) { node = document.createElement('em'); inline(node, token.slice(1, -1), depth + 1); }
      else {
        const id = token.slice(1, -1), index = refs.get(id);
        if (index !== undefined) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'ask-inline-citation';
          button.textContent = moteText('来源 {0}', index); button.setAttribute('aria-label', moteText('查看证据：{0}', button.textContent));
          button.addEventListener('click', () => onOpen(id)); node = button;
        }
      }
      parent.append(node ?? document.createTextNode(token)); offset = match.index! + token.length;
    }
    parent.append(document.createTextNode(value.slice(offset)));
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n'); let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const content: string[] = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      const pre = document.createElement('pre'), code = document.createElement('code'); code.textContent = content.join('\n'); pre.append(code); root.append(pre); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const h = document.createElement(`h${Math.min(6, heading[1].length + 2)}`); inline(h, heading[2]); root.append(h); index++; continue; }
    const list = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = !list[1], group = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(lines[index]);
        if (!item || !item[1] !== ordered) break;
        const li = document.createElement('li'); inline(li, item[2]); group.append(li); index++;
      }
      root.append(group); continue;
    }
    const p = document.createElement(line.startsWith('> ') ? 'blockquote' : 'p'); inline(p, line.startsWith('> ') ? line.slice(2) : line); root.append(p); index++;
  }
  return root;
}

export function renderAskCitation(document: Document, citation: AskCitation, onOpen: (id: string) => void): HTMLElement {
  const evidence = document.createElement('section'); evidence.className = 'ask-evidence';
  const title = document.createElement('p'), excerpt = document.createElement('details'), summary = document.createElement('summary'), quote = document.createElement('p'), open = document.createElement('button');
  title.textContent = `${citation.appName} · ${citation.capturedAt}`;
  summary.textContent = moteText('引用片段'); quote.textContent = citation.excerpt; quote.className = 'ask-excerpt';
  excerpt.append(summary, quote);
  open.type = 'button'; open.className = 'secondary'; open.textContent = moteText('查看原始记录');
  open.addEventListener('click', () => onOpen(citation.id)); evidence.append(title, open, excerpt);
  return evidence;
}
