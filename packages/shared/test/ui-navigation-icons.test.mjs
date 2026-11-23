import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {officialNavigation} from '../dist/ui-navigation.js';

const repo=new URL('../../../',import.meta.url);
const read=path=>readFileSync(new URL(path,repo),'utf8');
// Navigation draws the shared line icons; character glyphs are not an icon set.
const characterGlyphs=['▣','▧','♩','⌕','⌂','▤','↗','◇','⚙'];
const navigationSources=[
  'apps/web/src/WorkspaceSidebar.tsx',
  'apps/web/src/WorkspaceNavigation.tsx',
  'apps/web/src/navigation.ts',
  'packages/shared/src/ui-presentation.ts',
  'apps/desktop/src/presentation.ts',
  'apps/desktop/src/desktop-icon.ts',
];

test('web and Mac navigation sources contain no character icon glyphs',()=>{
  for(const file of navigationSources){
    const source=read(file);
    for(const glyph of characterGlyphs)assert.ok(!source.includes(glyph),`${file} still uses the character icon ${glyph}`);
  }
  const html=read('apps/desktop/src/index.html');
  const sidebar=html.slice(html.indexOf('<aside class="sidebar"'),html.indexOf('</aside>'));
  assert.ok(sidebar.includes('class="main-nav"'),'the Mac sidebar markup is discoverable');
  for(const glyph of characterGlyphs)assert.ok(!sidebar.includes(glyph),`the Mac sidebar still uses the character icon ${glyph}`);
});

test('the web sidebar maps shared destination icons to lucide instead of a duplicate glyph table',()=>{
  const source=read('apps/web/src/WorkspaceSidebar.tsx');
  assert.doesNotMatch(source,/destinationGlyphs/);
  const imported=source.match(/import\s*\{([^}]*)\}\s*from 'lucide-react'/)?.[1];
  assert.ok(imported,'the sidebar imports Lucide components');
  for(const {id,icon} of officialNavigation){
    const component=icon.split('-').map(part=>part[0].toUpperCase()+part.slice(1)).join('');
    assert.match(imported,new RegExp(`\\b${component}\\b`),id);
    assert.match(source,new RegExp(`^\\s*['"]?${icon}['"]?\\s*:\\s*${component}\\b`,'m'),id);
  }
});
