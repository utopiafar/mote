import {useContext, useEffect, useMemo, useSyncExternalStore} from 'react';
import type {Api} from '../../api';
import {MaintenanceContext} from './context';
import {createMaintenanceController, type MaintenanceController, type MaintenanceReadName, type MaintenanceSnapshot} from './controller';

/** A provided plugin owns the controller; direct renders (tests, embedded
 * settings) start and stop one for that Api. */
export function useMaintenanceController(api:Api,refresh?:()=>void):MaintenanceController{
  const context=useContext(MaintenanceContext);
  const standalone=useMemo(()=>context?.controller.api===api?undefined:createMaintenanceController({api}),[context,api]);
  const controller=context?.controller.api===api?context.controller:standalone!;
  useEffect(()=>{
    const release=controller.attach();
    if(standalone)standalone.start();
    return()=>{release();standalone?.stop();};
  },[controller,standalone]);
  useEffect(()=>{if(refresh)controller.setRefresh(refresh);},[controller,refresh]);
  return controller;
}

/** Declares the read a mounted surface needs; hiding releases it. */
export function useMaintenanceWatch(controller:MaintenanceController,name:MaintenanceReadName):void{
  useEffect(()=>controller.watch(name),[controller,name]);
}

export function useMaintenanceSnapshot(controller:MaintenanceController):MaintenanceSnapshot{
  return useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
}
