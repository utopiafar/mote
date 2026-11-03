import {moteText} from '@mote/shared/i18n';
import {useEffect,useMemo,type ReactNode} from 'react';
import type {Api} from '../../api';
import type {PageEntry,PageProps} from '../../features/types';
import {MaintenanceFrame} from '../../MaintenanceFrame';
import type {BuiltinWebPlugin} from '../types';
import {ContentStorage} from './ContentStorage';
import {MaintenanceContext} from './context';
import {MaintenanceController,createMaintenanceController} from './controller';
import {StorageStatistics} from './StorageStatistics';
import {Usage} from './Usage';
import {Vault} from './Vault';

export {ContentStorage} from './ContentStorage';
export {MaintenanceController,createMaintenanceController} from './controller';
export type {ContentStorageState,MaintenanceControllerOptions,MaintenanceReadName,MaintenanceSnapshot} from './controller';
export {MaintenanceContext,type MaintenancePluginContextValue} from './context';
export {useMaintenanceController,useMaintenanceSnapshot,useMaintenanceWatch} from './hooks';
export {provideMaintenanceDownload,maintenanceFailure,maintenanceTechnicalFailure,useMaintenanceTransfer} from './maintenance-transfer';
export {StorageStatistics} from './StorageStatistics';
export {Usage,UsageGroups,TurnUsage} from './Usage';
export {Vault} from './Vault';

export interface MaintenancePluginOptions {
  readonly api:Api;
  /** Test/consumer seam; defaults create the plugin-owned controller. */
  readonly controller?:MaintenanceController;
}

/** The maintenance package owns the low-frequency storage, statistics and
 * usage surfaces plus the durable archive handoff. Activate starts the
 * controller; dispose releases the same instance. */
export function createMaintenancePlugin(options:MaintenancePluginOptions){
  const controller=options.controller??createMaintenanceController({api:options.api});
  const context={controller};
  let active=false;
  return {
    id:'mote.maintenance' as const,
    get controller():MaintenanceController{return controller;},
    get context():{controller:MaintenanceController}{return context;},
    activate():MaintenanceController{
      if(active)return controller;
      active=true;
      controller.start();
      return controller;
    },
    deactivate():void{
      if(!active)return;
      active=false;
      controller.stop();
    },
    dispose():void{
      active=false;
      controller.dispose();
    },
  };
}

export type MaintenancePlugin=ReturnType<typeof createMaintenancePlugin>;

/** One plugin-owned controller spans the maintenance page and its embedded
 * storage details, so reads, polling and the transfer receipt share one scope. */
export function MaintenancePage({api,children}:{api:Api;children:ReactNode}){
  const plugin=useMemo(()=>createMaintenancePlugin({api}),[api]);
  useEffect(()=>{
    plugin.activate();
    return()=>plugin.deactivate();
  },[plugin]);
  return <MaintenanceContext.Provider value={plugin.context}>{children}</MaintenanceContext.Provider>;
}

const storagePages:PageEntry[]=[
  {id:'vault',route:'system/storage',get label(){return moteText('存储与备份');},section:'system',order:6,featureId:'mote.storage',render:({api,status,refresh,disconnect}:PageProps)=>status?<MaintenancePage api={api}><MaintenanceFrame title={moteText('存储与备份')}><Vault api={api} embedded status={status} refresh={refresh} disconnect={disconnect}><ContentStorage api={api} onChange={refresh}/></Vault></MaintenanceFrame></MaintenancePage>:null},
  {id:'statistics',route:'system',get label(){return moteText("运行状态与空间");},section:'system',order:0,featureId:'mote.storage',render:({api,onPage}:PageProps)=><MaintenancePage api={api}><StorageStatistics api={api} onUsage={()=>onPage("usage")}/></MaintenancePage>},
];

const usagePages:PageEntry[]=[
  {id:'usage',route:'system/usage',label:moteText('用量与费用'),section:'system',order:5,featureId:'mote.usage',render:({api}:PageProps)=><MaintenancePage api={api}><Usage api={api}/></MaintenancePage>},
];

/** The maintenance package keeps the former storage and usage package
 * identities; both contributions share the same durable transfer controller. */
export const storage:BuiltinWebPlugin={id:'mote.storage',pages:storagePages};
export const usage:BuiltinWebPlugin={id:'mote.usage',pages:usagePages};
