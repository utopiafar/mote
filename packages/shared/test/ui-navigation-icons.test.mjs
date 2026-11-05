import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const repo=new URL('../../../',import.meta.url);
const read=path=>readFileSync(new URL(path,repo),'utf8');
// G11: navigation draws the shared line icons; character glyphs are not an icon set.
const characterGlyphs=['▣','▧','♩','⌕','⌂','▤','↗','◇','⚙'];
const navigationSources=[
  'apps/web/src/WorkspaceSidebar.tsx',
  'apps/web/src/WorkspaceNavigation.tsx',
  'apps/web/src/navigation.ts',
  'packages/shared/src/ui-presentation.ts',
  'apps/desktop/src/presentation.ts',
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
  assert.match(source,/from 'lucide-react'/);
  for(const icon of ['House','Database','Link2','Bot','MessageSquare','Activity'])assert.match(source,new RegExp(`\\b${icon}\\b`));
});

test('the Mac generated navigation uses the shared line-icon symbols',()=>{
  const source=read('apps/desktop/src/presentation.ts');
  assert.match(source,/desktopIconSymbols/);
  assert.match(source,/createElementNS\('http:\/\/www\.w3\.org\/2000\/svg','svg'\)/);
  assert.match(source,/#icon-'\+desktopIconSymbols/);
  const html=read('apps/desktop/src/index.html');
  for(const symbol of ['icon-home','icon-storage','icon-link','icon-ask','icon-activity','icon-settings','icon-external'])assert.match(html,new RegExp(`id="${symbol}"`));
});
