/** Owner control-plane views. Captured content and query tools never authorize
 * these commands. Runtime health is separate from installation and intent. */
export type PluginAction='configure'|'check'|'enable'|'disable'|'uninstall';
export type CapabilityState='verified'|'unsupported'|'unknown';
export type PluginCapability={id:string;state:CapabilityState;reason?:string};
export type PluginSource={repository:string;tag:string;commit:string;digest:string};
export type PluginConfigurationField={id:string;label:string;type:'text'|'number'|'boolean'|'select'|'model-profile'|'secret-reference';required?:boolean;options?:{value:string;label:string}[];description?:string};
export type PluginPackageView={id:string;name:string;version:string;source:PluginSource;runtime:'worker'|'service';state:'installed'|'installing'|'failed'|'restart-required';desired:boolean;observed:string;issues:string[];instanceIds:string[];allowedActions:PluginAction[];operationId?:string;configurationSchema?:PluginConfigurationField[]};
export type PluginInstanceView={id:string;packageId:string;name:string;revision:number;scope:string;configurationSchema:PluginConfigurationField[];configuration:Record<string,string|number|boolean>;secretStatus:Record<string,boolean>;capabilities:PluginCapability[];desired:boolean;observed:string;issues:string[];allowedActions:PluginAction[]};
export type PluginReleasePreview={id:string;name:string;version:string;source:PluginSource;runtime:'worker'|'service';restartRequired:boolean;capabilities:PluginCapability[];dependencies:string[];access:string[];issues:string[];installable:boolean};
export type PluginCenterView={revision:number;installation:{supported:boolean;reason?:string;runtime:'worker'|'service';restartRequired:boolean};packages:PluginPackageView[];instances:PluginInstanceView[];catalog:{repository:string;name:string;description:string}[]};
export type MemoryControlAction='pause'|'resume'|'stop'|'prepare'|'activate'|'retry'|'cancel';
export type MemoryModuleBinding={stage:'extract'|'review'|'integrate'|'repository'|'retrieval';id:string;name:string;instanceId?:string;state:CapabilityState;reason?:string};
export type MemoryPlanView={id:string;name:string;mode:'modules'|'engine';instanceId?:string;modules:MemoryModuleBinding[];capabilities:PluginCapability[];available:boolean;reason?:string;allowedActions:MemoryControlAction[]};
export type MemoryPreparationView={operationId:string;state:'waiting'|'running'|'blocked'|'failed'|'verified'|'applied'|'cancelled';phase:string;kind:'content-migration'|'index-only';targetPlanId:string;scope:string;checks:{id:string;state:CapabilityState;reason?:string}[];oldAdmissionFrozen:boolean;tail:number;usageUnknown:boolean;error?:string;allowedActions:MemoryControlAction[]};
export type MemoryBindingView={revision:number;generation:number;mode:'modules'|'engine';modules:MemoryModuleBinding[];activePlan:MemoryPlanView;plans:MemoryPlanView[];admission:{desired:boolean;state:'enabled'|'draining'|'paused'|'stopping'|'blocked';generation:number;queued:number;running:number;checkpointed:number;resultUnknown:number;cutoff?:number;blockedReason?:string};preparation?:MemoryPreparationView;allowedActions:MemoryControlAction[]};
export type PluginCommand={expectedRevision:number;operationId:string};
