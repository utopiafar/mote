import {moteText} from '@mote/shared/i18n';
import {useEffect,useMemo} from 'react';
import type {Api} from '../../api';
import type {PageEntry,PageProps} from '../../features/types';
import {Overview} from '../../Overview';
import type {BuiltinWebPlugin} from '../types';
import {HomePluginContext,type HomePluginContextValue} from './context';
import {HomeController,createHomeController} from './controller';
import {HomeMaterialCache} from './material-reads';

export {HomeController,createHomeController,type HomeControllerOptions,type HomeRead,type HomeSnapshot} from './controller';
export {HomeMaterialCache,useMaterialPreview} from './material-reads';
export {HomePluginContext,type HomePluginContextValue} from './context';
export {useHomeController} from './hooks';

export interface HomePluginOptions {
  readonly api:Api;
  readonly captures?:number;
  readonly deviceIds?:readonly string[];
  /** Test/consumer seam; defaults create the plugin-owned instances. */
  readonly controller?:HomeController;
  readonly materials?:HomeMaterialCache;
}

/** The plugin factory creates the controller, cache and their reads once; the
 * page host activates/deactivates the same instance and only renders its
 * snapshot. */
export function createHomePlugin(options:HomePluginOptions){
  const controller=options.controller??createHomeController(options);
  const materials=options.materials??new HomeMaterialCache(options.api);
  const context:HomePluginContextValue={controller,materials};
  let active=false;
  return {
    id:'mote.home' as const,
    get controller():HomeController{return controller;},
    get materials():HomeMaterialCache{return materials;},
    get context():HomePluginContextValue{return context;},
    activate():HomeController{
      if(active)return controller;
      active=true;
      controller.start();
      materials.start();
      return controller;
    },
    deactivate():void{
      if(!active)return;
      active=false;
      controller.stop();
      materials.stop();
    },
    dispose():void{
      active=false;
      controller.dispose();
      materials.dispose();
    },
  };
}

export type HomePlugin=ReturnType<typeof createHomePlugin>;

/** The page boundary activates the factory instance. Direct component renders
 * (tests, embedded surfaces) use the same controller through this context. */
export function HomePage(props:PageProps){
  const plugin=useMemo(()=>createHomePlugin({api:props.api}),[props.api]);
  const ready=Boolean(props.status);
  useEffect(()=>{
    if(!ready){plugin.deactivate();return;}
    plugin.activate();
    return()=>plugin.deactivate();
  },[plugin,ready]);
  return <HomePluginContext.Provider value={plugin.context}>{props.status?<Overview api={props.api} status={props.status} devices={props.devices} insights={props.insights} onPage={props.onPage} onOpen={props.onOpen} range={props.range} onMedia={()=>{props.setArchiveTab('media');props.onPage('archive');}}/>:null}</HomePluginContext.Provider>;
}

export const pages:PageEntry[]=[{
  id:'overview',route:'today',label:moteText('首页'),featureId:'mote.home',
  render:(props:PageProps)=><HomePage {...props}/>,
}];

export const home:BuiltinWebPlugin={id:'mote.home',pages};
