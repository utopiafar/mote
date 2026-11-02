import {FeatureRegistry} from './feature-packs.js';
import {linearThemeTokens,linearLightThemeTokens} from './ui-theme.generated.js';
import {PresentationContributionRegistry,resolveContributionPresentation,type PluginI18nRegistry,type ResolvedUiPresentation} from './plugin-i18n.js';
import {getLocale,type Locale} from './i18n.js';
import type {PluginPlatform,ScopedContribution,UiAvailabilityFacts} from './plugin-ui.js';

/** Presentation identities describe explicit owner-selected UI, never captured content. */
export type UiDestination='home'|'library'|'ask'|'sources'|'connections'|'activity';
export type UiReference={id:string;version:string};
export type UiThemePack=UiReference & {tokens:Readonly<Record<string,string>>;schemes?:Readonly<Record<'light'|'dark',Readonly<Record<string,string>>>>};
export type UiLayoutProfile=UiReference & {
  primary:readonly UiDestination[];
  initial:UiDestination;
  navigation:'sidebar'|'top'|'bottom'|'adaptive'|'home';
  detail:'split'|'stack';
};
export type UiLayoutPack<T>=UiLayoutProfile & {implementation:T};
export type UiPresentationSnapshot<T>={
  theme:UiThemePack;layout:UiLayoutPack<T>;
  themePresentation?:ResolvedUiPresentation;layoutPresentation?:ResolvedUiPresentation;
  fallbackReason?:'theme_removed'|'layout_removed';
  /** Runtime-resolved label of the contributed pack that was removed. */
  fallbackPresentation?:ResolvedUiPresentation;
};
export const linearUiTheme:UiThemePack=Object.freeze({id:'mote.linear',version:'1',tokens:Object.freeze({...linearThemeTokens}),schemes:Object.freeze({light:Object.freeze({...linearLightThemeTokens}),dark:Object.freeze({...linearThemeTokens})})});
export const defaultUiLayout:UiLayoutProfile=Object.freeze({id:'mote.central',version:'1',primary:Object.freeze(['home','library','sources','connections'] as UiDestination[]),initial:'home',navigation:'adaptive',detail:'split'});
export const desktopUiLayout:UiLayoutProfile=Object.freeze({...defaultUiLayout,id:'mote.desktop',primary:Object.freeze(['home','library','sources','ask'] as UiDestination[])});
export const androidUiLayout:UiLayoutProfile=Object.freeze({...defaultUiLayout,id:'mote.android',primary:Object.freeze(['home'] as UiDestination[]),navigation:'home',detail:'stack'});
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
  if(required.length<1||pack.primary.length!==required.length||new Set(pack.primary).size!==required.length||!pack.primary.every(id=>destinations.includes(id))||!required.every(id=>pack.primary.includes(id))||!required.includes(pack.initial)||!['sidebar','top','bottom','adaptive','home'].includes(pack.navigation)||!['split','stack'].includes(pack.detail)||pack.implementation==null)throw Error('Incompatible layout contract');
  if((pack.navigation==='home')!==(pack.primary.length===1)||pack.navigation==='home'&&(pack.initial!=='home'||pack.primary[0]!=='home'||pack.detail!=='stack'))throw Error('Incompatible home layout contract');
  return Object.freeze({...pack,primary:Object.freeze([...pack.primary])});
}

type PresentationSource={contribution:ScopedContribution;catalogs:PluginI18nRegistry;platform:PluginPlatform;facts:UiAvailabilityFacts};

/** Keep the last readable label but take the newly resolved glyph/a11y roles,
 * so a replacement catalog that only updates accessibility text is not lost.
 * When the accessible name was derived from the label, it follows the label. */
function mergeReadableLabel(resolved:ResolvedUiPresentation,cached?:ResolvedUiPresentation):ResolvedUiPresentation{
  if(!cached)return resolved;
  const label={text:cached.label.text,...(resolved.label.fallback?{fallback:resolved.label.fallback}:{})};
  const a11yWasLabel=resolved.a11y.text===resolved.label.text;
  const a11y=a11yWasLabel?{text:label.text,...(label.fallback?{fallback:label.fallback}:{})}:resolved.a11y;
  const fallbackReasons=[...new Set([label,resolved.glyph,a11y].flatMap(item=>item?.fallback?[item.fallback]:[]))];
  return {routeId:resolved.routeId,label,...(resolved.glyph?{glyph:resolved.glyph}:{}),a11y,fallbackReasons};
}

/** Trusted platform implementations stay local; only metadata and role values are portable.
 * The host owns data, commands, drafts and navigation. Activating a pack changes presentation only. */
export class UiPresentationHost<T> {
  private readonly registry=new FeatureRegistry<UiThemePack|UiLayoutPack<T>>();
  private readonly sources=new Map<string,PresentationSource>();
  private readonly lastPresentations=new Map<string,ResolvedUiPresentation>();
  private fallback?:{source:PresentationSource;presentation:ResolvedUiPresentation};
  private readonly bindings=new PresentationContributionRegistry();
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
  private register(surface:'theme'|'layout',value:UiThemePack|UiLayoutPack<T>,pinned=false,source?:PresentationSource){
    const id=surface+':'+reference(value),featureId='ui.'+surface+'.'+reference(value),descriptor={id,version:value.version,surface};
    const removeFeature=this.registry.install({id:featureId,version:value.version,components:[descriptor]});
    const removeValue=this.registry.register(featureId,descriptor,value);
    const key=surface+':'+reference(value);
    if(source)this.sources.set(key,source);
    let disposed=false;
    return ()=>{
      if(disposed||pinned)return;disposed=true;removeValue();removeFeature();
      const removed=this.sources.get(key);
      const removedPresentation=removed?this.presentation(surface,value):undefined;
      this.sources.delete(key);
      this.lastPresentations.delete(key);
      if(reference(this.snapshot[surface])===reference(value)){
        const next:UiPresentationSnapshot<T>={...this.snapshot,[surface]:this.defaults[surface],fallbackReason:surface==='theme'?'theme_removed':'layout_removed'};
        if(surface==='theme')delete next.themePresentation;else delete next.layoutPresentation;
        if(removed&&removedPresentation){next.fallbackPresentation=removedPresentation;this.fallback={source:removed,presentation:removedPresentation};}
        else{delete next.fallbackPresentation;this.fallback=undefined;}
        this.publish(next);
      }
    };
  }
  registerTheme(pack:UiThemePack,source?:PresentationSource){return this.register('theme',validateUiTheme(pack),false,source);}
  registerLayout(pack:UiLayoutPack<T>,source?:PresentationSource){return this.register('layout',layout(pack,this.defaults.layout.primary),false,source);}
  private presentation(surface:'theme'|'layout',value:UiReference){
    const key=surface+':'+reference(value),source=this.sources.get(key);
    if(!source)return undefined;
    const resolved=resolveContributionPresentation(source.contribution.descriptor,source.catalogs,getLocale());
    // A catalog may unregister while its pack is still active. Keep the last
    // readable label instead of exposing the internal key; an English
    // translation for a missing target locale is still readable.
    const unreadable=resolved.label.fallback==='key_missing'||resolved.label.fallback==='namespace_missing';
    if(!unreadable){this.lastPresentations.set(key,resolved);return resolved;}
    const merged=mergeReadableLabel(resolved,this.lastPresentations.get(key));
    if(merged.label.fallback!=='key_missing'&&merged.label.fallback!=='namespace_missing')this.lastPresentations.set(key,merged);
    return merged;
  }
  /** Re-resolve the active contributed labels from the current runtime locale. */
  refresh(){
    const themePresentation=this.presentation('theme',this.snapshot.theme);
    const layoutPresentation=this.presentation('layout',this.snapshot.layout);
    const next:UiPresentationSnapshot<T>={...this.snapshot};
    if(themePresentation)next.themePresentation=themePresentation;else delete next.themePresentation;
    if(layoutPresentation)next.layoutPresentation=layoutPresentation;else delete next.layoutPresentation;
    if(this.fallback){
      const resolved=resolveContributionPresentation(this.fallback.source.contribution.descriptor,this.fallback.source.catalogs,getLocale());
      const unreadable=resolved.label.fallback==='key_missing'||resolved.label.fallback==='namespace_missing';
      const presentation=unreadable?mergeReadableLabel(resolved,this.fallback.presentation):resolved;
      this.fallback={source:this.fallback.source,presentation};
      next.fallbackPresentation=presentation;
    }else delete next.fallbackPresentation;
    return this.publish(next);
  }
  /** Registers a contributed theme/layout only when the explicit reference
   * names the exact pack identity and the contribution is active. Labels
   * resolve from the stored source at activation/render time against the
   * runtime locale; removal restores the builtin pack and publishes the
   * removed pack's label as an explicit fallback reason. */
  registerContribution(
    contribution:ScopedContribution,
    packReference:UiReference,
    pack:UiThemePack|UiLayoutPack<T>,
    catalogs:PluginI18nRegistry,
    platform:PluginPlatform,
    facts:UiAvailabilityFacts,
    locale?:Locale,
  ){
    const kind=contribution.descriptor.kind;
    if(kind!=='theme'&&kind!=='layout')throw new TypeError('Not a theme or layout contribution');
    if(packReference.id!==pack.id||packReference.version!==pack.version)throw new Error('Presentation reference does not match the pack');
    const removeMapping=this.bindings.register(contribution,packReference);
    try{
      const binding=this.bindings.bind(contribution,catalogs,platform,facts,locale);
      if(binding.kind!==kind||binding.reference.id!==pack.id||binding.reference.version!==pack.version)throw new Error('Presentation binding does not match the pack');
      if(binding.availability.state!=='active')throw new Error('Presentation contribution is not active: '+binding.availability.state);
      const source:PresentationSource={contribution,catalogs,platform,facts};
      const removePack=kind==='theme'
        ?this.registerTheme(pack as UiThemePack,source)
        :this.registerLayout(pack as UiLayoutPack<T>,source);
      return ()=>{removePack();removeMapping();};
    }catch(error){removeMapping();throw error;}
  }
  activate(binding:{theme:UiReference;layout:UiReference}){
    const theme=this.registry.get('theme:'+reference(binding.theme)) as UiThemePack|undefined;
    const selected=this.registry.get('layout:'+reference(binding.layout)) as UiLayoutPack<T>|undefined;
    if(!theme||!selected)throw Error('Presentation provider unavailable');
    const themePresentation=this.presentation('theme',binding.theme);
    const layoutPresentation=this.presentation('layout',binding.layout);
    this.fallback=undefined;
    return this.publish({theme,layout:selected,...(themePresentation?{themePresentation}:{}),...(layoutPresentation?{layoutPresentation}:{})});
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
