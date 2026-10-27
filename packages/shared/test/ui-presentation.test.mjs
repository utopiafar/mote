import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {UiPresentationHost,linearUiTheme,defaultUiLayout,androidUiLayout,desktopUiLayout,uiDestinationPresentation} from '../dist/ui-presentation.js';

const fixture=()=>new UiPresentationHost({theme:linearUiTheme,layout:{...defaultUiLayout,implementation:{name:'default'}}});
test('one failed presentation observer does not split the committed binding across consumers',()=>{
  const host=fixture(),failure=new Error('Generated renderer observer failure');let observed;
  host.subscribe(()=>{throw failure;});host.subscribe(()=>{observed=host.getSnapshot();});
  const errors=host.activate({theme:linearUiTheme,layout:defaultUiLayout});
  assert.equal(observed,host.getSnapshot());assert.deepEqual(errors,[failure]);assert.equal(host.getNotificationErrors(),errors);
});
test('native assets, CSS and the compiled theme derive from the same selected design',()=>{
  execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/generate-design-tokens.mjs',import.meta.url)),'--check'],{cwd:tmpdir()});
  const asset=JSON.parse(readFileSync(new URL('../../../apps/android/app/src/main/assets/ui-presentation.json',import.meta.url),'utf8'));
  assert.equal(asset.schemaVersion,1);assert.deepEqual(asset.theme,linearUiTheme);assert.deepEqual(asset.layout,androidUiLayout);
});
test('presentation changes atomically and disposal restores the built-in provider',()=>{
  const host=fixture();
  const theme={...linearUiTheme,id:'fixture.theme',tokens:{...linearUiTheme.tokens,accent:'#ffcc88'}};
  const alternative={...defaultUiLayout,id:'fixture.layout',navigation:'top',detail:'stack',implementation:{name:'alternative'}};
  const removeTheme=host.registerTheme(theme),removeLayout=host.registerLayout(alternative);
  let notifications=0;const unsubscribe=host.subscribe(()=>notifications++);
  const before=host.getSnapshot();
  assert.throws(()=>host.activate({theme,layout:{id:alternative.id,version:'2'}}),/unavailable/);
  assert.equal(host.getSnapshot(),before);assert.equal(notifications,0);
  host.activate({theme,layout:alternative});
  assert.equal(host.getSnapshot().layout.implementation.name,'alternative');
  assert.equal(host.getSnapshot().theme.tokens.accent,'#ffcc88');
  assert.equal(notifications,1);
  removeLayout();assert.equal(host.getSnapshot().layout.id,defaultUiLayout.id);
  assert.equal(host.getSnapshot().fallbackReason,'layout_removed');
  removeTheme();assert.equal(host.getSnapshot().theme.id,linearUiTheme.id);
  unsubscribe();removeLayout();assert.equal(notifications,3);
});
test('data-only themes and complete core navigation are validated before registration',()=>{
  const host=fixture();
  assert.throws(()=>host.registerTheme({...linearUiTheme,id:'fixture.remote',tokens:{...linearUiTheme.tokens,font:'url(https://example.invalid/font)'}}),/Invalid theme/);
  assert.throws(()=>host.registerTheme({...linearUiTheme,id:'fixture.partial',tokens:{accent:'#ffffff'}}),/roles/);
  assert.throws(()=>host.registerLayout({...defaultUiLayout,id:'fixture.hidden',primary:['library'],implementation:{}}),/layout contract/);
  assert.throws(()=>host.registerTheme(linearUiTheme),/already installed/);
  const pack={...linearUiTheme,id:'fixture.pinned',tokens:{...linearUiTheme.tokens}};
  host.registerTheme(pack);pack.tokens.accent='#ffffff';
  host.activate({theme:pack,layout:defaultUiLayout});
  assert.equal(host.getSnapshot().theme.tokens.accent,linearUiTheme.tokens.accent);
  assert(Object.isFrozen(host.getSnapshot().theme.tokens));
});
test('every client names shared primary destinations with the same words and distinct glyphs',()=>{
  const repo=new URL('../../../',import.meta.url),read=path=>readFileSync(new URL(path,repo),'utf8');
  const glyphs=Object.values(uiDestinationPresentation).map(item=>item.icon);
  assert.equal(new Set(glyphs).size,glyphs.length,'Each destination needs its own glyph');
  // Mac ships static navigation before the renderer mounts; it must already use the shared names.
  const html=read('apps/desktop/src/index.html'),mainNav=html.slice(html.indexOf('<nav class="main-nav"'),html.indexOf('</nav>'));
  assert.deepEqual([...mainNav.matchAll(/<span data-i18n>([^<]+)<\/span>/g)].map(match=>match[1]),desktopUiLayout.primary.map(id=>uiDestinationPresentation[id].label));
  assert.match(html,/data-nav="work"[^>]*>.*?<span data-i18n>活动<\/span>/);
  // Android declares its tabs natively; route ids map to the same destinations.
  const kotlin=read('apps/android/app/src/main/java/dev/mote/collector/PrimaryNavigation.kt');
  const tabs=Object.fromEntries([...kotlin.matchAll(/^\s+[A-Z]+\("([^"]+)", "[^"]+", "[A-Z]+", "([a-z]+)"\)/gm)].map(match=>[match[2],match[1]]));
  for(const id of [...androidUiLayout.primary,'activity'])assert.equal(tabs[id],uiDestinationPresentation[id].label,'Android '+id);
});
