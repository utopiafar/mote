import test from 'node:test';
import assert from 'node:assert/strict';
import {appearancePreference,resolveColorScheme,AppearanceStore} from '../dist/appearance.js';

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

test('both built-in palettes meet text and required-control contrast including statuses, selection and code',async()=>{
 const {linearUiTheme}=await import('../dist/ui-presentation.js');
 const luminance=hex=>{const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const ratio=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05);};
 for(const [scheme,t]of Object.entries(linearUiTheme.schemes)){
  for(const fg of ['ink','muted','accent','success','warning','danger'])for(const bg of ['background','surface','surface-raised','surface-sunken','surface-hover'])assert.ok(ratio(t[fg],t[bg])>=4.5,`${scheme} ${fg}/${bg}: ${ratio(t[fg],t[bg])}`);
  for(const [fg,bg]of [['primary-ink','primary-background'],['on-accent','accent'],['accent','tint'],['sidebar-ink','sidebar'],['sidebar-muted','sidebar'],['success','success-tint'],['warning','warning-tint'],['danger','danger-tint']])assert.ok(ratio(t[fg],t[bg])>=4.5,`${scheme} ${fg}/${bg}: ${ratio(t[fg],t[bg])}`);
  // Selected discovery summaries and native record timestamps retain muted text.
  assert.ok(ratio(t.muted,t.tint)>=4.5,`${scheme} muted/tint: ${ratio(t.muted,t.tint)}`);
  for(const bg of ['background','surface'])assert.ok(ratio(t['control-border'],t[bg])>=3,`${scheme} control/${bg}`);
 }
});
