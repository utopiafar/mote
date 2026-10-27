import {UiPresentationHost,applyAppearanceTheme,type AppearanceStore,desktopUiLayout,linearUiTheme,uiDestinationPresentation,type UiDestination,type UiDestinationIcon,type UiLayoutProfile} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {DesktopPage,DesktopSection} from './navigation';

export type DesktopShellModel={section:DesktopSection};
export type DesktopShellSlots={root:HTMLElement;sidebar:HTMLElement;toolbar:HTMLElement;main:HTMLElement;navigate:(page:DesktopPage)=>void};
export type DesktopPresentationScope={
  readonly signal:AbortSignal;
  listen:(target:EventTarget,type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>()=>void;
  /** Register the disposer immediately after acquiring a subscription, timer or DOM effect. */
  effect:(cleanup:()=>void)=>()=>void;
};
export type DesktopLayoutSlots=DesktopShellSlots & {scope:DesktopPresentationScope};
export type DesktopLayoutRenderer={mount:(slots:DesktopLayoutSlots,layout:UiLayoutProfile)=>{update:(model:DesktopShellModel)=>void;dispose:()=>void}};

function createPresentationScope(root:HTMLElement){
  const Abort=root.ownerDocument.defaultView?.AbortController??AbortController,controller=new Abort();
  const cleanups=new Set<()=>void>();
  const effect=(cleanup:()=>void)=>{
    let released=false;
    const release=()=>{if(released)return;released=true;cleanups.delete(release);cleanup();};
    if(controller.signal.aborted)release();else cleanups.add(release);
    return release;
  };
  const scope:DesktopPresentationScope={signal:controller.signal,effect,listen(target,type,listener,options){
    if(controller.signal.aborted)return ()=>{};
    const capture=typeof options==='boolean'?options:Boolean(options?.capture);
    const guarded:EventListener=event=>{if(!controller.signal.aborted){if(typeof listener==='function')listener.call(target,event);else listener.handleEvent(event);}};
    target.addEventListener(type,guarded,options);
    return effect(()=>target.removeEventListener(type,guarded,capture));
  }};
  return {scope,abort(){controller.abort();},dispose(){controller.abort();const errors:unknown[]=[];for(const cleanup of [...cleanups].reverse())try{cleanup();}catch(error){errors.push(error);}return errors;}};
}
export const desktopDestination:Record<UiDestination,DesktopPage>={home:'overview',library:'records',ask:'ask',sources:'sources',activity:'work',connections:'connection'};
// The desktop connection destination is the central/device link, not Agent access.
const labels:Record<UiDestination,string>={...Object.fromEntries(Object.entries(uiDestinationPresentation).map(([id,item])=>[id,item.label])) as Record<UiDestination,string>,connections:'连接与设备'};
export const desktopIconSymbols:Record<UiDestinationIcon,string>={home:'home',library:'storage',ask:'ask',sources:'link',agent:'access',activity:'activity'};
const icons:Record<UiDestination,string>={...Object.fromEntries(Object.entries(uiDestinationPresentation).map(([id,item])=>[id,desktopIconSymbols[item.icon]])) as Record<UiDestination,string>,connections:'link'};

/** Presentation receives stable DOM slots and navigation commands, never the preload API.
 * Replacing it cannot recreate editors, restart work, or acquire platform capabilities. */
export const defaultDesktopRenderer:DesktopLayoutRenderer={
  mount(slots,layout){
    const nav=slots.sidebar.querySelector<HTMLElement>('.main-nav')!;
    const previous=Array.from(nav.childNodes),oldNavigation=slots.root.dataset.navigation,oldDetail=slots.root.dataset.detail;
    const locations=[slots.sidebar,slots.toolbar,slots.main].map(node=>({node,parent:node.parentNode!,next:node.nextSibling}));
    slots.scope.effect(()=>{nav.replaceChildren(...previous);for(const {node,parent,next} of [...locations].reverse())parent.insertBefore(node,next?.parentNode===parent?next:null);if(oldNavigation===undefined)delete slots.root.dataset.navigation;else slots.root.dataset.navigation=oldNavigation;if(oldDetail===undefined)delete slots.root.dataset.detail;else slots.root.dataset.detail=oldDetail;});
    slots.root.dataset.navigation=layout.navigation;slots.root.dataset.detail=layout.detail;
    const buttons=layout.primary.map(destination=>{
      const button=nav.ownerDocument.createElement('button');button.type='button';button.className='nav-item';button.dataset.nav=desktopDestination[destination];button.dataset.presentationNav='';
      if(destination==='ask')button.id='ask-central';
      const icon=nav.ownerDocument.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('class','icon');icon.setAttribute('aria-hidden','true');
      const use=nav.ownerDocument.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#icon-'+icons[destination]);icon.append(use);
      const label=nav.ownerDocument.createElement('span');label.textContent=moteText(labels[destination]);button.append(icon,label);return button;
    });
    nav.replaceChildren(...buttons);
    // The slots are real nodes, moved rather than cloned so all host-owned state survives.
    if(layout.navigation==='top')slots.root.insertBefore(slots.toolbar,slots.sidebar);
    const click=(event:Event)=>{const button=(event.target as Element).closest<HTMLButtonElement>('[data-presentation-nav]');if(button?.dataset.nav)slots.navigate(button.dataset.nav as DesktopPage);};
    slots.scope.listen(nav,'click',click);
    return {
      update(model){for(const button of buttons){const active=button.dataset.nav===model.section;button.classList.toggle('selected',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}},
      dispose(){/* The host owns all registered presentation resources. */},
    };
  },
};

/** A synchronous presentation transaction retains the actual nodes, form values and
 * DOM focus. A failed trusted renderer cannot consume or replace a host editor. */
function retainFocus(root:HTMLElement){
  const document=root.ownerDocument,focus=document.activeElement as HTMLElement|null;
  const selection=focus&&'selectionStart'in focus?{start:(focus as HTMLInputElement).selectionStart,end:(focus as HTMLInputElement).selectionEnd}:undefined;
  return ()=>{if(focus?.isConnected){focus.focus({preventScroll:true});if(selection?.start!==null&&selection?.start!==undefined)try{(focus as HTMLInputElement).setSelectionRange(selection.start,selection.end);}catch{/* Non-text platform controls do not have text selections. */}}};
}
function retainShell(root:HTMLElement){
  const focus=retainFocus(root);
  const nodes=[root,...Array.from(root.querySelectorAll<HTMLElement>('*'))].map(node=>({node,children:Array.from(node.childNodes),attributes:Array.from(node.attributes).map(attribute=>[attribute.name,attribute.value] as const),...('value'in node?{value:(node as HTMLInputElement).value}:{}),...('checked'in node?{checked:(node as HTMLInputElement).checked}:{})}));
  return ()=>{
    for(const {node,children,attributes,value,checked} of nodes){node.replaceChildren(...children);for(const attribute of Array.from(node.attributes))node.removeAttribute(attribute.name);for(const [name,text]of attributes)node.setAttribute(name,text);if(value!==undefined)(node as HTMLInputElement).value=value;if(checked!==undefined)(node as HTMLInputElement).checked=checked;}
    focus();
  };
}

export function createDesktopPresentation(slots:DesktopShellSlots,appearance?:AppearanceStore){
  const host=new UiPresentationHost<DesktopLayoutRenderer>({theme:linearUiTheme,layout:{...desktopUiLayout,implementation:defaultDesktopRenderer}});
  type Mounted={resources:ReturnType<typeof createPresentationScope>;handle?:ReturnType<DesktopLayoutRenderer['mount']>};
  let model:DesktopShellModel={section:'records'},mounted:Mounted|undefined,layout:unknown,restoreTheme:(()=>void)|undefined,disposed=false;
  const notice=slots.root.ownerDocument.createElement('p');notice.id='presentation-fallback';notice.className='helper';notice.setAttribute('role','status');notice.hidden=true;slots.main.prepend(notice);
  const stop=(rollback?:()=>void)=>{
    const current=mounted;mounted=undefined;
    current?.resources.abort();
    // Restore retained host nodes before registered DOM-effect cleanup removes
    // provider-owned decorations; no stale callback can issue commands now.
    rollback?.();
    const beforeCleanup=retainShell(slots.root),errors=current?.resources.dispose()??[];
    // A registered cleanup can mutate a host slot before failing. Retain its
    // pre-cleanup nodes too, so default recovery never mounts into detached slots.
    if(errors.length)beforeCleanup();
    const restore=retainShell(slots.root);
    try{current?.handle?.dispose();}catch(error){errors.push(error);restore();}
    return errors.length===0;
  };
  const mount=(renderer:DesktopLayoutRenderer,profile:UiLayoutProfile)=>{
    const resources=createPresentationScope(slots.root),current:Mounted={resources};mounted=current;
    const context:DesktopLayoutSlots={...slots,scope:resources.scope,navigate:page=>{if(!resources.scope.signal.aborted)slots.navigate(page);}};
    current.handle=renderer.mount(context,profile);current.handle.update(model);
  };
  const recover=(restore:()=>void)=>{
    stop(restore);mount(defaultDesktopRenderer,desktopUiLayout);
    slots.root.dataset.presentationFallback='layout_failed';notice.textContent=moteText('组件暂不可用');notice.hidden=false;
  };
  const update=()=>{const restore=retainShell(slots.root);try{mounted?.handle?.update(model);}catch{recover(restore);}};
  const render=()=>{
    const snapshot=host.getSnapshot();
    restoreTheme?.();
    const old=Object.keys(snapshot.theme.tokens).map(key=>{const name='--mote-'+key;return {name,value:slots.root.style.getPropertyValue(name),priority:slots.root.style.getPropertyPriority(name)};});
    const restoreRoot=appearance?applyAppearanceTheme(slots.root.ownerDocument.documentElement,snapshot.theme,appearance.getSnapshot().scheme):undefined;
    for(const [key,value] of Object.entries(appearance?snapshot.theme.schemes?.[appearance.getSnapshot().scheme]??snapshot.theme.tokens:snapshot.theme.tokens))slots.root.style.setProperty('--mote-'+key,value);
    slots.root.dataset.theme=snapshot.theme.id;
    restoreTheme=()=>{restoreRoot?.();for(const {name,value,priority} of old){if(value)slots.root.style.setProperty(name,value,priority);else slots.root.style.removeProperty(name);}};
    if(layout!==snapshot.layout){
      const focus=retainFocus(slots.root);
      layout=snapshot.layout;
      if(!stop()){recover(()=>{});focus();return;}
      const restore=retainShell(slots.root);
      try{mount(snapshot.layout.implementation,snapshot.layout);notice.hidden=true;delete slots.root.dataset.presentationFallback;}
      catch{recover(restore);}
      finally{focus();}
    }else update();
  };
  const unsubscribe=host.subscribe(render),stopAppearance=appearance?.subscribe(render);render();
  return {host,update(next:DesktopShellModel){if(disposed)return;model=next;update();},dispose(){if(disposed)return;disposed=true;unsubscribe();stopAppearance?.();try{stop();}finally{restoreTheme?.();notice.remove();delete slots.root.dataset.theme;delete slots.root.dataset.presentationFallback;}}};
}
