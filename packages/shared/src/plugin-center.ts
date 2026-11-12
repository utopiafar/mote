import {z} from 'zod';

/** Owner control-plane views. Captured content and query tools never authorize
 * these commands. Runtime health is separate from installation and intent. */
export type PluginAction='configure'|'check'|'enable'|'disable'|'uninstall';
/** The existing instance command surface; configure is a dialog and uninstall
 * belongs to the package. A command declaration is not an execution grant. */
export const pluginInstanceActionSchema=z.enum(['check','enable','disable']);
export type PluginInstanceAction=z.infer<typeof pluginInstanceActionSchema>;
export const pluginInstanceCommandSchema=z.object({id:pluginInstanceActionSchema,apiVersion:z.literal('1')}).strict();
export type CapabilityState='verified'|'unsupported'|'unknown';
export type PluginCapability={id:string;state:CapabilityState;reason?:string};
export type PluginSource={repository:string;tag:string;commit:string;digest:string};
export type PluginConfigurationField={id:string;label:string;type:'text'|'number'|'boolean'|'select'|'model-profile'|'secret-reference';required?:boolean;options?:{value:string;label:string}[];description?:string};
export type PluginCatalogGroup='connectors'|'memory'|'outbound-processing';
/** Mainline-signed fixed artifacts shown in the official catalog. GitHub free-form
 * install stays off this surface. */
export type PluginCatalogEntry={repository:string;tag?:string;name:string;description:string;group:PluginCatalogGroup;runtime:'worker'|'service';packageId?:string};
/** Declarative "添加来源" card projected from an installed connector package.
 * Install/config state is separate from OAuth/account connection. */
export type PluginSourceContribution={
  packageId:string;packageName:string;contributionId:string;title:string;body:string;note:string;icon:string;
  kinds:string[];target:{pageId:string;href:string};setupChoiceId?:string;
  /** Existing account binding key a new source kind may attach to. */
  attachToBinding?:string;
  state:'installed'|'configured'|'ready'|'enabled'|'needs_attention';
  instanceId?:string;
};
export type PluginPackageView={id:string;name:string;version:string;source:PluginSource;runtime:'worker'|'service';state:'installed'|'installing'|'failed'|'restart-required';desired:boolean;observed:string;issues:string[];instanceIds:string[];allowedActions:PluginAction[];operationId?:string;configurationSchema?:PluginConfigurationField[]};
export type PluginInstanceView={id:string;packageId:string;name:string;revision:number;scope:string;configurationSchema:PluginConfigurationField[];configuration:Record<string,string|number|boolean>;secretStatus:Record<string,boolean>;capabilities:PluginCapability[];desired:boolean;observed:string;issues:string[];allowedActions:PluginAction[]};
export type PluginReleasePreview={id:string;name:string;version:string;source:PluginSource;runtime:'worker'|'service';restartRequired:boolean;capabilities:PluginCapability[];dependencies:string[];access:string[];issues:string[];installable:boolean};
export type PluginCenterView={revision:number;installation:{supported:boolean;reason?:string;runtime:'worker'|'service';restartRequired:boolean};packages:PluginPackageView[];instances:PluginInstanceView[];builds?:PluginBuildView[];catalog:PluginCatalogEntry[];sourceContributions?:PluginSourceContribution[]};
export type PluginBuildSelection={packageId:string;version:string;configurationRevision:number};
export type PluginBuildObserved='queued'|'starting'|'active'|'stopped'|'blocked'|'restart_required'|'draining';
/** One build projection shared by trusted native builds and downloaded worker
 * packages. desired is the selected next-start activation; active is the
 * activation currently serving. A failed candidate never replaces active, and
 * blockers explain why it did not become observed. Worker-only package facts
 * use the same field names as the configured instance projection. */
export type PluginBuildView={id:string;packageId:string;installationId:string;revision:number;desired:PluginBuildSelection|null;retired:boolean;observed:PluginBuildObserved;blockers:string[];operationId:string;active?:(PluginBuildSelection&{identity?:unknown})|null;restartRequired:boolean;name?:string;version?:string;runtime?:'host'|'worker'|'service';source?:PluginSource|null;configuration?:Record<string,string|number|boolean>;configurationSchema?:PluginConfigurationField[];capabilities?:PluginCapability[];issues?:string[];allowedActions?:PluginAction[];package?:boolean};
export type MemoryControlAction='pause'|'resume'|'stop'|'prepare'|'activate'|'retry'|'cancel';
export type MemoryModuleBinding={stage:'extract'|'review'|'integrate'|'repository'|'retrieval';id:string;name:string;instanceId?:string;state:CapabilityState;reason?:string};
export type MemoryPlanView={id:string;name:string;mode:'modules'|'engine';instanceId?:string;modules:MemoryModuleBinding[];capabilities:PluginCapability[];available:boolean;reason?:string;allowedActions:MemoryControlAction[]};
export type MemoryPreparationView={operationId:string;state:'waiting'|'running'|'blocked'|'failed'|'verified'|'applied'|'cancelled';phase:string;kind:'content-migration'|'index-only';targetPlanId:string;scope:string;checks:{id:string;state:CapabilityState;reason?:string}[];oldAdmissionFrozen:boolean;tail:number;usageUnknown:boolean;error?:string;allowedActions:MemoryControlAction[]};
export type MemoryBindingView={revision:number;generation:number;mode:'modules'|'engine';modules:MemoryModuleBinding[];activePlan:MemoryPlanView;plans:MemoryPlanView[];admission:{desired:boolean;state:'enabled'|'draining'|'paused'|'stopping'|'blocked';generation:number;queued:number;running:number;checkpointed:number;resultUnknown:number;cutoff?:number;blockedReason?:string};preparation?:MemoryPreparationView;allowedActions:MemoryControlAction[]};
export type PluginCommand={expectedRevision:number;operationId:string};
