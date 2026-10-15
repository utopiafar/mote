import {ScopeError,validScopeId} from './baseline.js';

declare const userContextBrand:unique symbol;
/** Never deserialize this type from a request or a persisted job. */
export interface UserContext {
  readonly [userContextBrand]:true;
  readonly deploymentId:string;
  readonly userId:string;
  readonly credentialId:string;
  readonly authorizationEpoch:number;
}
/** Returned only by the host's credential verifier (M01), never by a route body. */
export interface VerifiedIdentity {
  readonly deploymentId:string;
  readonly userId:string;
  readonly credentialId:string;
  readonly authorizationEpoch:number;
  readonly administrator:boolean;
}
export interface IdentityVerifier {
  verify(credential:string):Promise<VerifiedIdentity|undefined>;
  /** Must consult current account/credential state, including at publication. */
  isCurrent(identity:Readonly<VerifiedIdentity>):boolean;
}
/** Host-only durable grant lookup. Implementations load an admitted task's
 * persisted identity and account epoch; an ordinary request never supplies one.
 * Session logout does not revoke this grant, but account/reset/delete fences do. */
export interface DurableIdentityVerifier {
  verify(grantId:string):Promise<VerifiedIdentity|undefined>;
  isCurrent(identity:Readonly<VerifiedIdentity>):boolean;
}
type IssuedIdentity={identity:Readonly<VerifiedIdentity>;mode:'session'|'task'};

export class UserContextAuthority {
  private readonly issued=new WeakMap<object,IssuedIdentity>();
  constructor(readonly deploymentId:string,private readonly verifier:IdentityVerifier,private readonly taskVerifier?:DurableIdentityVerifier){
    if(!validScopeId(deploymentId))throw new ScopeError('invalid_identity',401);
  }
  async authenticate(credential:unknown):Promise<UserContext>{
    if(typeof credential!=='string'||!credential)throw new ScopeError('identity_required',401);
    const identity=await this.verifier.verify(credential);
    return this.issue(identity,'session');
  }
  /** Restore only a host-verified durable task grant, never a serialized context.
   * Task identities can use their own private services but cannot administer the
   * instance, even if the account that admitted them is an administrator. */
  async restoreTask(grantId:unknown):Promise<UserContext>{
    if(typeof grantId!=='string'||!validScopeId(grantId)||!this.taskVerifier)throw new ScopeError('invalid_identity',401);
    const identity=await this.taskVerifier.verify(grantId);
    return this.issue(identity,'task');
  }
  private issue(identity:VerifiedIdentity|undefined,mode:IssuedIdentity['mode']):UserContext{
    if(!identity||identity.deploymentId!==this.deploymentId||![identity.userId,identity.credentialId].every(validScopeId)||typeof identity.administrator!=='boolean'||!Number.isSafeInteger(identity.authorizationEpoch)||identity.authorizationEpoch<0)throw new ScopeError('invalid_identity',401);
    const saved=Object.freeze({...identity,...(mode==='task'?{administrator:false}:{})});
    const context=Object.freeze({deploymentId:saved.deploymentId,userId:saved.userId,credentialId:saved.credentialId,authorizationEpoch:saved.authorizationEpoch}) as UserContext;
    this.issued.set(context,{identity:saved,mode});this.assert(context);return context;
  }
  assert(context:unknown):asserts context is UserContext {
    const issued=context&&typeof context==='object'?this.issued.get(context):undefined;
    if(!issued||!(issued.mode==='task'?this.taskVerifier?.isCurrent(issued.identity):this.verifier.isCurrent(issued.identity)))throw new ScopeError('invalid_identity',401);
  }
  assertAdministrator(context:unknown){this.assert(context);if(!this.issued.get(context)!.identity.administrator)throw new ScopeError('invalid_identity',403);}
  isTask(context:UserContext){this.assert(context);return this.issued.get(context)!.mode==='task';}
}
