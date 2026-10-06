import type {DelegationCapability,DelegationProduct,DelegationScope,DelegationUnit} from './delegation-runtime.js';

/** Protocol adapter boundary, deliberately separate from internal execution
 * records. No remote Agent is enabled by registration or model-supplied URLs.
 * A future A2A adapter maps its task/events/artifacts here after host approval;
 * it must preserve the same disclosure checks, cancellation and idempotency. */
export type DelegationAdapterTask={id:string;state:'submitted'|'working'|'input-required'|'completed'|'failed'|'cancelled';artifact?:DelegationProduct;errorCode?:string};
export interface DelegationAdapter {
 readonly kind:'local'|'a2a';
 readonly version:string;
 /** The host pins a trusted descriptor, never a card retrieved from evidence. */
 discover(signal:AbortSignal):Promise<readonly Pick<DelegationCapability,'id'|'version'|'description'|'inputSchema'>[]>;
 submit(unit:Readonly<DelegationUnit>,context:{idempotencyKey:string;scope:Readonly<DelegationScope>;signal:AbortSignal}):Promise<DelegationAdapterTask>;
 read(taskId:string,context:{scope:Readonly<DelegationScope>;signal:AbortSignal}):Promise<DelegationAdapterTask>;
 cancel(taskId:string,signal:AbortSignal):Promise<void>;
}

export const DELEGATION_PROTOCOL_VERSION=1;
export const DELEGATION_TRANSPORT_POLICY=Object.freeze({default:'local',remoteEnabled:false,maxDepth:1,artifactIsOriginalEvidence:false});
