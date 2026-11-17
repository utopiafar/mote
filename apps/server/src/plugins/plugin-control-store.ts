import type {PluginPackageView,PluginInstanceView} from '@mote/shared';
import type {PluginManifest} from '../plugin-release.js';

export interface PluginCommand {readonly operationId:string;readonly expectedRevision:number}
/** An acknowledgement of a committed control intent, not proof of a remote effect. */
export interface PluginCommandReceipt {readonly operationId:string;readonly kind:string;readonly revision:number}
export interface BuildSelection {readonly packageId:string;readonly version:string;readonly configurationRevision:number}
export type BuildObserved='queued'|'starting'|'active'|'stopped'|'blocked'|'restart_required'|'draining';
/** One durable build/instance record. Native builds select a trusted host
 * contribution; worker packages retain their release artifact and configured
 * instance in the same record instead of separate package/instance tables. */
export interface BuildInstance {
  readonly id:string;readonly packageId:string;readonly installationId:string;
  revision:number;desired:BuildSelection|null;retired:boolean;
  observed:BuildObserved;
  blockers:string[];operationId:string;
  /** Worker activation retained for draining despite desired becoming null. */
  activeSelection?:BuildSelection|null;
  readonly kind?:'native'|'package'|'instance';
  readonly version?:string;
  readonly package?:BuildPackageRecord;
  readonly instance?:BuildInstanceRecord;
}
export interface BuildPackageRecord {
  installationId:string;view:PluginPackageView;manifest:PluginManifest;directory?:string;previewId:string;
}
export interface BuildInstanceRecord {view:PluginInstanceView;configurationId?:string;stepId?:string}

/** Intent and read capabilities supplied by the Vault owner. No database, Store
 * or namespace chooser is part of the control consumer's value. */
export interface PluginControlStore {
  revision():number;
  bump():void;
  command(kind:string,input:PluginCommand,revision:()=>number,apply:()=>void):boolean;
  receipt(operationId:string):PluginCommandReceipt|undefined;
  build(id:string):BuildInstance|undefined;
  builds():BuildInstance[];
  saveBuild(value:BuildInstance):void;
}
