import test from 'node:test';
import assert from 'node:assert/strict';
import {appearancePreference,resolveColorScheme,AppearanceStore} from '../dist/appearance.js';

const channels=hex=>hex.slice(1,7).match(/../g).map(x=>parseInt(x,16));
const luminance=hex=>{const rgb=channels(hex).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
const ratio=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05);};
const composite=(foreground,background)=>{const alpha=foreground.length===9?parseInt(foreground.slice(7,9),16)/255:1,back=channels(background);return '#'+channels(foreground).map((value,index)=>Math.round(value*alpha+back[index]*(1-alpha)).toString(16).padStart(2,'0')).join('');};

test('invalid and missing values default to auto; the preference remains distinct from the resolved color',()=>{
 for(const value of [undefined,null,'system','bogus',{},true])assert.equal(appearancePreference(value),'auto');
 for(const preference of ['light','dark','auto'])for(const systemDark of [false,true]){
  assert.equal(resolveColorScheme(preference,systemDark),preference==='auto'?(systemDark?'dark':'light'):preference);
 }
});
test('live OS changes affect only auto, and returning to auto resolves immediately without replacing UI state',()=>{
 const store=new AppearanceStore('auto',false);let changes=0;store.subscribe(()=>changes++);
 store.systemChanged(true);assert.deepEqual(store.getSnapshot(),{preference:'auto',scheme:'dark'});
 store.select('light');store.systemChanged(false);store.systemChanged(true);
 assert.deepEqual(store.getSnapshot(),{preference:'light',scheme:'light'});
 store.select('auto');assert.deepEqual(store.getSnapshot(),{preference:'auto',scheme:'dark'});
 const snapshot=store.getSnapshot();store.systemChanged(true);assert.equal(store.getSnapshot(),snapshot);
 assert.equal(changes,3);
});

test('palettes retain the final source muted color and contrast for other text and required controls',async()=>{
 const {linearUiTheme}=await import('../dist/ui-presentation.js');
 // The owner requires the exact final prototype. Its light secondary text is
 // #777066, superseding the implementation-only D34 adjustment. These five
 // source pairs range from 4.0485 to 4.4915; all other 4.5:1 checks stay intact.
 const sourcePairs=new Set(['muted/background','muted/surface-sunken','muted/surface-hover','sidebar-muted/sidebar','muted/tint']);
 for(const [scheme,t]of Object.entries(linearUiTheme.schemes)){
  if(scheme==='light'){assert.equal(t.muted,'#777066');assert.equal(t['sidebar-muted'],'#777066');}
  const check=(fg,bg)=>assert.ok(ratio(t[fg],t[bg])>=(scheme==='light'&&sourcePairs.has(`${fg}/${bg}`)?4.04:4.5),`${scheme} ${fg}/${bg}: ${ratio(t[fg],t[bg])}`);
  for(const fg of ['ink','muted','accent','success','warning','danger'])for(const bg of ['background','surface','surface-raised','surface-sunken','surface-hover'])check(fg,bg);
  for(const [fg,bg]of [['primary-ink','primary-background'],['on-accent','accent'],['accent','tint'],['sidebar-ink','sidebar'],['sidebar-muted','sidebar'],['success','success-tint'],['warning','warning-tint'],['danger','danger-tint']])check(fg,bg);
  // Selected discovery summaries and native record timestamps retain muted text.
  check('muted','tint');
  for(const bg of ['background','surface'])assert.ok(ratio(t['control-border'],t[bg])>=3,`${scheme} control/${bg}`);
 }
});
test('the final hair, fill and control colors keep ink readable on fills and the dark panel border visible',async()=>{
 const {linearUiTheme}=await import('../dist/ui-presentation.js');
 for(const [scheme,t]of Object.entries(linearUiTheme.schemes)){
  assert.equal(t.hair,scheme==='light'?'#e8e3db':'#302e2b');
  assert.equal(t.fill,scheme==='light'?'#2d2a2612':'#edebe814');
  assert.equal(t['control-border'],scheme==='light'?'#928a81':'#79726a');
  for(const bg of ['background','surface','surface-raised']){
   const filled=composite(t.fill,t[bg]);
   assert.ok(ratio(t.ink,filled)>=4.5,`${scheme} ink/fill over ${bg}: ${ratio(t.ink,filled)}`);
  }
  for(const bg of ['background','surface'])assert.ok(ratio(t['control-border'],t[bg])>=3,`${scheme} control/${bg}`);
  if(scheme==='dark')assert.ok(ratio(t['control-border'],t['surface-raised'])>=3,`${scheme} control/surface-raised: ${ratio(t['control-border'],t['surface-raised'])}`);
 }
});
test('phone and desktop radii follow the final shape table',async()=>{
 const {linearUiTheme}=await import('../dist/ui-presentation.js');
 for(const t of Object.values(linearUiTheme.schemes)){
  for(const [token,value]of Object.entries({
   'radius-thumb':'8px','radius-control':'8px','radius-container':'12px','radius-banner':'12px',
   'radius-panel':'14px','radius-segment':'10px','radius-bubble':'20px','radius-indicator':'999px',
   'radius-thumb-mobile':'10px','radius-control-mobile':'12px','radius-container-mobile':'16px',
   'radius-panel-mobile':'24px','radius-pill':'999px',
  }))assert.equal(t[token],value,token);
 }
});
