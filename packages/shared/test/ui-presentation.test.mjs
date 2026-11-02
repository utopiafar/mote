import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {UiPresentationHost,linearUiTheme,defaultUiLayout,androidUiLayout,desktopUiLayout,uiDestinationPresentation} from '../dist/ui-presentation.js';
import {PluginI18nRegistry} from '../dist/plugin-i18n.js';
import {parseUiContribution} from '../dist/plugin-ui.js';
import {configureLocale} from '../dist/i18n.js';

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
test('Android home-only presentation can change providers without restoring retired primary tabs',()=>{
  const host=new UiPresentationHost({theme:linearUiTheme,layout:{...androidUiLayout,implementation:{name:'phone'}}});
  assert.deepEqual(host.getSnapshot().layout.primary,['home']);
  const replacement={...androidUiLayout,id:'fixture.phone',implementation:{name:'generated-phone'}};
  const remove=host.registerLayout(replacement);host.activate({theme:linearUiTheme,layout:replacement});
  assert.equal(host.getSnapshot().layout.navigation,'home');assert.equal(host.getSnapshot().layout.detail,'stack');
  for(const invalid of [
    {...replacement,id:'fixture.tabs',primary:['home','library','ask','sources'],navigation:'bottom'},
    {...replacement,id:'fixture.start',initial:'ask'},
    {...replacement,id:'fixture.split',detail:'split'},
    {...replacement,id:'fixture.bottom',navigation:'bottom'},
  ])assert.throws(()=>host.registerLayout(invalid),/layout contract/);
  remove();assert.equal(host.getSnapshot().layout.id,androidUiLayout.id);
});
test('clients preserve shared destination identities and the final platform-specific labels',()=>{
  const repo=new URL('../../../',import.meta.url),read=path=>readFileSync(new URL(path,repo),'utf8');
  const glyphs=Object.values(uiDestinationPresentation).map(item=>item.icon);
  assert.equal(new Set(glyphs).size,glyphs.length,'Each destination needs its own glyph');
  // The final Mac workspace intentionally says 工作台/内容. Its underlying
  // destinations still match the shared contract before the renderer mounts.
  const html=read('apps/desktop/src/index.html'),mainNav=html.slice(html.indexOf('<nav class="main-nav"'),html.indexOf('</nav>'));
  const macLabels={home:'工作台',library:'内容'},macRoutes={home:'overview',library:'records',sources:'sources',ask:'ask'};
  assert.deepEqual([...mainNav.matchAll(/data-nav="([^"]+)"/g)].map(match=>match[1]),desktopUiLayout.primary.map(id=>macRoutes[id]));
  assert.deepEqual([...mainNav.matchAll(/<span data-i18n>([^<]+)<\/span>/g)].map(match=>match[1]),desktopUiLayout.primary.map(id=>macLabels[id]??uiDestinationPresentation[id].label));
  assert.match(html,/data-nav="work"[^>]*>.*?<span data-i18n>同步与活动<\/span>/);
  // Android declares its tabs natively; route ids map to the same destinations.
  const kotlin=read('apps/android/app/src/main/java/dev/mote/collector/PrimaryNavigation.kt');
  const tabs=Object.fromEntries([...kotlin.matchAll(/^\s+[A-Z]+\("([^"]+)", "[^"]+", "[A-Z]+", "([a-z]+)"\)/gm)].map(match=>[match[2],match[1]]));
  for(const id of [...androidUiLayout.primary,'activity'])assert.equal(tabs[id],uiDestinationPresentation[id].label,'Android '+id);
});

test('a contributed theme and layout bind exactly and expose runtime labels until removal',()=>{
  const host=fixture();
  const catalogs=new PluginI18nRegistry();
  catalogs.register('fixture.plugin','en',{'theme.name':'Studio','layout.name':'Studio layout'});
  catalogs.register('fixture.plugin','zh-CN',{'theme.name':'影棚','layout.name':'影棚布局'});
  const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
  const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
  const themeContribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
  })};
  const removeTheme=host.registerContribution(themeContribution,{id:'fixture.theme',version:'1'},theme,catalogs,'web',facts,'zh-CN');
  host.activate({theme,layout:defaultUiLayout});
  assert.equal(host.getSnapshot().themePresentation.label.text,'影棚');
  removeTheme();
  assert.equal(host.getSnapshot().theme.id,linearUiTheme.id);
  assert.equal(host.getSnapshot().fallbackReason,'theme_removed');
  assert.equal(host.getSnapshot().fallbackPresentation.label.text,'影棚');
  assert.equal(host.getSnapshot().themePresentation,undefined);

  const layout={...defaultUiLayout,id:'fixture.layout',version:'1',implementation:{name:'contributed'}};
  const layoutContribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.layout',kind:'layout',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'layout.name',i18nNamespace:'fixture.plugin'},
  })};
  const removeLayout=host.registerContribution(layoutContribution,{id:'fixture.layout',version:'1'},layout,catalogs,'web',facts,'en');
  host.activate({theme:linearUiTheme,layout});
  assert.equal(host.getSnapshot().layoutPresentation.label.text,'影棚布局');
  removeLayout();
  assert.equal(host.getSnapshot().layout.id,defaultUiLayout.id);
  assert.equal(host.getSnapshot().fallbackReason,'layout_removed');
  assert.equal(host.getSnapshot().fallbackPresentation.label.text,'影棚布局');
  assert.equal(host.getSnapshot().layoutPresentation,undefined);
});

test('a contributed pack only binds its exact reference and theme/layout kind',()=>{
  const host=fixture();
  const catalogs=new PluginI18nRegistry();
  catalogs.register('fixture.plugin','en',{'theme.name':'Studio'});
  const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
  const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
  const themeContribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
  })};
  assert.throws(
    ()=>host.registerContribution(themeContribution,{id:'other.theme',version:'2'},theme,catalogs,'web',facts,'en'),
    /does not match/,
  );
  const page=parseUiContribution({
    id:'fixture.page',kind:'page',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
  });
  assert.throws(
    ()=>host.registerContribution({packageId:'fixture.page',descriptor:page},{id:'fixture.theme',version:'1'},theme,catalogs,'web',facts,'en'),
    /theme or layout/,
  );
});

test('contributed labels re-resolve from the host on runtime locale changes',()=>{
  let locale='zh-CN';configureLocale(()=>locale);
  try{
    const host=fixture();
    const catalogs=new PluginI18nRegistry();
    catalogs.register('fixture.plugin','en',{'theme.name':'Studio'});
    catalogs.register('fixture.plugin','zh-CN',{'theme.name':'影棚'});
    const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
    const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
    const contribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
      id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
      presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
    })};
    const remove=host.registerContribution(contribution,{id:'fixture.theme',version:'1'},theme,catalogs,'web',facts,'zh-CN');
    host.activate({theme,layout:defaultUiLayout});
    assert.equal(host.getSnapshot().themePresentation.label.text,'影棚');
    locale='en';
    host.refresh();
    assert.equal(host.getSnapshot().themePresentation.label.text,'Studio');
    assert.equal(host.getSnapshot().theme.id,'fixture.theme');
    remove();
    assert.equal(host.getSnapshot().fallbackPresentation.label.text,'Studio');
    assert.equal(host.getSnapshot().theme.id,linearUiTheme.id);
    assert.equal(host.getSnapshot().fallbackReason,'theme_removed');
  }finally{configureLocale(()=> 'zh-CN');}
});

test('unavailable contributions never install or replace the builtin presentation',()=>{
  const host=fixture();
  const catalogs=new PluginI18nRegistry();
  catalogs.register('fixture.plugin','en',{'theme.name':'Studio','layout.name':'Phone'});
  const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
  const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
  const themeContribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
  })};
  assert.throws(
    ()=>host.registerContribution(themeContribution,{id:'fixture.theme',version:'1'},theme,catalogs,'android',facts,'en'),
    /not active: unsupported/,
  );
  assert.throws(
    ()=>host.registerContribution(themeContribution,{id:'fixture.theme',version:'1'},theme,catalogs,'web',{...facts,revoked:true},'en'),
    /not active: revoked/,
  );
  const layout={...defaultUiLayout,id:'fixture.layout',version:'1',implementation:{name:'phone'}};
  const layoutContribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.layout',kind:'layout',apiVersion:'1',platforms:['android'],
    presentation:{labelKey:'layout.name',i18nNamespace:'fixture.plugin'},
    nativeRequires:[{capability:'ui.panes',apiVersion:'1',platforms:['android'],fallback:'generic-reader'}],
  })};
  assert.throws(
    ()=>host.registerContribution(layoutContribution,{id:'fixture.layout',version:'1'},layout,catalogs,'android',facts,'en'),
    /not active: requires-build/,
  );
  assert.equal(host.getSnapshot().theme.id,linearUiTheme.id);
  assert.equal(host.getSnapshot().layout.id,defaultUiLayout.id);
  assert.throws(()=>host.activate({theme,layout:defaultUiLayout}),/unavailable/);
});

test('a later unlabelled removal clears the previous fallback label',()=>{
  const host=fixture();
  const catalogs=new PluginI18nRegistry();
  catalogs.register('fixture.plugin','en',{'theme.name':'Studio'});
  const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
  const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
  const contribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
  })};
  const removeTheme=host.registerContribution(contribution,{id:'fixture.theme',version:'1'},theme,catalogs,'web',facts,'en');
  const plainLayout={...defaultUiLayout,id:'fixture.plain',version:'1',implementation:{name:'plain'}};
  const removeLayout=host.registerLayout(plainLayout);
  host.activate({theme,layout:plainLayout});
  removeTheme();
  assert.equal(host.getSnapshot().fallbackReason,'theme_removed');
  assert.equal(host.getSnapshot().fallbackPresentation.label.text,'Studio');
  removeLayout();
  assert.equal(host.getSnapshot().fallbackReason,'layout_removed');
  assert.equal(host.getSnapshot().fallbackPresentation,undefined);
});

test('a removed pack keeps its last readable label when the catalog unloads first',()=>{
  const host=fixture();
  const catalogs=new PluginI18nRegistry();
  const disposeCatalog=catalogs.register('fixture.plugin','en',{'theme.name':'Studio'});
  const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
  const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
  const contribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
  })};
  const remove=host.registerContribution(contribution,{id:'fixture.theme',version:'1'},theme,catalogs,'web',facts,'en');
  host.activate({theme,layout:defaultUiLayout});
  assert.equal(host.getSnapshot().themePresentation.label.text,'Studio');
  disposeCatalog();
  remove();
  assert.equal(host.getSnapshot().fallbackReason,'theme_removed');
  assert.equal(host.getSnapshot().fallbackPresentation.label.text,'Studio');
});

test('a removed pack notice re-resolves on runtime locale changes',()=>{
  let locale='zh-CN';configureLocale(()=>locale);
  try{
    const host=fixture();
    const catalogs=new PluginI18nRegistry();
    catalogs.register('fixture.plugin','en',{'theme.name':'Studio'});
    catalogs.register('fixture.plugin','zh-CN',{'theme.name':'影棚'});
    const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
    const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
    const contribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
      id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
      presentation:{labelKey:'theme.name',i18nNamespace:'fixture.plugin'},
    })};
    const remove=host.registerContribution(contribution,{id:'fixture.theme',version:'1'},theme,catalogs,'web',facts);
    host.activate({theme,layout:defaultUiLayout});
    assert.equal(host.getSnapshot().themePresentation.label.text,'影棚');
    remove();
    assert.equal(host.getSnapshot().fallbackPresentation.label.text,'影棚');
    locale='en';
    host.refresh();
    assert.equal(host.getSnapshot().fallbackPresentation.label.text,'Studio');
    assert.equal(host.getSnapshot().fallbackReason,'theme_removed');
  }finally{configureLocale(()=> 'zh-CN');}
});

test('a replacement catalog updates accessibility text while the label stays readable',()=>{
  const host=fixture();
  const catalogs=new PluginI18nRegistry();
  const dispose=catalogs.register('fixture.plugin','en',{'theme.name':'Studio','theme.a11y':'Studio theme'});
  const facts={requirementsAvailable:true,registeredNativeCapabilities:new Set()};
  const theme={...linearUiTheme,id:'fixture.theme',version:'1'};
  const contribution={packageId:'fixture.pkg',descriptor:parseUiContribution({
    id:'fixture.theme',kind:'theme',apiVersion:'1',platforms:['web'],
    presentation:{labelKey:'theme.name',a11yKey:'theme.a11y',i18nNamespace:'fixture.plugin'},
  })};
  const remove=host.registerContribution(contribution,{id:'fixture.theme',version:'1'},theme,catalogs,'web',facts,'en');
  host.activate({theme,layout:defaultUiLayout});
  assert.equal(host.getSnapshot().themePresentation.a11y.text,'Studio theme');
  dispose();
  catalogs.register('fixture.plugin','en',{'theme.a11y':'Updated accessible name'});
  host.refresh();
  const snapshot=host.getSnapshot();
  assert.equal(snapshot.themePresentation.label.text,'Studio');
  assert.equal(snapshot.themePresentation.a11y.text,'Updated accessible name');
  assert.deepEqual(snapshot.themePresentation.fallbackReasons,['key_missing','locale_missing']);
  remove();
  assert.equal(host.getSnapshot().fallbackPresentation.label.text,'Studio');
  assert.equal(host.getSnapshot().fallbackPresentation.a11y.text,'Updated accessible name');
});
