import {FeatureRegistry} from './feature-packs.js';
import {linearThemeTokens,linearLightThemeTokens} from './ui-theme.generated.js';

/** Presentation identities describe explicit owner-selected UI, never captured content. */
export type UiDestination='home'|'library'|'ask'|'sources'|'connections'|'activity';
export type UiReference={id:string;version:string};
export type UiThemePack=UiReference & {tokens:Readonly<Record<string,string>>;schemes?:Readonly<Record<'light'|'dark',Readonly<Record<string,string>>>>};
export type UiLayoutProfile=UiReference & {
  primary:readonly UiDestination[];
  initial:UiDestination;
  navigation:'sidebar'|'top'|'bottom'|'adaptive';
  detail:'split'|'stack';
};
export type UiLayoutPack<T>=UiLayoutProfile & {implementation:T};
export type UiPresentationSnapshot<T>={theme:UiThemePack;layout:UiLayoutPack<T>;fallbackReason?:'theme_removed'|'layout_removed'};
export const linearUiTheme:UiThemePack=Object.freeze({id:'mote.linear',version:'1',tokens:Object.freeze({...linearThemeTokens}),schemes:Object.freeze({light:Object.freeze({...linearLightThemeTokens}),dark:Object.freeze({...linearThemeTokens})})});
export const defaultUiLayout:UiLayoutProfile=Object.freeze({id:'mote.central',version:'1',primary:Object.freeze(['home','library','sources','connections'] as UiDestination[]),initial:'home',navigation:'adaptive',detail:'split'});
export const desktopUiLayout:UiLayoutProfile=Object.freeze({...defaultUiLayout,id:'mote.desktop',primary:Object.freeze(['home','library','sources','ask'] as UiDestination[])});
export const androidUiLayout:UiLayoutProfile=Object.freeze({...defaultUiLayout,id:'mote.android',primary:Object.freeze(['home','library','ask','sources'] as UiDestination[])});
/** Semantic glyph roles; each client maps them to its own icon set. */
export type UiDestinationIcon='home'|'library'|'ask'|'sources'|'agent'|'activity';
/** One owner-facing name and glyph per destination, so every client uses the same words. */
export const uiDestinationPresentation:Readonly<Record<UiDestination,Readonly<{label:string;icon:UiDestinationIcon}>>>=Object.freeze({
  home:Object.freeze({label:'首页',icon:'home'}),
  library:Object.freeze({label:'资料库',icon:'library'}),
  ask:Object.freeze({label:'问一问',icon:'ask'}),
  sources:Object.freeze({label:'来源',icon:'sources'}),
  connections:Object.freeze({label:'AI 接入',icon:'agent'}),
  activity:Object.freeze({label:'活动',icon:'activity'}),
});
export const moteBrand=Object.freeze({name:'Mote',tagline:'你的个人上下文'});

function reference(value:UiReference){if(!/^[a-z][a-z0-9.-]*$/.test(value.id)||!/^\d+(?:\.\d+)*$/.test(value.version))throw Error('Invalid presentation identity');return value.id+'@'+value.version;}
/** Theme data is role values only, never a stylesheet, resource loader or executable UI. */
export function validateUiTheme(pack:UiThemePack):UiThemePack {
  reference(pack);
  const expected=Object.keys(linearThemeTokens).sort(),keys=Object.keys(pack.tokens).sort();
  if(JSON.stringify(expected)!==JSON.stringify(keys))throw Error('Incompatible theme roles');
  for(const [key,value] of Object.entries(pack.tokens)){
    if(typeof value!=='string'||!value.trim()||/[;{}<>\\]|url\s*\(|@import|expression\s*\(/i.test(value))throw Error('Invalid theme role: '+key);
    const base=linearThemeTokens[key as keyof typeof linearThemeTokens];
    if(base.startsWith('#')&&!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value))throw Error('Invalid theme color: '+key);
    if(/^\d+px$/.test(base)&&!/^\d+(?:\.\d+)?px$/.test(value))throw Error('Invalid theme dimension: '+key);
    if(/^\d+(?:\.\d+)?$/.test(base)&&!/^\d+(?:\.\d+)?$/.test(value))throw Error('Invalid theme number: '+key);
  }
  const schemes=pack.schemes ? Object.freeze({light:validateUiTheme({id:pack.id,version:pack.version,tokens:pack.schemes.light}).tokens,dark:validateUiTheme({id:pack.id,version:pack.version,tokens:pack.schemes.dark}).tokens}) : undefined;
  return Object.freeze({id:pack.id,version:pack.version,tokens:Object.freeze({...pack.tokens}),...(schemes?{schemes}:{})});
}
function layout<T>(pack:UiLayoutPack<T>,required:readonly UiDestination[]=pack.primary):UiLayoutPack<T>{
  reference(pack);
  const destinations:UiDestination[]=['home','library','ask','sources','connections','activity'];
  if(pack.primary.length!==4||required.length!==4||new Set(pack.primary).size!==required.length||!pack.primary.every(id=>destinations.includes(id))||!required.every(id=>pack.primary.includes(id))||!required.includes(pack.initial)||!['sidebar','top','bottom','adaptive'].includes(pack.navigation)||!['split','stack'].includes(pack.detail)||pack.implementation==null)throw Error('Incompatible layout contract');
  return Object.freeze({...pack,primary:Object.freeze([...pack.primary])});
}

/** Trusted platform implementations stay local; only metadata and role values are portable.
 * The host owns data, commands, drafts and navigation. Activating a pack changes presentation only. */
export class UiPresentationHost<T> {
  private readonly registry=new FeatureRegistry<UiThemePack|UiLayoutPack<T>>();
  private readonly listeners=new Set<()=>void>();
  private readonly defaults:{theme:UiThemePack;layout:UiLayoutPack<T>};
  private snapshot:UiPresentationSnapshot<T>;
  private notificationErrors:readonly unknown[]=[];
  constructor(defaults:{theme:UiThemePack;layout:UiLayoutPack<T>}){
    this.defaults={theme:validateUiTheme(defaults.theme),layout:layout(defaults.layout)};
    this.snapshot=Object.freeze({...this.defaults});
    this.register('theme',this.defaults.theme,true);this.register('layout',this.defaults.layout,true);
  }
  getSnapshot=()=>this.snapshot;
  /** Trusted host adapters can report observer failures without splitting the committed binding. */
  getNotificationErrors=()=>this.notificationErrors;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  private publish(snapshot:UiPresentationSnapshot<T>){
    this.snapshot=Object.freeze(snapshot);
    const errors:unknown[]=[];
    for(const listener of this.listeners)try{listener();}catch(error){errors.push(error);}
    this.notificationErrors=Object.freeze(errors);
    return this.notificationErrors;
  }
  private register(surface:'theme'|'layout',value:UiThemePack|UiLayoutPack<T>,pinned=false){
    const id=surface+':'+reference(value),featureId='ui.'+surface+'.'+reference(value),descriptor={id,version:value.version,surface};
    const removeFeature=this.registry.install({id:featureId,version:value.version,components:[descriptor]});
    const removeValue=this.registry.register(featureId,descriptor,value);
    let disposed=false;
    return ()=>{
      if(disposed||pinned)return;disposed=true;removeValue();removeFeature();
      if(reference(this.snapshot[surface])===reference(value))this.publish({...this.snapshot,[surface]:this.defaults[surface],fallbackReason:surface==='theme'?'theme_removed':'layout_removed'});
    };
  }
  registerTheme(pack:UiThemePack){return this.register('theme',validateUiTheme(pack));}
  registerLayout(pack:UiLayoutPack<T>){return this.register('layout',layout(pack,this.defaults.layout.primary));}
  activate(binding:{theme:UiReference;layout:UiReference}){
    const theme=this.registry.get('theme:'+reference(binding.theme)) as UiThemePack|undefined;
    const selected=this.registry.get('layout:'+reference(binding.layout)) as UiLayoutPack<T>|undefined;
    if(!theme||!selected)throw Error('Presentation provider unavailable');
    return this.publish({theme,layout:selected});
  }
}

/** Applies colors in place. Business nodes, focus, dialogs and navigation remain mounted. */
export function applyAppearanceTheme(root:HTMLElement,theme:UiThemePack,scheme:'light'|'dark') {
  const tokens=theme.schemes?.[scheme]??theme.tokens;
  const names=[...Object.keys(tokens).map(key=>'--mote-'+key),'color-scheme','background-color'];
  const previous=names.map(name=>({name,value:root.style.getPropertyValue(name),priority:root.style.getPropertyPriority(name)}));
  const previousScheme=root.dataset.colorScheme;
  const meta=root.ownerDocument.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),previousMeta=meta?.content;
  for(const [key,value] of Object.entries(tokens))root.style.setProperty('--mote-'+key,value);
  const channels=[1,3,5].map(index=>Number.parseInt(tokens.background.slice(index,index+2),16));
  const nativeScheme=theme.schemes?scheme:(channels[0]*299+channels[1]*587+channels[2]*114)/1000<128?'dark':'light';
  root.dataset.colorScheme=nativeScheme;
  root.style.colorScheme=nativeScheme;
  root.style.backgroundColor=tokens.background;
  if(meta)meta.content=tokens.background;
  return ()=>{
    for(const {name,value,priority} of previous){if(value)root.style.setProperty(name,value,priority);else root.style.removeProperty(name);}
    if(previousScheme===undefined)delete root.dataset.colorScheme;else root.dataset.colorScheme=previousScheme;
    if(meta&&previousMeta!==undefined)meta.content=previousMeta;
  };
}
