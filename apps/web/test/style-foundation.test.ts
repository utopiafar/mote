import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

const source = new URL('../src/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, source), 'utf8');
const styles = readdirSync(source).filter(name => name.endsWith('.css') && name !== 'design-tokens.css');

function rules(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({selector: match[1].trim().replace(/\s+/g, ' '), body: match[2]}));
}

test('prefers-contrast: more maps hair, fill and borders to ink', () => {
  const block = read('styles.css').match(/@media \(prefers-contrast: more\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'high-contrast block');
  for (const token of ['--mote-muted','--mote-control-border','--mote-border','--mote-divider','--mote-hair','--mote-fill','--mote-sidebar-border'])
    assert.match(block, new RegExp(`${token}\\s*:\\s*var\\(--mote-ink\\)\\s*!important`), token);
  assert.match(block, /\.button:not\(\.danger\)[^}]*color:var\(--mote-primary-ink\)/);
});

test('group, divider, sidebar and row lines use hair while inputs use the control border', () => {
  const direction = read('art-direction.css');
  assert.match(direction, /--mote-divider\s*:\s*var\(--mote-hair\)/);
  assert.match(direction, /--mote-sidebar-border\s*:\s*var\(--mote-hair\)/);
  for (const name of styles) {
    for (const {selector, body} of rules(read(name))) {
      const control = /(^|[ ,>+~])(input|select|textarea)(?![\w-])/.test(selector.toLowerCase());
      for (const declaration of (body.match(/border(?:-(?:top|right|bottom|left|block|inline))?\s*:[^;]+/g) ?? []).filter(value => !value.trimStart().startsWith('--'))) {
        if (declaration.includes('color-mix')) continue;
        if (/\b(th|thead)\b/.test(selector.toLowerCase())) continue;
        if (control) assert.doesNotMatch(declaration, /var\(--mote-hair\)/, `${name}: ${selector}`);
        else assert.doesNotMatch(declaration, /var\(--mote-border\)/, `${name}: ${selector}`);
      }
    }
  }
});

test('sidebar navigation uses primary ink and the accent tint for selection at the reference brand scale', () => {
  const shell = read('presentation.css');
  assert.match(shell, /\.sidebar nav button[^{]*\{[^}]*color:var\(--mote-ink\)/);
  assert.match(shell, /\.sidebar \[aria-current=page\] \{ background:var\(--mote-tint\); color:var\(--mote-accent\); \}/);
  assert.match(shell, /font:500 15px\/1\.2/);
  assert.match(shell, /font:600 23px\/1/);
  assert.match(shell, /\.sidebar-bottom \{ margin-top:auto; padding:0; display:grid; gap:2px; \}/);
  assert.match(read('final-web.css'), /\.sidebar \.brand \{[^}]*line-height:1\.2/);
});

test('secondary buttons are borderless fill controls and shapes come from the desktop radius table', () => {
  const direction = read('art-direction.css');
  const base = rules(direction).find(rule => rule.selector === '.button');
  assert.ok(base);
  assert.match(base.body, /background:var\(--mote-fill\)/);
  assert.match(base.body, /border:0/);
  const subtle = rules(direction).find(rule => rule.selector === '.button.subtle,.button.secondary');
  assert.ok(subtle);
  assert.match(subtle.body, /background:var\(--mote-fill\)/);
  assert.match(subtle.body, /border:0/);
  const tokens = read('design-tokens.css');
  for (const [name, value] of [['--mote-radius-control','8px'],['--mote-radius-thumb','8px'],['--mote-radius-container','12px'],['--mote-radius-panel','14px'],['--mote-radius-indicator','999px']])
    assert.match(tokens, new RegExp(`${name}: ${value}`), name);
  for (const name of styles) {
    for (const {selector, body} of rules(read(name))) {
      if (selector.includes('.mote-symbol')) continue;
      for (const declaration of body.match(/border-radius\s*:[^;]+/g) ?? []) {
        const value = declaration.split(':')[1].trim();
        assert.doesNotMatch(value, /^(?!0$|50%$|3px$|\.45em$)[0-9.]+px$/, `${name}: ${selector} -> ${declaration}`);
      }
    }
  }
});
