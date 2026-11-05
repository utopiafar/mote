import {afterEach,expect,it,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {desktopUiLayout,linearUiTheme,uiDestinationPresentation} from '@mote/shared';
import {createDesktopPresentation,defaultDesktopRenderer,desktopDestination,type DesktopLayoutRenderer,type DesktopPresentationScope} from '../src/presentation';

let dom:JSDOM|undefined;
afterEach(()=>{dom?.window.close();});
it('replaces a real layout and theme without recreating editors or duplicating navigation commands',()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://generated.invalid'});
  const document=dom.window.document,root=document.body,navigate=vi.fn();
  const slots={root,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:document.getElementById('main-content')!,navigate};
  const originalOrder=Array.from(root.childNodes),editor=document.getElementById('note-text') as HTMLTextAreaElement;
  editor.value='Generated unsaved note';
  const shell=createDesktopPresentation(slots);shell.update({section:'sources'});
  expect(Array.from(document.querySelectorAll('.main-nav [data-nav]')).map(node=>(node as HTMLElement).dataset.nav)).toEqual(['overview','records','sources','ask']);
  expect(document.querySelector('.main-nav [aria-current=page]')?.getAttribute('data-nav')).toBe('sources');
  const remove=shell.host.registerLayout({...desktopUiLayout,id:'fixture.top',navigation:'top',primary:['sources','ask','library','home'],implementation:defaultDesktopRenderer});
  const theme={...linearUiTheme,id:'fixture.theme',tokens:{...linearUiTheme.tokens,background:'#101010'}};
  const removeTheme=shell.host.registerTheme(theme);
  shell.host.activate({theme,layout:{id:'fixture.top',version:'1'}});
  expect(root.dataset.navigation).toBe('top');expect(root.style.getPropertyValue('--mote-background')).toBe('#101010');
  expect(slots.toolbar.nextElementSibling).toBe(slots.sidebar);
  expect(document.getElementById('note-text')).toBe(editor);expect(editor.value).toBe('Generated unsaved note');
  document.querySelector<HTMLButtonElement>('.main-nav [data-nav=ask]')!.click();expect(navigate.mock.calls).toEqual([['ask']]);
  remove();removeTheme();
  expect(root.dataset.navigation).toBe('adaptive');expect(root.style.getPropertyValue('--mote-background')).toBe(linearUiTheme.tokens.background);
  expect(document.getElementById('note-text')).toBe(editor);expect(editor.value).toBe('Generated unsaved note');
  document.querySelector<HTMLButtonElement>('.main-nav [data-nav=ask]')!.click();expect(navigate.mock.calls).toEqual([['ask'],['ask']]);
  shell.dispose();expect(Array.from(root.childNodes)).toEqual(originalOrder);expect(root.style.getPropertyValue('--mote-background')).toBe('');
});

it('renders the shared desktop destinations with Settings last in the sidebar',()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://generated.invalid'});
  const document=dom.window.document,root=document.body,navigate=vi.fn();
  const slots={root,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:document.getElementById('main-content')!,navigate};
  const shell=createDesktopPresentation(slots);
  const items=Array.from(document.querySelectorAll<HTMLElement>('.sidebar .nav-item[data-nav]'));
  expect(items.map(node=>node.dataset.nav)).toEqual([...desktopUiLayout.primary.map(id=>desktopDestination[id]),'settings']);
  expect(items.map(node=>node.querySelector('span:not([aria-hidden]):not(.pending-dot)')!.textContent)).toEqual([...desktopUiLayout.primary.map(id=>uiDestinationPresentation[id].label),'设置']);
  expect(items.map(node=>node.querySelector('use')!.getAttribute('href'))).toEqual(['#icon-home','#icon-layers','#icon-plug','#icon-ask','#icon-settings']);
  expect(document.querySelector('.sidebar>.sidebar-titlebar')).not.toBeNull();
  expect(document.querySelector('.sidebar [data-nav=work]')).toBeNull();
  expect(document.getElementById('central')).toBeNull();
  expect(document.querySelector('.sidebar-device, #sidebar-device, #sidebar-state')).toBeNull();
  shell.dispose();
});

it('isolates a throwing renderer and restores the default around the same focused editor',()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://generated.invalid'});
  const document=dom.window.document,root=document.body,navigate=vi.fn();
  const slots={root,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:document.getElementById('main-content')!,navigate};
  const shell=createDesktopPresentation(slots),editor=document.getElementById('note-text') as HTMLTextAreaElement;
  editor.value='Generated unsaved focused original';editor.focus();editor.setSelectionRange(4,12);shell.update({section:'ask'});
  shell.host.registerLayout({...desktopUiLayout,id:'fixture.throwing',implementation:{mount(context){context.main.replaceChildren();context.sidebar.remove();editor.value='Generated discarded renderer mutation';throw Error('Generated renderer failure');}}});
  expect(()=>shell.host.activate({theme:linearUiTheme,layout:{id:'fixture.throwing',version:'1'}})).not.toThrow();
  expect(root.dataset.presentationFallback).toBe('layout_failed');expect(root.dataset.navigation).toBe(desktopUiLayout.navigation);
  expect(document.getElementById('note-text')).toBe(editor);expect(editor.value).toBe('Generated unsaved focused original');expect(document.activeElement).toBe(editor);expect(editor.selectionStart).toBe(4);expect(editor.selectionEnd).toBe(12);
  expect(document.getElementById('presentation-fallback')!.hidden).toBe(false);
  expect(document.querySelectorAll('.main-nav [aria-current=page]')).toHaveLength(1);
  document.querySelector<HTMLButtonElement>('.main-nav [data-nav=ask]')!.click();expect(navigate).toHaveBeenCalledOnce();
  shell.host.activate({theme:linearUiTheme,layout:desktopUiLayout});expect(document.getElementById('presentation-fallback')!.hidden).toBe(true);expect(root.dataset.presentationFallback).toBeUndefined();
  shell.dispose();
});

it('releases partial mount listeners and subscriptions even when setup or a cleanup throws',()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://generated.invalid'});
  const document=dom.window.document,root=document.body,navigate=vi.fn();
  const slots={root,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:document.getElementById('main-content')!,navigate};
  const shell=createDesktopPresentation(slots),subscribers=new Set<()=>void>(),subscription=vi.fn(),released=vi.fn();
  let scope!:DesktopPresentationScope,staleNavigate!:()=>void;
  shell.host.registerLayout({...desktopUiLayout,id:'fixture.partial',implementation:{mount(context){
    scope=context.scope;staleNavigate=()=>context.navigate('settings');
    context.scope.listen(root,'click',()=>context.navigate('settings'));
    root.addEventListener('click',()=>context.navigate('settings'),{signal:context.scope.signal});
    subscribers.add(subscription);context.scope.effect(()=>{subscribers.delete(subscription);released();});
    context.scope.effect(()=>{throw Error('Generated cleanup failure');});
    throw Error('Generated setup failure after resource acquisition');
  }}});
  shell.host.activate({theme:linearUiTheme,layout:{id:'fixture.partial',version:'1'}});
  expect(scope.signal.aborted).toBe(true);expect(subscribers.size).toBe(0);expect(released).toHaveBeenCalledOnce();
  document.querySelector<HTMLButtonElement>('.main-nav [data-nav=ask]')!.click();staleNavigate();
  expect(navigate.mock.calls).toEqual([['ask']]);expect(root.dataset.presentationFallback).toBe('layout_failed');
  shell.dispose();root.click();for(const subscriber of subscribers)subscriber();
  expect(navigate.mock.calls).toEqual([['ask']]);expect(subscription).not.toHaveBeenCalled();expect(released).toHaveBeenCalledOnce();
});

it('restores attached host slots when a registered cleanup mutates the DOM before throwing',()=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'));
  const document=dom.window.document,root=document.body,navigate=vi.fn();
  const slots={root,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:document.getElementById('main-content')!,navigate};
  const shell=createDesktopPresentation(slots),editor=document.getElementById('note-text') as HTMLTextAreaElement;
  editor.value='Generated draft survives a partial cleanup';
  const remove=shell.host.registerLayout({...desktopUiLayout,id:'fixture.cleanup',implementation:{mount(context){
    context.scope.effect(()=>{context.sidebar.remove();editor.value='Generated discarded cleanup mutation';throw Error('Generated partial cleanup failure');});
    return {update(){},dispose(){}};
  }}});
  shell.host.activate({theme:linearUiTheme,layout:{id:'fixture.cleanup',version:'1'}});
  remove();
  expect(document.querySelector('.sidebar')).toBe(slots.sidebar);expect(slots.sidebar.isConnected).toBe(true);
  expect(document.getElementById('note-text')).toBe(editor);expect(editor.value).toBe('Generated draft survives a partial cleanup');
  expect(root.dataset.presentationFallback).toBe('layout_failed');
  document.querySelector<HTMLButtonElement>('.main-nav [data-nav=ask]')!.click();expect(navigate.mock.calls).toEqual([['ask']]);
  shell.dispose();
});

it.each(['update','dispose'] as const)('cleans the active mount scope before default recovery after a %s failure',failure=>{
  dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://generated.invalid'});
  const document=dom.window.document,root=document.body,navigate=vi.fn();
  const slots={root,sidebar:document.querySelector<HTMLElement>('.sidebar')!,toolbar:document.querySelector<HTMLElement>('.workspace-toolbar')!,main:document.getElementById('main-content')!,navigate};
  const shell=createDesktopPresentation(slots),subscribers=new Set<()=>void>(),subscription=vi.fn();
  let scope!:DesktopPresentationScope,fail=false;
  const implementation:DesktopLayoutRenderer={mount(context,layout){
    scope=context.scope;const normal=defaultDesktopRenderer.mount(context,layout);
    context.scope.listen(root,'click',()=>context.navigate('settings'));
    subscribers.add(subscription);context.scope.effect(()=>subscribers.delete(subscription));
    return {update(model){if(fail&&failure==='update')throw Error('Generated update failure');normal.update(model);},dispose(){if(failure==='dispose')throw Error('Generated dispose failure');normal.dispose();}};
  }};
  const remove=shell.host.registerLayout({...desktopUiLayout,id:'fixture.active',implementation});
  shell.host.activate({theme:linearUiTheme,layout:{id:'fixture.active',version:'1'}});
  expect(scope.signal.aborted).toBe(false);expect(subscribers.size).toBe(1);
  if(failure==='update'){fail=true;shell.update({section:'ask'});}else remove();
  expect(scope.signal.aborted).toBe(true);expect(subscribers.size).toBe(0);expect(root.dataset.presentationFallback).toBe('layout_failed');
  document.querySelector<HTMLButtonElement>('.main-nav [data-nav=ask]')!.click();expect(navigate.mock.calls).toEqual([['ask']]);
  shell.dispose();root.click();expect(navigate.mock.calls).toEqual([['ask']]);
});
